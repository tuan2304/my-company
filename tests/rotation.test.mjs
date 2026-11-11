import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { ensureDirs, loadConfig } from '../server/config.mjs';
import { openDb } from '../server/db.mjs';
import { startServer } from '../server/index.mjs';
import { loadProject } from '../server/project.mjs';
import { Runner } from '../server/runner.mjs';
import { loadTeams } from '../server/teams.mjs';
import { makeProject, removeDir, REPO, testConfig, tmpDir, waitFor } from './helpers.mjs';

const FAKE_AGY = path.join(REPO, 'tests', 'fixtures', 'fake-agy.mjs');
const KEYS = ['FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_RESET_IN', 'FAKE_AGY_LOG', 'FAKE_AGY_SCENARIO'];
const job = { title: 'Tạo hello', prompt: 'Tạo file hello.txt', member: 'An', level: 'normal' };

async function setup({ engines = ['claude', 'agy'], overrides = {}, env = {} } = {}) {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg = testConfig(root, project, local, { engines, agyBin: process.execPath, agyArgsPrefix: [FAKE_AGY], ...overrides });
  ensureDirs(cfg);
  const claudeLog = path.join(root, 'claude.log');
  const agyLog = path.join(root, 'agy.log');
  Object.assign(process.env, { FAKE_CLAUDE_LOG: claudeLog, FAKE_AGY_LOG: agyLog, ...env });
  const store = openDb(path.join(cfg.dataDir, 'company.db'));
  const teams = loadTeams({ teamsDir: path.join(REPO, 'teams') });
  const runner = new Runner({ cfg, store, getTeams: () => teams, getProject: () => loadProject(local) });
  runner.start();
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return {
    root, project, cfg, store, runner,
    claude: () => read(claudeLog),
    agy: () => read(agyLog),
    cleanup: async () => {
      await runner.shutdown();
      store.close();
      for (const key of KEYS) delete process.env[key];
      removeDir(root);
    },
  };
}

const done = (ctx, id) => waitFor(() => ctx.store.getTask(id).status === 'done' && ctx.store.getTask(id), { label: `việc #${id} xong` });

// ---- Cấu hình ----

