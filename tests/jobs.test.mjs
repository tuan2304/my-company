import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.mjs';
import { startServer } from '../server/index.mjs';
import { buildLeadSystemPrompt, findOverlap, MAX_SCOPE_ENTRIES, normalizeFiles } from '../server/jobs.mjs';
import { findMember, loadTeams } from '../server/teams.mjs';
import { copyFiles, createWorktree, commitWorktree, linkDirs, linkedDirs, outOfScope } from '../server/worktree.mjs';
import { REPO, git, makeProject, removeDir, testConfig, tmpDir, waitFor } from './helpers.mjs';

const FAKE_KEYS = ['FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_TRIAGE', 'FAKE_PLAN', 'FAKE_REVIEW', 'FAKE_REVIEW_MAP', 'FAKE_UNIQUE', 'FAKE_CONFLICT', 'FAKE_WORK_DELAY_MS'];

async function boot(env = {}, overrides = {}) {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg = testConfig(root, project, local, overrides);
  const logFile = path.join(root, 'fake.log');
  Object.assign(process.env, { FAKE_CLAUDE_LOG: logFile, ...env });
  const app = await startServer({ cfg, withUi: false, log: () => {} });
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const cleanup = async () => {
    await app.close();
    for (const key of FAKE_KEYS) delete process.env[key];
    removeDir(root);
  };
  return { root, project, local, cfg, app, runner: app.runner, store: app.store, calls, cleanup };
}

const flag = (call, name) => call.args[call.args.indexOf(name) + 1];
// Mọi lượt của nhân viên chạy ở chế độ quyền default (không acceptEdits).
// Trưởng nhóm / Giám đốc có MCP của họ; nhân viên (từ 6D) cũng có MCP nhưng chỉ với công cụ hỏi (ask_*).
const isLeadCall = (c) => c.args.includes('--mcp-config') && !flag(c, '--allowedTools').includes('mcp__company__ask_lead');
const workCalls_every_default = (calls) => calls.filter((c) => !isLeadCall(c) && !c.isTriage).every((c) => flag(c, '--permission-mode') === 'default');
const plan2 = (extra = {}) => JSON.stringify([
  { member: 'An', title: 'Việc của An', description: 'Làm phần A', acceptance: 'test chạy qua', files: ['src/a'], level: 'normal', ...extra.an },
  { member: 'Bình', title: 'Việc của Bình', description: 'Làm phần B', acceptance: 'test chạy qua', files: ['src/b'], level: 'normal', ...extra.binh },
]);
const newJob = (ctx, over = {}) => ctx.runner.jobs.create({ team: 'backend', title: 'Làm tính năng X', prompt: 'Chia việc giúp tôi', ...over });
const jobDone = (ctx, id, statuses = ['done']) => waitFor(() => statuses.includes(ctx.store.getJob(id).status) && ctx.store.getJob(id), { timeout: 40000, label: `việc lớn #${id} kết thúc` });

