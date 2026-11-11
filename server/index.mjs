import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { toolsForKind } from './agent-tools.mjs';
import { Auth, sessionCookie, sessionTokenFrom } from './auth.mjs';
import { openDb } from './db.mjs';
import { runDoctor } from './doctor.mjs';
import { detectEngines } from './engines/index.mjs';
import { ensureDirs } from './config.mjs';
import { inspect as inspectIntegration, integrate as integrateIntoProject } from './integrate.mjs';
import { inspectEpicFailure, recoverEpic } from './epic-recovery.mjs';
import { inspectFailure, recoverTask } from './recovery.mjs';
import { loginPage } from './login-page.mjs';
import { loadProject } from './project.mjs';
import { PushService } from './push.mjs';
import { reportToMarkdown, weeklyReport } from './report.mjs';
import { Runner, UserError } from './runner.mjs';
import { Scheduler, validateSchedule } from './scheduler.mjs';
import { loadTeams, summarizeTeams } from './teams.mjs';
import { loadTemplates, renderTemplate, templateSummary } from './templates.mjs';

const MAX_BODY = 100 * 1024;

// Tiêu đề do proxy thêm vào. Trình duyệt trên chính máy này không bao giờ gửi chúng, nên cổng chính (tin cậy, không PIN)
// từ chối mọi yêu cầu có chúng: phòng khi ai đó trỏ nhầm Tailscale vào cổng chính và giả Host là localhost.
const PROXY_HEADERS = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'via',
  'cf-connecting-ip', 'true-client-ip', 'tailscale-user-login', 'tailscale-user-name', 'tailscale-headers-info',
];