test('config: COMPANY_ENGINES là danh sách ưu tiên; đặt riêng engine thì danh sách chỉ có engine đó', () => {
  const before = { ...process.env };
  try {
    process.env.COMPANY_ENGINES = 'agy, claude';
    delete process.env.COMPANY_ENGINE;
    const cfg = loadConfig({ projectRoot: process.cwd() });
    assert.deepEqual(cfg.engines, ['agy', 'claude']);
    assert.equal(cfg.engine, 'agy', 'engine mặc định là engine đầu tiên');
    assert.deepEqual(loadConfig({ projectRoot: process.cwd(), overrides: { engine: 'claude' } }).engines, ['claude']);
    assert.deepEqual(loadConfig({ projectRoot: process.cwd(), overrides: { engines: ['claude', 'agy'] } }).engines, ['claude', 'agy']);
    delete process.env.COMPANY_ENGINES;
    assert.deepEqual(loadConfig({ projectRoot: process.cwd() }).engines, ['claude']);
  } finally {
    for (const key of ['COMPANY_ENGINES', 'COMPANY_ENGINE']) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

// ---- Xoay vòng ----

test('hết hạn mức Claude: việc chuyển sang Antigravity ngay, cả công ty KHÔNG nghỉ, có bàn giao và việc sau đi thẳng engine còn hạn mức', async () => {
  const ctx = await setup({ env: { FAKE_CLAUDE_SCENARIO: 'quota', FAKE_CLAUDE_RESET_IN: '600' } });
  try {
    const { id } = await ctx.runner.submit(job);
    const task = await done(ctx, id);
    assert.equal(task.engine, 'agy');
    assert.equal(task.session_id, 'fake-agy-conversation-1', 'phiên của Claude không được mang sang agy');
    assert.equal(task.handoff_from, null);
    assert.equal(ctx.claude().length, 1);
    assert.equal(ctx.agy().length, 1);
    const [call] = ctx.agy();
    assert.match(call.prompt, /Bàn giao từ engine khác/);
    assert.match(call.prompt, /Claude Code làm nhưng bị dừng vì hết hạn mức/);
    assert.ok(!call.args.includes('--conversation'), 'agy bắt đầu phiên mới');
    assert.match(call.prompt, /Tạo file hello\.txt/, 'đề bài gốc vẫn còn trong lời nhắc');

    const snap = ctx.runner.snapshot();
    assert.equal(snap.pausedUntil, 0, 'còn engine khác nên công ty không nghỉ');
    const claude = snap.engines.find((e) => e.id === 'claude');
    assert.ok(claude.blockedUntil > Date.now() + 300_000, 'Claude bị chặn tới giờ hồi');
    assert.equal(snap.engines.find((e) => e.id === 'agy').blockedUntil, 0);
    const events = ctx.store.listEvents(id).map((e) => `${e.kind}: ${e.summary}`);
    assert.ok(events.some((e) => /^quota: Hết hạn mức Pro.*Chuyển việc sang Antigravity/.test(e)), events.join('\n'));
    assert.ok(events.some((e) => /^system: Chuyển từ Claude Code sang Antigravity/.test(e)));

    // Việc kế tiếp (của người khác) không đụng tới Claude nữa trong lúc nó còn bị chặn.
    const second = await ctx.runner.submit({ ...job, title: 'Việc hai', member: 'Bình' });
    const t2 = await done(ctx, second.id);
    assert.equal(t2.engine, 'agy');
    assert.equal(ctx.claude().length, 1, 'không gọi Claude khi nó đang hết hạn mức');
    assert.ok(!/Bàn giao/.test(ctx.agy()[1].prompt), 'việc mới không có bàn giao');
  } finally {
    await ctx.cleanup();
  }
});

test('mọi engine đều hết hạn mức: việc chờ, cả công ty nghỉ tới giờ hồi sớm nhất', async () => {
  const ctx = await setup({ env: { FAKE_CLAUDE_SCENARIO: 'quota', FAKE_CLAUDE_RESET_IN: '600', FAKE_AGY_SCENARIO: 'quota' } });
  try {
    const { id } = await ctx.runner.submit(job);
    const task = await waitFor(() => ctx.store.getTask(id).status === 'paused_quota' && ctx.runner.snapshot().pausedUntil && ctx.store.getTask(id), { label: 'tất cả hết hạn mức' });
    const snap = ctx.runner.snapshot();
    assert.equal(snap.pauseReason, 'quota');
    const claudeUntil = snap.engines.find((e) => e.id === 'claude').blockedUntil;
    const agyUntil = snap.engines.find((e) => e.id === 'agy').blockedUntil;
    assert.equal(agyUntil, Date.parse('2099-01-01T00:00:00Z'));
    assert.equal(snap.pausedUntil, Math.min(claudeUntil, agyUntil), 'nghỉ tới giờ hồi sớm nhất (Claude)');
    assert.equal(task.resume_at, agyUntil, 'việc nhớ giờ hồi của engine đã chạy nó lần cuối');
    assert.equal(ctx.claude().length, 1);
    assert.equal(ctx.agy().length, 1);
    const events = ctx.store.listEvents(id).map((e) => e.summary);
    assert.ok(events.some((e) => /Cả công ty tạm nghỉ/.test(e)));
  } finally {
    await ctx.cleanup();
  }
});

test('engine duy nhất còn lại cũng hết hạn mức thì làm tiếp đúng phiên cũ (--resume) khi nó hồi, không bàn giao', async () => {
  const ctx = await setup({ env: { FAKE_CLAUDE_SCENARIO: 'quota', FAKE_CLAUDE_RESET_IN: '2' } });
  try {
    ctx.runner.blockEngine('agy', Date.now() + 3_600_000); // agy không dùng được: Claude là lựa chọn duy nhất
    const { id } = await ctx.runner.submit(job);
    await waitFor(() => ctx.store.getTask(id).status === 'paused_quota', { label: 'tạm dừng' });
    assert.ok(ctx.runner.snapshot().pausedUntil > 0, 'mọi engine bị chặn nên công ty nghỉ');
    const task = await waitFor(() => ctx.store.getTask(id).status === 'done' && ctx.store.getTask(id), { timeout: 20000, label: 'làm tiếp' });
    assert.equal(task.engine, 'claude');
    const resumed = ctx.claude().find((c) => c.resumed);
    assert.ok(resumed, 'phải dùng --resume');
    assert.equal(ctx.agy().length, 0);
    assert.doesNotMatch(resumed.prompt, /Bàn giao/);
  } finally {
    await ctx.cleanup();
  }
});

test('hết thời gian chặn thì engine ưu tiên đầu tiên được dùng lại', async () => {
  const ctx = await setup();
  try {
    ctx.runner.blockEngine('claude', Date.now() + 300);
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(ctx.runner.snapshot().engines.find((e) => e.id === 'claude').blockedUntil, 0);
    const { id } = await ctx.runner.submit(job);
    const task = await done(ctx, id);
    assert.equal(task.engine, 'claude');
    assert.equal(ctx.agy().length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('thứ tự ưu tiên theo cấu hình: engines ["agy","claude"] chạy agy trước', async () => {
  const ctx = await setup({ engines: ['agy', 'claude'] });
  try {
    const { id } = await ctx.runner.submit(job);
    const task = await done(ctx, id);
    assert.equal(task.engine, 'agy');
    assert.equal(ctx.claude().length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('lượt Trưởng nhóm cần MCP: Claude hết hạn mức thì lượt chờ (không đẩy sang agy), các việc làm vẫn chạy bằng agy, công ty không nghỉ', async () => {
  const ctx = await setup();
  try {
    ctx.runner.blockEngine('claude', Date.now() + 3_600_000);
    const created = await ctx.runner.jobs.create({ team: 'backend', title: 'Làm tính năng X', prompt: 'Chia việc giúp tôi' });
    const worker = await ctx.runner.submit(job);
    await done(ctx, worker.id);
    const plan = ctx.store.jobTasks(created.id).find((t) => t.kind === 'plan');
    assert.equal(plan.status, 'queued', 'lượt lập kế hoạch nằm chờ trong hàng đợi tới khi Claude hồi');
    assert.equal(ctx.runner.running.has(plan.id), false);
    assert.equal(ctx.claude().length, 0);
    assert.equal(ctx.agy().length, 1, 'chỉ việc làm chạy bằng agy');
    assert.equal(ctx.runner.snapshot().pausedUntil, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('lệnh của engine không có trên máy: engine bị coi là không dùng được một lúc và việc chạy bằng engine kế', async () => {
  const ctx = await setup({ engines: ['agy', 'claude'], overrides: { agyBin: 'khong-co-lenh-agy-nay', agyArgsPrefix: [] } });
  try {
    const { id } = await ctx.runner.submit(job);
    const task = await done(ctx, id);
    assert.equal(task.engine, 'claude');
    assert.equal(task.attempts, 2, 'lần đầu không chạy được, lần hai chạy bằng Claude');
    assert.ok(ctx.runner.snapshot().engines.find((e) => e.id === 'agy').blockedUntil > Date.now() + 500_000);
    assert.ok(ctx.store.listEvents(id).some((e) => e.kind === 'warn' && /Không tìm thấy lệnh của Antigravity.*Chuyển việc sang Claude Code/.test(e.summary)));
  } finally {
    await ctx.cleanup();
  }
});

test('chỉ một engine mà thiếu lệnh: vẫn báo lỗi rõ như trước (không xoay vòng được)', async () => {
  const ctx = await setup({ engines: ['agy'], overrides: { agyBin: 'khong-co-lenh-agy-nay', agyArgsPrefix: [] } });
  try {
    const { id } = await ctx.runner.submit(job);
    const task = await waitFor(() => ctx.store.getTask(id).status === 'failed' && ctx.store.getTask(id), { label: 'việc lỗi' });
    assert.equal(task.failure_code, 'no_claude');
    assert.match(task.error, /Không chạy được agy/);
  } finally {
    await ctx.cleanup();
  }
});

test('engine bị chặn được nhớ qua lần khởi động lại máy chủ', async () => {
  const ctx = await setup();
  try {
    const until = Date.now() + 3_600_000;
    ctx.runner.blockEngine('claude', until);
    const again = new Runner({ cfg: ctx.cfg, store: ctx.store, getTeams: () => [], getProject: () => null });
    again.recover();
    assert.equal(again.snapshot().engines.find((e) => e.id === 'claude').blockedUntil, until);
  } finally {
    await ctx.cleanup();
  }
});

// ---- /api/engines ----

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { host: `localhost:${port}` } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    }).on('error', reject);
  });
}

test('GET /api/engines: mọi engine, liên kết hay chưa, model thật, đăng nhập, bị chặn tới khi nào', async () => {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg = testConfig(root, project, local, { engines: ['claude'], agyBin: process.execPath, agyArgsPrefix: [FAKE_AGY] });
  const app = await startServer({ cfg, withUi: false, log: () => {} });
  try {
    const res = await get(app.port, '/api/engines');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.order, ['claude']);
    const claude = res.json.engines.find((e) => e.id === 'claude');
    const agy = res.json.engines.find((e) => e.id === 'agy');
    assert.equal(claude.linked, true);
    assert.equal(claude.order, 0);
    assert.equal(claude.installed, true);
    assert.deepEqual(claude.models.map((m) => m.id), ['haiku', 'sonnet', 'opus']);
    assert.ok(!claude.models.some((m) => /fable/i.test(m.id)), 'không bao giờ có model fable');
    assert.equal(claude.capabilities.mcp, true);
    assert.equal(agy.linked, false);
    assert.equal(agy.order, -1);
    assert.equal(agy.installed, true);
    assert.equal(agy.loggedIn, true);
    assert.deepEqual(agy.models.map((m) => m.id), ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'claude-opus-4-6-thinking']);
    assert.equal(agy.capabilities.mcp, false);
    assert.equal(agy.blockedUntil, 0);

    // Giờ bị chặn lấy tươi từ runner, không bị kẹt trong bộ nhớ đệm.
    const until = Date.now() + 3_600_000;
    app.runner.blockEngine('claude', until);
    const again = await get(app.port, '/api/engines');
    assert.equal(again.json.engines.find((e) => e.id === 'claude').blockedUntil, until);
  } finally {
    await app.close();
    removeDir(root);
  }
});

test('GET /api/engines: engine chưa cài được báo installed=false kèm lý do, không làm hỏng cả danh sách', async () => {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg = testConfig(root, project, local, { engines: ['claude', 'agy'], agyBin: 'khong-co-lenh-agy-nay', agyArgsPrefix: [] });
  const app = await startServer({ cfg, withUi: false, log: () => {} });
  try {
    const res = await get(app.port, '/api/engines?refresh=1');
    const agy = res.json.engines.find((e) => e.id === 'agy');
    assert.equal(agy.installed, false);
    assert.deepEqual(agy.models, []);
    assert.match(agy.detail, /Không chạy được/);
    assert.equal(res.json.engines.find((e) => e.id === 'claude').installed, true);
  } finally {
    await app.close();
    removeDir(root);
  }
});

// ---- Liên kết AI từ giao diện ----

function post(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { host: `localhost:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('GET /api/engines có bảng bậc model → model thật của từng engine', async () => {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg = testConfig(root, project, local, { engines: ['claude', 'agy'], agyBin: process.execPath, agyArgsPrefix: [FAKE_AGY] });
  const app = await startServer({ cfg, withUi: false, log: () => {} });
  try {
    const { json } = await get(app.port, '/api/engines');
    assert.deepEqual(json.engines.find((e) => e.id === 'claude').tiers, { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' });
    // fake-agy có flash-low, flash-high, opus-thinking: sonnet → flash-high, haiku → flash-low, opus → claude-opus-4-6-thinking
    assert.deepEqual(json.engines.find((e) => e.id === 'agy').tiers, { haiku: 'gemini-3.8-flash-low', sonnet: 'gemini-3.8-flash-high', opus: 'claude-opus-4-6-thinking' });
  } finally {
    await app.close();
    removeDir(root);
  }
});

test('POST /api/engines: chủ liên kết engine và đổi thứ tự; chỉ nhận engine đã cài; danh sách được nhớ qua lần khởi động lại', async () => {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg = testConfig(root, project, local, { engines: ['claude'], agyBin: process.execPath, agyArgsPrefix: [FAKE_AGY] });
  const app = await startServer({ cfg, withUi: false, log: () => {} });
  try {
    const ok = await post(app.port, '/api/engines', { order: ['agy', 'claude'] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.order, ['agy', 'claude']);
    assert.deepEqual(ok.json.engines.map((e) => [e.id, e.linked, e.order]), [['claude', true, 1], ['agy', true, 0]], 'trả sẵn danh sách mới cho giao diện');
    assert.deepEqual(app.runner.engines.map((e) => e.id), ['agy', 'claude']);
    assert.equal(app.runner.engine.id, 'agy', 'engine đầu danh sách là engine ưu tiên');
    const after = await get(app.port, '/api/engines');
    assert.deepEqual(after.json.order, ['agy', 'claude']);
    assert.equal(after.json.engines.find((e) => e.id === 'agy').linked, true);
    assert.equal((await get(app.port, '/api/state')).json.company.engines.length, 2);

    // Máy chủ khởi động lại với cấu hình gốc (chỉ claude): lựa chọn của chủ được nhớ.
    const again = new Runner({ cfg: { ...cfg, engines: ['claude'], engine: 'claude' }, store: app.store, getTeams: () => [], getProject: () => null });
    again.recover();
    assert.deepEqual(again.engines.map((e) => e.id), ['agy', 'claude']);

    const bad = [
      [{ order: [] }, /ít nhất một engine/],
      [{ order: ['nope'] }, /không tồn tại/],
      [{}, /ít nhất một engine/],
    ];
    for (const [body, pattern] of bad) {
      const res = await post(app.port, '/api/engines', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.json.error, pattern);
    }
    assert.deepEqual(app.runner.engines.map((e) => e.id), ['agy', 'claude'], 'yêu cầu sai không làm đổi danh sách');
  } finally {
    await app.close();
    removeDir(root);
  }
});

test('POST /api/engines: không cho liên kết engine chưa cài', async () => {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg = testConfig(root, project, local, { engines: ['claude'], agyBin: 'khong-co-lenh-agy-nay', agyArgsPrefix: [] });
  const app = await startServer({ cfg, withUi: false, log: () => {} });
  try {
    const res = await post(app.port, '/api/engines', { order: ['claude', 'agy'] });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Antigravity chưa cài/);
    assert.deepEqual(app.runner.engines.map((e) => e.id), ['claude']);
  } finally {
    await app.close();
    removeDir(root);
  }
});