test('đường đi đầy đủ: Trưởng nhóm chia 2 việc, hai người làm song song, một bài bị trả lại một lần, rồi gộp nhánh', async () => {
  const ctx = await boot({
    FAKE_PLAN: plan2(), FAKE_UNIQUE: '1', FAKE_WORK_DELAY_MS: '600', FAKE_REVIEW_MAP: JSON.stringify({ 2: 'reject_once' }), FAKE_REVIEW: 'approve',
  });
  try {
    const job = await newJob(ctx);
    assert.equal(job.status, 'planning');
    const done = await jobDone(ctx, job.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(done.merge_branch, `company/job${job.id}`);

    const tasks = ctx.store.jobTasks(job.id);
    const [plan, an, binh] = tasks;
    assert.deepEqual([plan.kind, an.kind, binh.kind], ['plan', 'work', 'work']);
    assert.deepEqual([an.member, binh.member], ['An', 'Bình']);
    assert.deepEqual([an.status, binh.status], ['done', 'done']);
    assert.equal(an.revisions, 1, 'bài của An bị trả lại đúng một lần');
    assert.equal(binh.revisions, 0);
    assert.equal(tasks.filter((t) => t.kind === 'review').length, 3, 'An được duyệt 2 lần, Bình 1 lần');

    // Chạy song song: khoảng thời gian chạy của hai nhân viên chồng lên nhau.
    assert.ok(an.started_at < binh.finished_at && binh.started_at < an.finished_at, 'An và Bình phải chạy chồng thời gian');

    // Các nhánh đã gộp vào nhánh tích hợp, nhánh chính của dự án không bị đụng.
    const merged = git(ctx.project, 'ls-tree', '-r', '--name-only', done.merge_branch).split('\n');
    assert.ok(merged.includes(`out-${path.basename(an.worktree)}.txt`) && merged.includes(`out-${path.basename(binh.worktree)}.txt`));
    assert.equal(git(ctx.project, 'rev-parse', 'main'), done.base_commit);
    assert.match(done.summary, /Việc của An.*đã duyệt, bị trả 1 lần/);

    const calls = ctx.calls();
    const leadCalls = calls.filter(isLeadCall);
    const workCalls = calls.filter((c) => !isLeadCall(c) && !c.isTriage);

    // Model: kế hoạch dùng opus, duyệt bài dùng sonnet (review_model), nhân viên dùng sonnet.
    assert.equal(flag(leadCalls[0], '--model'), 'opus');
    assert.ok(leadCalls.slice(1).every((c) => flag(c, '--model') === 'sonnet'));
    // Trưởng nhóm chỉ đọc: không có Edit/Write, có công cụ MCP của công ty, hook chặn ở chế độ chỉ đọc.
    assert.equal(flag(leadCalls[0], '--tools'), 'Read,Grep,Glob,Bash');
    assert.match(flag(leadCalls[0], '--allowedTools'), /mcp__company__assign_to_member/);
    assert.doesNotMatch(flag(leadCalls[0], '--allowedTools'), /Edit|Write/);
    assert.equal(leadCalls[0].guard.mode, 'readonly');
    // Lượt lập kế hoạch không chạy test; lượt duyệt bài được chạy lệnh test của dự án để kiểm chứng.
    assert.doesNotMatch(flag(leadCalls[0], '--allowedTools'), /npm test/);
    assert.match(flag(leadCalls[1], '--allowedTools'), /Bash\(npm test\)/);
    assert.ok(workCalls_every_default(calls));
    // Nhân viên bị giới hạn ở thư mục của team trong hồ sơ dự án.
    assert.ok(workCalls.every((c) => c.guard.mode === 'worker' && c.guard.allow === '["src"]'));
    assert.ok(workCalls.every((c) => c.args.includes('--settings')));
    // Lần làm lại: dùng đúng phiên cũ (--resume) và prompt mang nhận xét của Trưởng nhóm.
    const rework = workCalls.find((c) => c.resumed);
    assert.ok(rework, 'có một lần làm lại');
    assert.match(rework.prompt, /Thiếu test cho trường hợp lỗi/);
    assert.ok(ctx.store.listEvents(an.id).some((e) => e.kind === 'review' && /trả bài \(lần 1\/2\)/.test(e.summary)));
    assert.ok(ctx.store.listEvents(plan.id).some((e) => e.kind === 'tool' && /assign_to_member/.test(e.summary)));
  } finally {
    await ctx.cleanup();
  }
});

test('giới hạn tải: nhân viên đủ việc thì Trưởng nhóm bị từ chối giao thêm, giao việc lẻ cũng bị từ chối', async () => {
  const items = ['1', '2', '3', '4'].map((n) => ({ member: 'An', title: `Việc ${n}`, description: 'x', files: [`src/p${n}`], level: 'normal' }));
  const ctx = await boot({ FAKE_PLAN: JSON.stringify(items), FAKE_CLAUDE_SCENARIO: 'hang' });
  try {
    const job = await newJob(ctx);
    await waitFor(() => ctx.store.getTask(job.plan_task_id).status === 'done', { label: 'kế hoạch xong' });
    const an = ctx.store.jobTasks(job.id).filter((t) => t.kind === 'work');
    assert.equal(an.length, 3, '1 đang làm + 2 chờ = đúng giới hạn, việc thứ 4 bị từ chối');
    const errors = ctx.store.listEvents(job.plan_task_id).filter((e) => e.kind === 'tool_error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].summary, /An đang có 3\/3 việc/);
    await waitFor(() => ctx.store.getTask(an[0].id).status === 'running', { label: 'An bắt đầu làm' });
    assert.deepEqual(an.map((t) => ctx.store.getTask(t.id).status).sort(), ['queued', 'queued', 'running']);

    // Giao việc lẻ cho An cũng bị chặn; giao cho Bình (còn trống) thì được; giao cho Trưởng nhóm thì không.
    await assert.rejects(ctx.runner.submit({ title: 'Thêm', prompt: 'x', member: 'An', level: 'normal' }), /An đang có 3\/3 việc/);
    await assert.rejects(ctx.runner.submit({ title: 'Thêm', prompt: 'x', member: 'Minh', level: 'normal' }), /Trưởng nhóm/);
    const ok = await ctx.runner.submit({ title: 'Việc lẻ của Bình', prompt: 'x', member: 'Bình', level: 'normal' });
    assert.equal(ok.kind, 'work');
    assert.equal(ok.job_id, null);
  } finally {
    await ctx.cleanup();
  }
});

test('assign từ chối: trùng phạm vi file, trùng tiêu đề, thiếu files, người lạ, quá số việc con tối đa', async () => {
  const ctx = await boot();
  try {
    ctx.runner.setManualPause(true); // không chạy kế hoạch thật, chỉ gọi thẳng công cụ để kiểm tra luật
    const job = await newJob(ctx);
    const plan = ctx.store.getTask(job.plan_task_id);
    const assign = (over) => ctx.runner.jobs.assign(plan, { member: 'An', title: 'A', description: 'd', files: ['src/server'], level: 'normal', ...over });

    assert.match(assign({}), /Đã giao việc #\d+ "A" cho An/);
    assert.throws(() => assign({ member: 'Bình', title: 'B', files: ['src/server/api.js'] }), /chồng lấn với việc #\d+ "A" của An/);
    assert.throws(() => assign({ member: 'Bình', title: 'B', files: ['src'] }), /chồng lấn/, 'thư mục cha cũng chồng lấn');
    assert.match(assign({ member: 'Bình', title: 'B', files: ['src/serverless'] }), /Đã giao/, 'tên chỉ giống tiền tố nhưng khác thư mục thì không chồng lấn');
    assert.throws(() => assign({ title: 'a', files: ['src/docs'] }), /Đã có việc con tên "a"/);
    assert.throws(() => assign({ title: 'C', files: [] }), /Thiếu "files"/);
    assert.throws(() => assign({ title: 'C', files: ['.'] }), /cụ thể/);
    assert.throws(() => assign({ title: 'C', files: ['../ngoai'] }), /không hợp lệ/);
    // Việc con ôm quá nhiều chỗ thì bị từ chối: nhân viên sẽ hết lượt giữa chừng (bài học web96).
    const many = Array.from({ length: MAX_SCOPE_ENTRIES + 1 }, (_, i) => `src/x${i}.js`);
    assert.throws(() => assign({ member: 'Bình', title: 'To', files: many }), /quá 6: việc này quá to/);
    assert.throws(() => assign({ member: 'Ma', title: 'C', files: ['src/docs'] }), /Không có nhân viên "Ma".*An, Bình/);
    assert.throws(() => assign({ member: 'Minh', title: 'C', files: ['src/docs'] }), /Không có nhân viên "Minh"/, 'không giao việc làm cho Trưởng nhóm');
    assert.throws(() => assign({ title: 'C', files: ['src/docs'], level: 'cực khó' }), /level/);

    // Phạm vi phải nằm trong thư mục của team (hồ sơ dự án: backend = [src]); phần của team khác bị từ chối.
    assert.throws(() => assign({ title: 'Ngoài', files: ['docs/x.md'] }), /"docs\/x\.md" nằm ngoài thư mục của Team Backend \(src\)/);
    assert.throws(() => assign({ title: 'Ngoài 2', files: ['src/ok.mjs', 'public/a.css'] }), /"public\/a\.css" nằm ngoài/);

    // Đủ số việc con tối đa của team thì dừng (max_subtasks = 6 nhưng hai người chỉ nhận tối đa 3 + 3).
    for (const n of [1, 2]) assign({ title: `An thêm ${n}`, files: [`src/an${n}`] });
    for (const n of [1, 2]) assign({ member: 'Bình', title: `Bình thêm ${n}`, files: [`src/binh${n}`] });
    assert.equal(ctx.store.jobTasks(job.id).filter((t) => t.kind === 'work').length, 6);
    assert.throws(() => assign({ title: 'Vượt mức', files: ['src/x'] }), /tối đa của team \(6\)/);
  } finally {
    await ctx.cleanup();
  }
});

test('trả bài quá số lần cho phép: việc con bị đánh dấu chưa đạt, việc lớn cần người xem; phần đã duyệt vẫn được gộp', async () => {
  const ctx = await boot({
    FAKE_PLAN: plan2(), FAKE_UNIQUE: '1', FAKE_REVIEW: 'approve', FAKE_REVIEW_MAP: JSON.stringify({ 2: 'reject_always' }),
  });
  try {
    const job = await newJob(ctx);
    const done = await jobDone(ctx, job.id, ['attention', 'done', 'failed']);
    assert.equal(done.status, 'attention');
    const [, an, binh] = ctx.store.jobTasks(job.id);
    assert.equal(an.status, 'failed');
    assert.equal(an.revisions, 2, 'đã trả đủ 2 lần');
    assert.match(an.error, /Bị trả bài quá 2 lần/);
    assert.equal(binh.status, 'done');
    assert.match(done.error, new RegExp(`#${an.id}`));
    assert.ok(done.merge_branch, 'phần của Bình vẫn được gộp');
    const merged = git(ctx.project, 'ls-tree', '-r', '--name-only', done.merge_branch);
    assert.match(merged, new RegExp(`out-${path.basename(binh.worktree)}\\.txt`));
    assert.doesNotMatch(merged, new RegExp(`out-${path.basename(an.worktree)}\\.txt`), 'phần bị trả hết lượt không được gộp');
  } finally {
    await ctx.cleanup();
  }
});

test('gộp nhánh xung đột: không tự giải quyết, báo file xung đột cho con người', async () => {
  const ctx = await boot({ FAKE_PLAN: plan2(), FAKE_CONFLICT: '1', FAKE_REVIEW: 'approve' });
  try {
    const job = await newJob(ctx);
    const done = await jobDone(ctx, job.id, ['attention', 'done', 'failed']);
    assert.equal(done.status, 'attention');
    assert.deepEqual(JSON.parse(done.conflict_files), ['shared.txt']);
    assert.match(done.error, /Xung đột khi gộp nhánh company\/\w+-task3/);
    // Lần gộp hỏng đã được hủy: nhánh tích hợp còn sạch, có phần của việc đầu tiên.
    assert.equal(git(done.merge_worktree ?? path.join(ctx.cfg.worktreesDir, `job${job.id}-merge`), 'status', '--porcelain'), '');
  } finally {
    await ctx.cleanup();
  }
});

test('lượt duyệt không có kết luận: thử lại một lần rồi đánh dấu việc con chưa đạt', async () => {
  const ctx = await boot({ FAKE_PLAN: JSON.stringify([JSON.parse(plan2())[0]]), FAKE_UNIQUE: '1', FAKE_REVIEW: 'none' });
  try {
    const job = await newJob(ctx);
    const done = await jobDone(ctx, job.id, ['failed', 'attention', 'done']);
    const reviews = ctx.store.jobTasks(job.id).filter((t) => t.kind === 'review');
    assert.equal(reviews.length, 2, 'duyệt lại đúng một lần');
    const work = ctx.store.jobTasks(job.id).find((t) => t.kind === 'work');
    assert.equal(work.status, 'failed');
    assert.match(work.error, /không đưa ra được kết luận/);
    assert.equal(done.status, 'failed');
  } finally {
    await ctx.cleanup();
  }
});

test('kế hoạch không chia ra việc nào thì việc lớn thất bại kèm lý do', async () => {
  const ctx = await boot({ FAKE_PLAN: '[]' });
  try {
    const job = await newJob(ctx);
    const done = await jobDone(ctx, job.id, ['failed', 'done', 'attention']);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /không chia ra việc nào/);
  } finally {
    await ctx.cleanup();
  }
});

test('dừng việc lớn: mọi việc con đang làm và đang chờ đều bị dừng', async () => {
  const ctx = await boot({ FAKE_PLAN: plan2(), FAKE_CLAUDE_SCENARIO: 'hang' });
  try {
    const job = await newJob(ctx);
    await waitFor(() => ctx.store.jobTasks(job.id).filter((t) => t.kind === 'work').length === 2 && ctx.store.jobTasks(job.id).some((t) => t.status === 'running' && t.kind === 'work'), { label: 'việc con đang chạy' });
    await ctx.runner.jobs.stop(job.id, 'Dừng thử');
    await waitFor(() => ctx.store.jobTasks(job.id).every((t) => ['done', 'stopped', 'failed'].includes(t.status)), { label: 'mọi việc con đã dừng' });
    assert.equal(ctx.store.getJob(job.id).status, 'stopped');
    assert.ok(ctx.store.jobTasks(job.id).filter((t) => t.kind === 'work').every((t) => t.status === 'stopped'));
  } finally {
    await ctx.cleanup();
  }
});

test('việc lớn giao qua HTTP: tạo, xem chi tiết, từ chối team không có', async () => {
  const ctx = await boot({ FAKE_PLAN: JSON.stringify([JSON.parse(plan2())[0]]), FAKE_UNIQUE: '1' });
  try {
    const host = { host: `localhost:${ctx.app.port}`, 'content-type': 'application/json' };
    const base = `http://127.0.0.1:${ctx.app.port}`;
    const bad = await fetch(`${base}/api/jobs`, { method: 'POST', headers: host, body: JSON.stringify({ team: 'khong-co', title: 'x', prompt: 'y' }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Không có team/);
    const created = await fetch(`${base}/api/jobs`, { method: 'POST', headers: host, body: JSON.stringify({ team: 'backend', title: 'Qua HTTP', prompt: 'Chia việc' }) });
    assert.equal(created.status, 201);
    const { job } = await created.json();
    await jobDone(ctx, job.id);
    const detail = await (await fetch(`${base}/api/jobs/${job.id}`, { headers: { host: host.host } })).json();
    assert.equal(detail.job.status, 'done');
    assert.deepEqual(detail.tasks.map((t) => t.kind), ['plan', 'work', 'review']);
    const list = await (await fetch(`${base}/api/jobs`, { headers: { host: host.host } })).json();
    assert.equal(list.jobs[0].id, job.id);
    assert.equal((await fetch(`${base}/api/jobs/999`, { headers: { host: host.host } })).status, 404);
    // Công cụ của agent: không có mã thông báo thì bị từ chối.
    assert.equal((await fetch(`${base}/api/agent/tools`, { headers: { host: host.host } })).status, 401);
    assert.equal((await fetch(`${base}/api/agent/call`, { method: 'POST', headers: { ...host, authorization: 'Bearer sai' }, body: '{}' })).status, 401);
  } finally {
    await ctx.cleanup();
  }
});

// ---- Cầu nối MCP ----

function mcpClient(env) {
  const child = spawn(process.execPath, [path.join(REPO, 'server', 'mcp-bridge.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  return {
    child,
    request: (method, params) => new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    }),
    notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
    close: () => child.kill(),
  };
}

test('cầu nối MCP: bắt tay, liệt kê và gọi công cụ đúng theo loại lượt, chặn công cụ không thuộc lượt', async () => {
  const ctx = await boot();
  try {
    ctx.runner.setManualPause(true);
    const job = await newJob(ctx);
    const token = 'ma-thong-bao-thu';
    ctx.runner.agentRuns.set(token, job.plan_task_id);
    const client = mcpClient({ COMPANY_API_URL: ctx.runner.apiUrl, COMPANY_RUN_TOKEN: token });
    try {
      const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      assert.equal(init.result.protocolVersion, '2025-06-18');
      assert.equal(init.result.serverInfo.name, 'company');
      assert.ok(init.result.capabilities.tools);
      client.notify('notifications/initialized');
      assert.deepEqual((await client.request('ping')).result, {});

      const list = await client.request('tools/list');
      assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['assign_contest', 'assign_to_member', 'get_team_workload'], 'lượt lập kế hoạch không có công cụ duyệt bài');
      assert.deepEqual(list.result.tools.find((t) => t.name === 'assign_to_member').inputSchema.required, ['member', 'title', 'description', 'files']);

      const workload = await client.request('tools/call', { name: 'get_team_workload', arguments: {} });
      assert.equal(workload.result.isError, false);
      assert.match(workload.result.content[0].text, /An .*còn nhận thêm được 3\/3/);
      assert.doesNotMatch(workload.result.content[0].text, /Minh/, 'Trưởng nhóm không nằm trong danh sách nhân viên làm việc');

      const assigned = await client.request('tools/call', { name: 'assign_to_member', arguments: { member: 'An', title: 'Qua cầu nối', description: 'd', files: ['src/x'], level: 'normal' } });
      assert.match(assigned.result.content[0].text, /Đã giao việc/);
      const refused = await client.request('tools/call', { name: 'review_submission', arguments: { task_id: 1, verdict: 'approve' } });
      assert.equal(refused.result.isError, true);
      assert.match(refused.result.content[0].text, /không dùng được/);
      assert.equal((await client.request('khong-biet')).error.code, -32601);
    } finally {
      client.close();
    }

    const bad = mcpClient({ COMPANY_API_URL: ctx.runner.apiUrl, COMPANY_RUN_TOKEN: 'sai' });
    try {
      const list = await bad.request('tools/list');
      assert.ok(list.error, 'mã thông báo sai thì không liệt kê được công cụ');
    } finally {
      bad.close();
    }
    // Hết lượt làm việc thì mã thông báo mất hiệu lực.
    ctx.runner.agentRuns.delete(token);
    const late = mcpClient({ COMPANY_API_URL: ctx.runner.apiUrl, COMPANY_RUN_TOKEN: token });
    try {
      assert.ok((await late.request('tools/list')).error);
    } finally {
      late.close();
    }
  } finally {
    await ctx.cleanup();
  }
});

// ---- Các hàm nhỏ ----

test('normalizeFiles và findOverlap', () => {
  assert.deepEqual(normalizeFiles(['./src\\api/', '/docs//', 'src/api']), ['src/api', 'docs'], 'chuẩn hóa dấu gạch, bỏ trùng');
  assert.deepEqual(findOverlap(['src/a'], ['src/b']), null);
  assert.deepEqual(findOverlap(['src/a'], ['src/a/x.js']), ['src/a', 'src/a/x.js']);
  assert.equal(findOverlap(['src/ab'], ['src/a']), null);
});

test('worktree nối node_modules từ dự án và không commit nó', async () => {
  const root = tmpDir();
  try {
    const { project } = makeProject(root);
    fs.mkdirSync(path.join(project, 'node_modules', 'goi'), { recursive: true });
    fs.writeFileSync(path.join(project, 'node_modules', 'goi', 'index.js'), 'module.exports = 1;\n');
    const wt = await createWorktree({ projectRoot: project, worktreesDir: path.join(root, 'wts'), member: 'An', taskId: 1, links: ['node_modules', 'khong-co', '../thoat'] });
    assert.deepEqual(wt.linked, ['node_modules'], 'chỉ nối thư mục có thật và an toàn');
    assert.ok(fs.existsSync(path.join(wt.dir, 'node_modules', 'goi', 'index.js')), 'đọc được qua liên kết');
    fs.writeFileSync(path.join(wt.dir, 'moi.txt'), 'x\n');
    const { changedFiles } = await commitWorktree({ dir: wt.dir, message: 'thử', exclude: ['node_modules'] });
    assert.deepEqual(changedFiles, ['moi.txt']);
    assert.doesNotMatch(git(wt.dir, 'ls-tree', '-r', '--name-only', 'HEAD'), /node_modules/);
    assert.deepEqual(linkDirs({ projectRoot: project, worktree: wt.dir, names: ['node_modules'] }), [], 'không nối lại khi đã có');
    fs.rmSync(path.join(wt.dir, 'node_modules')); // gỡ liên kết (không xóa dữ liệu thật)
    assert.ok(fs.existsSync(path.join(project, 'node_modules', 'goi', 'index.js')), 'dữ liệu thật của dự án còn nguyên');
  } finally {
    removeDir(root);
  }
});

test('worktree chép file gitignore (worktree_copies) và linkedDirs trả đích thật của thư mục nối', async () => {
  const root = tmpDir();
  try {
    const { project } = makeProject(root);
    fs.writeFileSync(path.join(project, '.gitignore'), '/AGENTS.md\n/.env\n/node_modules\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'ignore');
    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# A\n');
    fs.writeFileSync(path.join(project, '.env'), 'S=1\n');
    fs.mkdirSync(path.join(project, 'docs', 'rieng'), { recursive: true });
    fs.writeFileSync(path.join(project, 'docs', 'rieng', 'ghi-chu.md'), 'x\n');
    fs.mkdirSync(path.join(project, 'node_modules', 'goi'), { recursive: true });
    fs.writeFileSync(path.join(project, 'node_modules', 'goi', 'index.js'), '1\n');

    const wt = await createWorktree({
      projectRoot: project, worktreesDir: path.join(root, 'wts'), member: 'An', taskId: 1,
      links: ['node_modules'], copies: ['AGENTS.md', '.env', 'docs/rieng', '../ngoai.txt', '.git/config', 'khong-co.md', 'README.md'],
    });
    assert.deepEqual(wt.copied, ['AGENTS.md', 'docs/rieng'], 'chép file và thư mục có thật; bỏ .env, .git, đường dẫn ra ngoài, file không có, file đã có sẵn trong worktree');
    assert.equal(fs.readFileSync(path.join(wt.dir, 'AGENTS.md'), 'utf8'), '# A\n');
    assert.equal(fs.readFileSync(path.join(wt.dir, 'docs', 'rieng', 'ghi-chu.md'), 'utf8'), 'x\n');
    assert.ok(!fs.existsSync(path.join(wt.dir, '.env')));

    const linked = linkedDirs({ worktree: wt.dir, names: ['node_modules', 'khong-co', 'docs', '../thoat'] });
    assert.deepEqual(linked.map((l) => l.name), ['node_modules'], 'chỉ liên kết thật; thư mục thường (docs) hay thiếu thì không');
    assert.equal(linked[0].real, fs.realpathSync.native(path.join(project, 'node_modules')));

    // File đã chép không bị commit: AGENTS.md đã gitignore; docs/rieng thì được loại trừ rõ.
    fs.writeFileSync(path.join(wt.dir, 'moi.txt'), 'x\n');
    const { changedFiles } = await commitWorktree({ dir: wt.dir, message: 'thử', exclude: ['node_modules', 'AGENTS.md', 'docs/rieng'] });
    assert.deepEqual(changedFiles, ['moi.txt']);
    assert.deepEqual(git(wt.dir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort(), ['.gitignore', 'README.md', 'moi.txt']);
    assert.deepEqual(copyFiles({ projectRoot: project, worktree: wt.dir, names: ['AGENTS.md'] }), [], 'đã có thì không chép đè');
    fs.rmSync(path.join(wt.dir, 'node_modules'));
  } finally {
    removeDir(root);
  }
});

test('commitWorktree vẫn commit được khi node_modules đã nằm trong .gitignore của dự án (như web96)', async () => {
  const root = tmpDir();
  try {
    const { project } = makeProject(root);
    fs.writeFileSync(path.join(project, '.gitignore'), '/node_modules\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'ignore node_modules');
    fs.mkdirSync(path.join(project, 'node_modules', 'goi'), { recursive: true });
    fs.writeFileSync(path.join(project, 'node_modules', 'goi', 'index.js'), 'module.exports = 1;\n');
    const wt = await createWorktree({ projectRoot: project, worktreesDir: path.join(root, 'wts'), member: 'An', taskId: 1, links: ['node_modules'] });
    fs.writeFileSync(path.join(wt.dir, 'moi.txt'), 'x\n');
    const { changedFiles, commit } = await commitWorktree({ dir: wt.dir, message: 'thử', exclude: ['node_modules'] });
    assert.deepEqual(changedFiles, ['moi.txt']);
    assert.ok(commit, 'phải commit được, không để file nằm lại trong index');
    assert.equal(git(wt.dir, 'status', '--porcelain').trim(), '');
    fs.rmSync(path.join(wt.dir, 'node_modules'));
  } finally {
    removeDir(root);
  }
});

test('commitWorktree có phạm vi: file công cụ tự sinh ngoài thư mục của team (tsconfig.json, next-env.d.ts) không vào nhánh', async () => {
  // Lỗi thật web96: team Kiểm thử chạy next dev, Next sửa tsconfig.json + next-env.d.ts, hai file theo vào nhánh và bản gộp.
  const root = tmpDir();
  try {
    const { project } = makeProject(root);
    fs.writeFileSync(path.join(project, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(project, 'next-env.d.ts'), '// a\n');
    fs.mkdirSync(path.join(project, 'tests'));
    fs.writeFileSync(path.join(project, 'tests', 'cu [1].cjs'), 'x\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'base');
    const wt = await createWorktree({ projectRoot: project, worktreesDir: path.join(root, 'wts'), member: 'Quan', taskId: 7 });
    fs.writeFileSync(path.join(wt.dir, 'tsconfig.json'), '{"include":[".next/dev/dev/types"]}');
    fs.writeFileSync(path.join(wt.dir, 'next-env.d.ts'), '// b\n');
    fs.writeFileSync(path.join(wt.dir, 'tests', 'moi.cjs'), 'y\n');
    fs.rmSync(path.join(wt.dir, 'tests', 'cu [1].cjs'));
    fs.writeFileSync(path.join(wt.dir, 'README.md'), 'sửa\n');
    const scope = { allow: ['tests', 'scripts/verify-core.cjs'], mode: 'worker' };
    const out = await commitWorktree({ dir: wt.dir, message: 'thử', scope });
    assert.deepEqual(out.changedFiles.sort(), ['tests/cu [1].cjs', 'tests/moi.cjs']);
    assert.deepEqual(out.skipped.sort(), ['README.md', 'next-env.d.ts', 'tsconfig.json']);
    const committed = git(wt.dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort();
    assert.deepEqual(committed, ['tests/cu [1].cjs', 'tests/moi.cjs'], 'xóa file trong phạm vi vẫn được commit; file ngoài phạm vi thì không');
    // File bị bỏ vẫn nằm trong thư mục làm việc (không mất gì), lần commit sau vẫn bị lọc, và chỉ còn chúng thì không tạo commit rỗng.
    assert.match(fs.readFileSync(path.join(wt.dir, 'tsconfig.json'), 'utf8'), /dev\/dev/);
    const again = await commitWorktree({ dir: wt.dir, message: 'lần 2', scope });
    assert.deepEqual(again.changedFiles, []);
    assert.equal(again.commit, null);
    // Không phạm vi (danh sách rỗng, team viết code được sửa mọi nơi) thì commit hết như cũ.
    const all = await commitWorktree({ dir: wt.dir, message: 'lần 3', scope: { allow: [], mode: 'worker' } });
    assert.deepEqual(all.changedFiles.sort(), ['README.md', 'next-env.d.ts', 'tsconfig.json']);
  } finally {
    removeDir(root);
  }
});

test('outOfScope: luật giống hook chặn file (tiền tố, "!" loại trừ, team tài liệu chưa khai thư mục thì không gì vào nhánh)', () => {
  const files = ['src/app/page.tsx', 'src/app/api/x/route.ts', 'tsconfig.json', 'src/lib/a.ts'];
  assert.deepEqual(outOfScope(files, { allow: ['src/app', '!src/app/api', 'src/lib'], mode: 'worker' }), ['src/app/api/x/route.ts', 'tsconfig.json']);
  assert.deepEqual(outOfScope(files, { allow: [], mode: 'worker' }), []);
  assert.deepEqual(outOfScope(files, { allow: [], mode: 'scoped' }), files);
  assert.deepEqual(outOfScope(files, null), []);
  // File nhân viên tự ghi bằng công cụ thì giữ, dù ngoài phạm vi (hook đã cho ghi): chỉ thứ do lệnh khác sinh ra mới bị bỏ.
  assert.deepEqual(outOfScope(files, { allow: ['src/lib'], mode: 'worker', written: ['tsconfig.json'] }), ['src/app/page.tsx', 'src/app/api/x/route.ts']);
});

test('cơ sở dữ liệu cũ (giai đoạn 1) được nâng cấp thêm các cột mới', () => {
  const root = tmpDir();
  try {
    const file = path.join(root, 'cu.db');
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, prompt TEXT NOT NULL, acceptance TEXT NOT NULL DEFAULT '', team TEXT NOT NULL, member TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, model TEXT, effort TEXT, session_id TEXT, worktree TEXT, branch TEXT, base_commit TEXT, attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT, changed_files TEXT, turns INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0, est_cost_usd REAL NOT NULL DEFAULT 0, resume_at INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER)");
    old.exec("INSERT INTO tasks (title, prompt, team, member, role, status, created_at) VALUES ('cũ', 'p', 'backend', 'An', 'backend-dev', 'done', 1)");
    old.close();
    const store = openDb(file);
    const row = store.getTask(1);
    assert.deepEqual([row.kind, row.job_id, row.revisions, row.level, row.level_source, row.escalations], ['work', null, 0, 'normal', 'user', 0]);
    const job = store.createJob({ title: 'j', prompt: 'p', team: 'backend', lead: 'Minh' });
    assert.equal(job.status, 'planning');
    assert.deepEqual(store.openLoad('An'), []);
    store.close();
  } finally {
    removeDir(root);
  }
});

test('đề bài có bản đồ file: Trưởng nhóm thấy thư mục của team, nhân viên thấy phạm vi việc con; lời nhắc bắt chia việc nhỏ kèm ngân sách lượt', async () => {
  const ctx = await boot({ FAKE_PLAN: plan2(), FAKE_UNIQUE: '1', FAKE_REVIEW: 'approve' });
  try {
    fs.mkdirSync(path.join(ctx.project, 'src', 'a'), { recursive: true });
    fs.writeFileSync(path.join(ctx.project, 'src', 'a', 'cu.js'), '1\n');
    fs.writeFileSync(path.join(ctx.project, 'src', 'khac.js'), '1\n');
    git(ctx.project, 'add', '-A');
    git(ctx.project, 'commit', '-q', '-m', 'có file');
    const job = await newJob(ctx);
    await waitFor(() => ['done', 'attention', 'failed'].includes(ctx.store.getJob(job.id).status), { timeout: 40000, label: 'việc lớn xong' });
    const calls = ctx.calls().filter((c) => !c.isTriage);
    const plan = calls.find((c) => /Bản đồ file thư mục của team/.test(c.prompt));
    assert.ok(plan, 'lượt lập kế hoạch có bản đồ file');
    assert.match(plan.prompt, /- src\/a\/cu\.js\n- src\/khac\.js/);
    const an = calls.find((c) => /Việc của An/.test(c.prompt) && /Bản đồ file trong phạm vi của bạn/.test(c.prompt));
    assert.ok(an, 'đề bài của nhân viên có bản đồ file theo phạm vi việc con');
    assert.match(an.prompt, /- src\/a\/cu\.js/);
    assert.doesNotMatch(an.prompt, /src\/khac\.js/, 'chỉ liệt kê trong phạm vi việc con (src/a), không cả thư mục team');
    const binh = calls.find((c) => /Việc của Bình/.test(c.prompt));
    assert.match(binh.prompt, /- src\/b: chưa có/, 'phạm vi chưa tồn tại thì nói rõ là sẽ tạo');
    const resumed = calls.filter((c) => c.resumed);
    assert.ok(resumed.every((c) => !/Bản đồ file/.test(c.prompt)), 'làm tiếp cùng phiên thì không gửi lại bản đồ');
  } finally {
    await ctx.cleanup();
  }

  const teams = loadTeams({ teamsDir: path.join(REPO, 'teams') });
  const lead = findMember(teams, 'Minh');
  const system = buildLeadSystemPrompt({ member: lead.member, team: lead.team, role: lead.role, project: null, kind: 'plan' });
  assert.match(system, /Việc con phải NHỎ: mỗi việc tối đa khoảng 3 file/);
  assert.match(system, /khoảng 60 lượt cho một việc/, 'ngân sách lượt lấy từ max_turns của vai trò nhân viên');
  assert.match(system, new RegExp(`phạm vi quá ${MAX_SCOPE_ENTRIES} mục sẽ bị từ chối`));
  assert.match(system, /giao các phần đó cho CÙNG một người/);
});