// Tệp tĩnh cần cho cài ứng dụng (PWA): trình duyệt tải chúng không kèm cookie nên phải công khai. Khớp tuyệt đối từng đường dẫn.
const PUBLIC_FILES = new Set(['/manifest.webmanifest', '/sw.js', '/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png']);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function setBaseHeaders(res) {
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new UserError('Nội dung gửi lên quá lớn.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new UserError('Nội dung gửi lên không phải JSON hợp lệ.'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Khởi động máy chủ điều phối. `withUi=false` bỏ qua phần Next.js (dùng khi kiểm thử).
 * Máy chủ chỉ nghe ở 127.0.0.1 và từ chối yêu cầu có Host/Origin lạ để chặn trang web
 * bên ngoài lén giao việc cho agent (CSRF, DNS rebinding).
 */
export async function startServer({ cfg, dev = false, withUi = true, uiHandler = null, log = console.log }) {
  ensureDirs(cfg);
  const store = openDb(path.join(cfg.dataDir, 'company.db'));

  const config = { teams: [], project: null, error: null };
  const reload = () => {
    try {
      config.teams = loadTeams({ teamsDir: cfg.teamsDir, localTeamsDir: path.join(cfg.localDir, 'teams') });
      config.project = loadProject(cfg.localDir);
      config.error = null;
    } catch (err) {
      config.error = err.message;
    }
  };
  reload();

  const runner = new Runner({ cfg, store, getTeams: () => config.teams, getProject: () => config.project });
  const templates = () => loadTemplates({ dir: cfg.templatesDir, localDir: path.join(cfg.localDir, 'templates') });
  const scheduler = new Scheduler({
    store, runner, reload, log,
    getTemplates: () => templates().templates,
    now: cfg.clock ?? Date.now,
  });

  // `uiHandler` chỉ dùng khi kiểm thử: thay cho Next.js để thử đường đi của cổng từ xa mà không cần build.
  let nextHandler = uiHandler;
  let nextUpgrade = null;
  if (withUi) {
    const { default: next } = await import('next');
    const app = next({ dev, dir: cfg.toolDir, hostname: cfg.host, port: cfg.port });
    await app.prepare();
    nextHandler = app.getRequestHandler();
    if (dev && typeof app.getUpgradeHandler === 'function') nextUpgrade = app.getUpgradeHandler();
  }

  let actualPort = cfg.port;
  const allowedHosts = () => new Set([`localhost:${actualPort}`, `127.0.0.1:${actualPort}`, `[::1]:${actualPort}`]);
  const allowedOrigins = () => new Set([...allowedHosts()].map((h) => `http://${h}`));

  // Cổng từ xa (chỉ khi đặt publicHost): luôn đòi PIN. Host/Origin phải đúng tên máy công khai, qua HTTPS của Tailscale.
  const auth = new Auth({ dataDir: cfg.dataDir, store, clock: cfg.clock ?? Date.now });
  const remoteOn = Boolean(cfg.publicHost);
  const remoteHosts = new Set([cfg.publicHost, `${cfg.publicHost}:443`]);
  const remoteOrigin = `https://${cfg.publicHost}`;

  // Thông báo đẩy tới điện thoại/trình duyệt đã đăng ký. `cfg.pushSend` chỉ dùng khi kiểm thử (thay cho gửi thật).
  const pushService = new PushService({
    store, auth, runner, dataDir: cfg.dataDir, log,
    subject: cfg.publicHost ? `https://${cfg.publicHost}` : 'https://localhost',
    extraHosts: cfg.pushHosts ?? [],
    send: cfg.pushSend,
    requestOptions: cfg.pushRequestOptions,
    clock: cfg.clock ?? Date.now,
  });
  pushService.start();

  const sseClients = new Set();
  const push = (type, data) => {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) client.write(frame);
  };
  runner.on('event', (event) => push('event', event));
  runner.on('task', (task) => push('task', task));
  runner.on('state', (state) => push('state', state));
  runner.on('job', (job) => push('job', job));
  runner.on('epic', (epic) => push('epic', epic));

  /** Kiểm tra nguồn và kiểu nội dung của yêu cầu ghi. Trả về true nếu đã trả lời lỗi. */
  function rejectBadWrite(req, res, remote) {
    const origin = req.headers.origin;
    // Cổng từ xa bắt buộc có Origin đúng (trình duyệt luôn gửi Origin khi POST); cổng chính chỉ chặn Origin lạ.
    if (remote ? origin !== remoteOrigin : origin && !allowedOrigins().has(origin)) {
      sendJson(res, 403, { error: 'Nguồn gửi yêu cầu không hợp lệ.' });
      return true;
    }
    if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      sendJson(res, 415, { error: 'Cần Content-Type: application/json.' });
      return true;
    }
    return false;
  }

  async function handleLogin(req, res) {
    if (rejectBadWrite(req, res, true)) return undefined;
    const body = await readJson(req);
    const result = auth.login(body.pin, { agent: req.headers['user-agent'] });
    if (result.ok) {
      res.setHeader('set-cookie', sessionCookie(result.token));
      return sendJson(res, 200, { ok: true, expiresAt: result.expiresAt });
    }
    if (result.reason === 'no_pin') return sendJson(res, 503, { error: 'Máy chủ chưa đặt PIN nên chưa cho vào từ xa. Chạy "npm run pin -- set" trên máy tính.' });
    if (result.reason === 'locked') {
      res.setHeader('retry-after', String(Math.ceil(result.retryAfterMs / 1000)));
      return sendJson(res, 429, { error: `Nhập sai quá nhiều lần. Thử lại sau ${Math.ceil(result.retryAfterMs / 60_000)} phút.`, retryAfterMs: result.retryAfterMs });
    }
    return sendJson(res, 401, { error: 'PIN không đúng.', remaining: result.remaining });
  }

  let enginesCache = null;
  async function handleApi(req, res, url, ctx = { remote: false }) {
    const { pathname } = url;
    const method = req.method ?? 'GET';

    if (method !== 'GET' && method !== 'HEAD' && rejectBadWrite(req, res, ctx.remote)) return undefined;

    if (method === 'GET' && pathname === '/api/me') {
      return sendJson(res, 200, { remote: ctx.remote, expiresAt: ctx.session?.expiresAt ?? null });
    }
    if (method === 'POST' && pathname === '/api/logout') {
      if (!ctx.remote) return sendJson(res, 200, { ok: true });
      pushService.dropSession(ctx.session.hash);
      auth.logout(ctx.token);
      res.setHeader('set-cookie', sessionCookie('', { clear: true }));
      return sendJson(res, 200, { ok: true });
    }

    // ---- Thông báo đẩy (cổng từ xa: chỉ phiên đã đăng nhập mới tới được đây) ----
    if (pathname === '/api/push/key' && method === 'GET') {
      return sendJson(res, 200, { publicKey: pushService.publicKey, count: store.countPushSubscriptions() });
    }
    if (pathname === '/api/push/subscribe' && method === 'POST') {
      const body = await readJson(req);
      const info = pushService.subscribe(body.subscription, { sessionHash: ctx.session?.hash ?? null, agent: req.headers['user-agent'] });
      return sendJson(res, 200, { ok: true, ...info });
    }
    if (pathname === '/api/push/unsubscribe' && method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 200, { ok: true, removed: pushService.unsubscribe(body.endpoint) });
    }
    if (pathname === '/api/push/test' && method === 'POST') {
      return sendJson(res, 200, { ok: true, ...(await pushService.sendTest()) });
    }

    // Công cụ MCP của Trưởng nhóm: cầu nối (mcp-bridge.mjs) gọi vào đây kèm mã thông báo riêng của lượt chạy.
    // Chỉ cổng chính (loopback) được gọi; từ xa không bao giờ chạm tới, kể cả khi đã đăng nhập.
    if (pathname.startsWith('/api/agent/')) {
      if (ctx.remote) return sendJson(res, 404, { error: 'Không có đường dẫn này.' });
      const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const taskId = runner.agentRuns.get(token);
      const agentTask = taskId ? store.getTask(taskId) : null;
      if (!agentTask) return sendJson(res, 401, { error: 'Mã thông báo không hợp lệ hoặc lượt làm việc đã kết thúc.' });
      if (method === 'GET' && pathname === '/api/agent/tools') return sendJson(res, 200, { tools: toolsForKind(agentTask.kind) });
      if (method === 'POST' && pathname === '/api/agent/call') {
        const body = await readJson(req);
        const reply = await runner.callAgentTool(token, String(body.name ?? ''), body.arguments ?? {});
        return sendJson(res, 200, reply ?? { isError: true, text: 'Lượt làm việc đã kết thúc.' });
      }
      return sendJson(res, 404, { error: 'Không có đường dẫn này.' });
    }

    if (method === 'GET' && pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      res.write(`event: state\ndata: ${JSON.stringify(runner.snapshot())}\n\n`);
      const beat = setInterval(() => {
        // Phiên từ xa hết hạn, bị đăng xuất hoặc PIN đã đổi thì ngắt luồng, không để luồng cũ sống mãi.
        if (ctx.remote && !auth.validate(ctx.token)) {
          clearInterval(beat);
          res.end();
          return;
        }
        res.write(': ping\n\n');
      }, cfg.sseBeatMs ?? 15_000);
      req.on('close', () => {
        clearInterval(beat);
        sseClients.delete(res);
      });
      return undefined;
    }

    if (method === 'GET' && pathname === '/api/state') {
      reload();
      return sendJson(res, 200, {
        project: {
          name: config.project?.name || cfg.projectName,
          root: cfg.projectRoot,
          hasProfile: Boolean(config.project),
          stack: config.project?.stack ?? [],
        },
        teams: summarizeTeams(config.teams),
        company: runner.snapshot(),
        configError: config.error,
      });
    }

    // Các engine AI (Claude, Antigravity...): đã cài/đăng nhập chưa, model thật, đang bị chặn tới khi nào. Kết quả giữ 30 giây vì agy gọi mạng.
    if (method === 'GET' && pathname === '/api/engines') {
      const fresh = url.searchParams.get('refresh') === '1';
      if (fresh || !enginesCache || Date.now() - enginesCache.at > 30_000) {
        enginesCache = { at: Date.now(), engines: await detectEngines(cfg, { blocked: runner.engineBlocked }) };
      }
      const blocked = runner.engineBlocked;
      const engines = enginesCache.engines.map((e) => ({ ...e, blockedUntil: (blocked[e.id] ?? 0) > Date.now() ? blocked[e.id] : 0 }));
      return sendJson(res, 200, { engines, order: cfg.engines ?? [cfg.engine] });
    }

    // Liên kết AI: chủ chọn engine nào dùng và thứ tự ưu tiên. Chỉ cho liên kết engine đã cài (và không báo "chưa đăng nhập").
    if (method === 'POST' && pathname === '/api/engines') {
      const body = await readJson(req);
      const order = Array.isArray(body.order) ? body.order.map(String) : [];
      const info = await detectEngines(cfg, { blocked: runner.engineBlocked });
      for (const id of order) {
        const found = info.find((e) => e.id === id);
        if (!found) throw new UserError(`Engine "${id}" không tồn tại.`);
        if (!found.installed) throw new UserError(`${found.label} chưa cài hoặc không chạy được lệnh. ${found.detail}`.trim());
        if (found.loggedIn === false) throw new UserError(`${found.label} chưa đăng nhập. ${found.detail}`.trim());
      }
      runner.setEngines(order);
      // Trả luôn danh sách mới (đã có kết quả dò máy ở trên) để giao diện không phải dò lại một lần nữa.
      const linked = cfg.engines;
      const engines = info.map((e) => ({ ...e, linked: linked.includes(e.id), order: linked.indexOf(e.id) }));
      enginesCache = { at: Date.now(), engines };
      return sendJson(res, 200, { order: linked, engines });
    }

    if (method === 'GET' && pathname === '/api/doctor') return sendJson(res, 200, { checks: await runDoctor(cfg) });

    if (method === 'GET' && pathname === '/api/tasks') {
      const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 500);
      return sendJson(res, 200, { tasks: store.listTasks(limit) });
    }

    if (method === 'POST' && pathname === '/api/tasks') {
      reload();
      const body = await readJson(req);
      const task = await runner.submit({
        title: body.title, prompt: body.prompt, acceptance: body.acceptance, member: body.member, level: body.level,
      });
      return sendJson(res, 201, { task });
    }

    const taskMatch = pathname.match(/^\/api\/tasks\/(\d+)(?:\/(stop|recovery|recover))?$/);
    if (taskMatch) {
      const id = Number(taskMatch[1]);
      if (method === 'GET' && !taskMatch[2]) {
        const task = store.getTask(id);
        if (!task) return sendJson(res, 404, { error: 'Không có việc này.' });
        return sendJson(res, 200, { task, events: store.listEvents(id) });
      }
      if (method === 'GET' && taskMatch[2] === 'recovery') {
        return sendJson(res, 200, await inspectFailure({ store, projectRoot: cfg.projectRoot, id }));
      }
      if (method === 'POST' && taskMatch[2] === 'recover') {
        const body = await readJson(req);
        const task = await recoverTask(runner, id, { action: body.action, guidance: body.guidance });
        return sendJson(res, 200, { task });
      }
      if (method === 'POST' && taskMatch[2] === 'stop') {
        if (!store.getTask(id)) return sendJson(res, 404, { error: 'Không có việc này.' });
        return sendJson(res, 200, { ok: runner.stop(id) });
      }
    }

    // ---- Câu hỏi nhân viên gửi cho chủ công ty (ask_owner): xem và trả lời ----
    const questionMatch = pathname.match(/^\/api\/questions\/(\d+)(?:\/(answer))?$/);
    if (questionMatch) {
      const id = Number(questionMatch[1]);
      const q = store.getQuestion(id);
      if (!q || q.kind !== 'owner') return sendJson(res, 404, { error: 'Không có câu hỏi này.' });
      if (method === 'GET' && !questionMatch[2]) {
        const task = store.getTask(q.task_id);
        return sendJson(res, 200, {
          question: { id: q.id, task_id: q.task_id, asker: q.asker, text: q.text, status: q.status, answer: q.answer, options: q.options ? JSON.parse(q.options) : [] },
          task: task ? { id: task.id, title: task.title, member: task.member, status: task.status } : null,
        });
      }
      if (method === 'POST' && questionMatch[2] === 'answer') {
        const body = await readJson(req);
        const updated = runner.questions.answerOwner(id, { answer: body.answer, decline: body.decline === true });
        return sendJson(res, 200, { question: { id: updated.id, status: updated.status } });
      }
    }

    // ---- Đưa kết quả (nhánh company/...) vào dự án: xem trước rồi gộp, chỉ khi người dùng bấm ----
    const integrateMatch = pathname.match(/^\/api\/integrate\/(task|job|epic)\/(\d+)$/);
    if (integrateMatch) {
      const kind = integrateMatch[1];
      const id = Number(integrateMatch[2]);
      if (method === 'GET') {
        return sendJson(res, 200, await inspectIntegration({ store, projectRoot: cfg.projectRoot, kind, id }));
      }
      if (method === 'POST') {
        const result = await integrateIntoProject({ store, projectRoot: cfg.projectRoot, kind, id });
        if (!result.ok) return sendJson(res, 409, { error: result.error, state: result.state });
        push('integrated', { kind, id });
        return sendJson(res, 200, result);
      }
    }

    // ---- Yêu cầu giao cho cả công ty (Giám đốc → các team) ----
    if (method === 'GET' && pathname === '/api/epics') return sendJson(res, 200, { epics: store.listEpics() });

    if (method === 'POST' && pathname === '/api/epics') {
      reload();
      const body = await readJson(req);
      const epic = await runner.epics.create({ title: body.title, prompt: body.prompt, acceptance: body.acceptance });
      return sendJson(res, 201, { epic });
    }

    const epicMatch = pathname.match(/^\/api\/epics\/(\d+)(?:\/(approve-plan|reject-plan|approve-result|reject-result|stop|recovery|recover))?$/);
    if (epicMatch) {
      const id = Number(epicMatch[1]);
      const action = epicMatch[2];
      if (!store.getEpic(id)) return sendJson(res, 404, { error: 'Không có yêu cầu này.' });
      if (method === 'GET' && !action) {
        return sendJson(res, 200, { epic: store.getEpic(id), jobs: store.epicJobs(id), tasks: store.epicTasks(id) });
      }
      if (method === 'GET' && action === 'recovery') {
        return sendJson(res, 200, await inspectEpicFailure({ store, projectRoot: cfg.projectRoot, id }));
      }
      if (method === 'POST' && action === 'recover') {
        const body = await readJson(req);
        const epic = await recoverEpic(runner, id, { action: body.action, guidance: body.guidance });
        return sendJson(res, 200, { epic });
      }
      if (method === 'POST' && action) {
        const body = await readJson(req);
        if (action === 'approve-plan') await runner.epics.approvePlan(id);
        else if (action === 'reject-plan') runner.epics.rejectPlan(id, body.feedback);
        else if (action === 'approve-result') runner.epics.approveResult(id);
        else if (action === 'reject-result') runner.epics.rejectResult(id, body.feedback);
        else await runner.epics.stop(id, 'Yêu cầu bị dừng theo yêu cầu.');
        return sendJson(res, 200, { epic: store.getEpic(id) });
      }
    }

    // Bảng tải của từng team và nhật ký hội thoại giữa các tầng (Giám đốc, Trưởng nhóm, nhân viên).
    if (method === 'GET' && pathname === '/api/workload') {
      reload();
      const teams = config.teams.map((team) => ({
        id: team.id, name: team.name, lead: team.lead, workers: runner.jobs.workload(team),
      }));
      return sendJson(res, 200, { teams });
    }
    if (method === 'GET' && pathname === '/api/feed') {
      const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '80', 10) || 80, 300);
      return sendJson(res, 200, { events: store.recentFeed(['job', 'review', 'triage', 'escalate', 'quota', 'question', 'answer'], limit) });
    }

    if (method === 'GET' && pathname === '/api/jobs') return sendJson(res, 200, { jobs: store.listJobs() });

    if (method === 'POST' && pathname === '/api/jobs') {
      reload();
      const body = await readJson(req);
      const job = await runner.jobs.create({ team: body.team, title: body.title, prompt: body.prompt, acceptance: body.acceptance, contest: body.contest });
      return sendJson(res, 201, { job });
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/(\d+)(?:\/(stop|replan|contest|contest\/choose))?$/);
    if (jobMatch) {
      const id = Number(jobMatch[1]);
      const job = store.getJob(id);
      if (!job) return sendJson(res, 404, { error: 'Không có việc lớn này.' });
      if (method === 'GET' && !jobMatch[2]) return sendJson(res, 200, { job, tasks: store.jobTasks(id) });
      if (method === 'GET' && jobMatch[2] === 'contest') {
        const contest = runner.jobs.contests.view(id);
        return contest ? sendJson(res, 200, { contest }) : sendJson(res, 404, { error: 'Việc lớn này không phải thi đấu skill.' });
      }
      if (method === 'POST' && jobMatch[2] === 'contest/choose') {
        const body = await readJson(req);
        await runner.jobs.contests.choose(id, body.option);
        return sendJson(res, 200, { contest: runner.jobs.contests.view(id) });
      }
      if (method === 'POST' && jobMatch[2] === 'replan') {
        const body = await readJson(req);
        return sendJson(res, 200, { job: runner.jobs.replan(id, { guidance: body.guidance }) });
      }
      if (method === 'POST' && jobMatch[2] === 'stop') {
        await runner.jobs.stop(id, 'Việc lớn bị dừng theo yêu cầu.');
        return sendJson(res, 200, { job: store.getJob(id) });
      }
    }

    // ---- Báo cáo tuần ----
    if (method === 'GET' && pathname === '/api/report') {
      reload();
      const teamNames = Object.fromEntries(config.teams.map((t) => [t.id, t.name]));
      const report = weeklyReport(store, { week: url.searchParams.get('week') || undefined, now: (cfg.clock ?? Date.now)(), teamNames });
      if (url.searchParams.get('format') === 'md') {
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="bao-cao-${report.week}.md"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(reportToMarkdown(report));
        return undefined;
      }
      return sendJson(res, 200, { report });
    }

    // ---- Mẫu việc và việc định kỳ ----
    if (method === 'GET' && pathname === '/api/templates') {
      const { templates: list, errors } = templates();
      return sendJson(res, 200, { templates: list.map(templateSummary), errors });
    }
    const templateMatch = pathname.match(/^\/api\/templates\/([a-z0-9_-]+)\/(render|run)$/);
    if (templateMatch && method === 'POST') {
      const template = templates().templates.find((t) => t.id === templateMatch[1]);
      if (!template) return sendJson(res, 404, { error: 'Không có mẫu này.' });
      const body = await readJson(req);
      const filled = renderTemplate(template, body.values);
      if (templateMatch[2] === 'render') return sendJson(res, 200, { filled });
      reload();
      if (filled.kind === 'epic') {
        const epic = await runner.epics.create({ title: filled.title, prompt: filled.prompt, acceptance: filled.acceptance });
        return sendJson(res, 201, { kind: 'epic', epic });
      }
      const job = await runner.jobs.create({ team: filled.team, title: filled.title, prompt: filled.prompt, acceptance: filled.acceptance });
      return sendJson(res, 201, { kind: 'job', job });
    }

    if (method === 'GET' && pathname === '/api/schedules') {
      return sendJson(res, 200, { schedules: store.listSchedules().map((s) => scheduler.describe(s)) });
    }
    if (method === 'POST' && pathname === '/api/schedules') {
      const body = await readJson(req);
      const template = templates().templates.find((t) => t.id === body.template);
      if (!template) throw new UserError('Không có mẫu việc này.');
      const clean = validateSchedule(body, template);
      const schedule = store.createSchedule({ name: clean.name, template: template.id, params: clean.params, days: clean.days, atTime: clean.atTime, maxPerDay: clean.maxPerDay });
      return sendJson(res, 201, { schedule: scheduler.describe(schedule) });
    }
    const scheduleMatch = pathname.match(/^\/api\/schedules\/(\d+)\/(enable|disable|run-now|delete)$/);
    if (scheduleMatch && method === 'POST') {
      const id = Number(scheduleMatch[1]);
      if (!store.getSchedule(id)) return sendJson(res, 404, { error: 'Không có lịch này.' });
      const action = scheduleMatch[2];
      if (action === 'delete') {
        store.deleteSchedule(id);
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'run-now') {
        const ref = await scheduler.runNow(id);
        return sendJson(res, 200, { ref, schedule: scheduler.describe(store.getSchedule(id)) });
      }
      store.updateSchedule(id, { enabled: action === 'enable' ? 1 : 0, last_error: null });
      return sendJson(res, 200, { schedule: scheduler.describe(store.getSchedule(id)) });
    }

    if (method === 'POST' && pathname === '/api/stop-all') return sendJson(res, 200, { stopped: runner.stopAll() });

    if (method === 'POST' && pathname === '/api/pause') {
      const body = await readJson(req);
      runner.setManualPause(Boolean(body.paused));
      return sendJson(res, 200, { company: runner.snapshot() });
    }

    return sendJson(res, 404, { error: 'Không có đường dẫn này.' });
  }

  const fail = (res, err) => {
    if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
    log(`Lỗi xử lý yêu cầu: ${err.stack ?? err.message}`);
    if (!res.headersSent) return sendJson(res, 500, { error: 'Lỗi máy chủ.' });
    res.end();
    return undefined;
  };

  // Cổng chính: chỉ trình duyệt trên chính máy này (Host là localhost), không cần PIN.
  const server = http.createServer(async (req, res) => {
    try {
      setBaseHeaders(res);
      if (!allowedHosts().has(String(req.headers.host ?? ''))) return sendJson(res, 403, { error: 'Host không hợp lệ.' });
      if (PROXY_HEADERS.some((name) => name in req.headers)) {
        return sendJson(res, 403, { error: 'Yêu cầu đi qua proxy không được vào cổng này. Từ xa phải dùng cổng từ xa (có PIN).' });
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (nextHandler) return await nextHandler(req, res);
      return sendJson(res, 404, { error: 'Giao diện chưa được bật.' });
    } catch (err) {
      return fail(res, err);
    }
  });
  if (nextUpgrade) server.on('upgrade', (req, socket, head) => nextUpgrade(req, socket, head));

  // Cổng từ xa: mọi thứ (trừ tệp tĩnh của PWA và trang đăng nhập) đều cần phiên hợp lệ. Không có WebSocket.
  const remoteServer = remoteOn
    ? http.createServer(async (req, res) => {
        try {
          setBaseHeaders(res);
          if (!remoteHosts.has(String(req.headers.host ?? '').toLowerCase())) return sendJson(res, 403, { error: 'Host không hợp lệ.' });
          if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { error: 'Yêu cầu từ trang web khác bị từ chối.' });
          const method = req.method ?? 'GET';
          // Dựng URL từ tên máy cố định, không từ tiêu đề Host, rồi chỉ dùng phần đã chuẩn hóa này.
          const url = new URL(req.url ?? '/', remoteOrigin);
          const { pathname } = url;

          if (pathname === '/api/login') {
            if (method !== 'POST') return sendJson(res, 405, { error: 'Chỉ nhận POST.' });
            return await handleLogin(req, res);
          }

          const token = sessionTokenFrom(req.headers.cookie);
          const session = auth.validate(token);
          if (!session) {
            if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Chưa đăng nhập.', login: true });
            if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'Chưa đăng nhập.', login: true });
            if (PUBLIC_FILES.has(pathname) && nextHandler) {
              req.url = pathname; // đúng đường dẫn đã khớp, không để Next hiểu khác
              return await nextHandler(req, res);
            }
            const nonce = crypto.randomBytes(16).toString('base64');
            res.writeHead(401, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; manifest-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
            });
            res.end(method === 'HEAD' ? undefined : loginPage({ nonce, hasPin: auth.hasPin() }));
            return undefined;
          }

          if (pathname.startsWith('/api/')) return await handleApi(req, res, url, { remote: true, session, token });
          if (nextHandler) return await nextHandler(req, res);
          return sendJson(res, 404, { error: 'Giao diện chưa được bật.' });
        } catch (err) {
          return fail(res, err);
        }
      })
    : null;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, resolve);
  });
  actualPort = server.address().port;
  runner.apiUrl = `http://127.0.0.1:${actualPort}`;

  // Cổng từ xa lỗi (ví dụ trùng cổng) không làm sập cả công ty: cổng chính vẫn chạy, chỉ báo rõ là từ xa chưa bật.
  let remotePort = null;
  if (remoteServer) {
    try {
      await new Promise((resolve, reject) => {
        remoteServer.once('error', reject);
        remoteServer.listen(cfg.remotePort, '127.0.0.1', resolve);
      });
      remotePort = remoteServer.address().port;
      if (!auth.hasPin()) log('Chưa đặt PIN nên cổng từ xa từ chối mọi yêu cầu. Chạy "npm run pin -- set" để đặt.');
    } catch (err) {
      log(`Không mở được cổng từ xa ${cfg.remotePort}: ${err.message}. Truy cập từ xa chưa bật.`);
    }
  }
  runner.start();
  scheduler.start();

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    // Chờ các tiến trình con thoát và ghi xong trạng thái trước khi đóng cơ sở dữ liệu.
    scheduler.stop();
    await runner.shutdown();
    await pushService.stop();
    for (const client of sseClients) client.end();
    for (const srv of [server, remoteServer]) {
      if (!srv?.listening) continue;
      await new Promise((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections?.();
      });
    }
    store.close();
  }

  return { server, remoteServer, runner, store, scheduler, auth, pushService, port: actualPort, remotePort, url: `http://localhost:${actualPort}`, close, reload };
}
