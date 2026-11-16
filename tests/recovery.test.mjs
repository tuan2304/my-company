import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { ensureDirs } from '../server/config.mjs';
import { openDb } from '../server/db.mjs';
import { diagnose, inferCode } from '../server/diagnose.mjs';
import { startServer } from '../server/index.mjs';
import { loadProject } from '../server/project.mjs';
import { inspectFailure, recoverTask } from '../server/recovery.mjs';
import { Runner, UserError } from '../server/runner.mjs';
import { loadTeams } from '../server/teams.mjs';
import { createWorktree, removeWorktreeKeepBranch } from '../server/worktree.mjs';
import { git, makeProject, removeDir, REPO, testConfig, tmpDir, waitFor } from './helpers.mjs';

const ENV_KEYS = ['FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_SCENARIO'];

async function setup(scenario = 'maxturns') {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg = testConfig(root, project, local);
  ensureDirs(cfg);
  const logFile = path.join(root, 'fake.log');
  Object.assign(process.env, { FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_SCENARIO: scenario });
  const store = openDb(path.join(cfg.dataDir, 'company.db'));
  const teams = loadTeams({ teamsDir: path.join(REPO, 'teams') });
  const runner = new Runner({ cfg, store, getTeams: () => teams, getProject: () => loadProject(local) });
  runner.start();
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const submit = () => runner.submit({ title: 'Tạo hello', prompt: 'Tạo file hello.txt', member: 'An', level: 'normal' });
  const failed = async () => {
    const { id } = await submit();
    return waitFor(() => store.getTask(id).status === 'failed' && store.getTask(id), { label: 'việc lỗi' });
  };
  const cleanup = async () => {
    await runner.shutdown();
    store.close();
    for (const key of ENV_KEYS) delete process.env[key];
    removeDir(root);
  };
  return { root, project, local, cfg, store, runner, calls, submit, failed, cleanup };
}

const flag = (call, name) => call.args[call.args.indexOf(name) + 1];

test('chẩn đoán: mỗi loại lỗi có lời giải thích và phương án đúng với hoàn cảnh', () => {
  const task = (over) => ({ model: 'sonnet', job_id: null, error: '', failure_code: null, ...over });
  const all = { hasWork: true, canResume: true, recoverable: true };

  const turns = diagnose(task({ failure_code: 'max_turns' }), all);
  assert.equal(turns.code, 'max_turns');
  assert.deepEqual(turns.options.map((o) => o.action), ['continue', 'raise', 'redo', 'accept', 'skip']);
  assert.equal(turns.recommended, 'continue');
  assert.match(turns.options.find((o) => o.action === 'raise').label, /opus/);

  // Đã ở bậc cao nhất thì không có "nâng model"; không có phần đã làm thì không có "nhận phần đã làm".
  const top = diagnose(task({ failure_code: 'timeout', model: 'opus' }), { hasWork: false, canResume: true, recoverable: true });
  assert.deepEqual(top.options.map((o) => o.action), ['continue', 'redo', 'skip']);

  // Không còn phiên thì không thể làm tiếp, chỉ làm lại.
  const noSession = diagnose(task({ failure_code: 'crash' }), { hasWork: true, canResume: false, recoverable: true });
  assert.deepEqual(noSession.options.map((o) => o.action), ['redo', 'accept', 'skip']);
  assert.equal(noSession.recommended, 'redo', 'gợi ý phải là hành động đang có thật trong danh sách');

  // Nhân viên đã bị xóa khỏi cấu hình: chỉ còn cách bỏ qua.
  const ghost = diagnose(task({ failure_code: 'no_member' }), all);
  assert.deepEqual(ghost.options.map((o) => o.action), ['skip']);

  // Việc con của việc lớn đã kết thúc: không có hành động nào ngoài việc nhìn, và nói rõ lý do.
  const closed = diagnose(task({ failure_code: 'max_turns' }), { hasWork: true, canResume: true, recoverable: false, blockedReason: 'Việc lớn #3 đã kết thúc' });
  assert.deepEqual(closed.options, []);
  assert.match(closed.blockedReason, /đã kết thúc/);

  // Việc con của việc lớn: "nhận phần đã làm" nghĩa là nộp bài cho Trưởng nhóm duyệt.
  const child = diagnose(task({ failure_code: 'max_turns', job_id: 3 }), all);
  assert.match(child.options.find((o) => o.action === 'accept').hint, /Trưởng nhóm/);
});

test('inferCode đoán được lỗi của dữ liệu cũ (chưa có mã) và rơi về "other" khi lạ', () => {
  assert.equal(inferCode('Quá thời gian cho phép (30 phút).'), 'timeout');
  assert.equal(inferCode('Kết thúc không thành công (error_max_turns, max_turns): '), 'max_turns');
  assert.equal(inferCode('Tiến trình claude thoát bất thường (mã 2).'), 'crash');
  assert.equal(inferCode('Bị trả bài quá 3 lần mà vẫn chưa đạt.'), 'rejected_final');
  assert.equal(inferCode('Trưởng nhóm không đưa ra được kết luận sau hai lượt duyệt.'), 'review_no_verdict');
  assert.equal(inferCode('Lỗi nội bộ: gì đó'), 'internal');
  assert.equal(inferCode('điều chưa từng thấy'), 'other');
  assert.equal(inferCode(null), 'other');
});

test('việc lỗi được ghi mã lỗi và đủ dữ kiện: có phần đã làm, còn phiên để làm tiếp', async () => {
  const ctx = await setup('maxturns');
  try {
    const task = await ctx.failed();
    assert.equal(task.failure_code, 'max_turns');
    const info = await inspectFailure({ store: ctx.store, projectRoot: ctx.project, id: task.id });
    assert.equal(info.diagnosis.code, 'max_turns');
    assert.equal(info.diagnosis.hasWork, true);
    assert.equal(info.diagnosis.canResume, true);
    assert.equal(info.diagnosis.recoverable, true);
    assert.match(info.work.stat, /hello\.txt/);
    assert.match(info.work.patch, /xin chào/);
    assert.deepEqual(info.work.files, ['hello.txt'], 'màn hình lỗi biết còn bài dở gồm file nào');
    assert.ok(info.evidence.some((e) => e.kind === 'error'));
    assert.equal(info.diagnosis.options.length, 5);
  } finally {
    await ctx.cleanup();
  }

  const crash = await setup('crash');
  try {
    const task = await crash.failed();
    assert.equal(task.failure_code, 'crash');
    const info = await inspectFailure({ store: crash.store, projectRoot: crash.project, id: task.id });
    assert.equal(info.diagnosis.hasWork, false, 'crash trước khi sửa gì thì không có phần nào để nhận');
    assert.equal(info.work, null);
    assert.ok(!info.diagnosis.options.some((o) => o.action === 'accept'));
  } finally {
    await crash.cleanup();
  }
});

test('Làm tiếp: cùng phiên (--resume), có lời dặn trong lời nhắc, thêm lượt, rồi xong và xóa dấu vết lỗi', async () => {
  const ctx = await setup('maxturns');
  try {
    const task = await ctx.failed();
    const baseTurns = Number(flag(ctx.calls()[0], '--max-turns')); // số lượt gốc (lần chạy đầu, trước khi hệ thống tự cho làm tiếp)
    process.env.FAKE_CLAUDE_SCENARIO = 'success';
    await recoverTask(ctx.runner, task.id, { action: 'continue', guidance: 'Chỉ sửa hello.txt thôi.' });

    const done = await waitFor(() => ctx.store.getTask(task.id).status === 'done' && ctx.store.getTask(task.id), { label: 'việc xong sau khi làm tiếp' });
    assert.equal(done.recoveries, 1);
    assert.equal(done.error, null);
    assert.equal(done.failure_code, null);
    assert.equal(done.owner_guidance, null, 'lời dặn chỉ dùng một lần');
    assert.equal(done.branch, task.branch, 'làm tiếp thì giữ nguyên nhánh');

    const call = ctx.calls().at(-1);
    assert.equal(call.resumed, true);
    assert.match(call.prompt, /Lời dặn của chủ công ty/);
    assert.match(call.prompt, /Chỉ sửa hello\.txt thôi\./);
    assert.equal(Number(flag(call, '--max-turns')), baseTurns * 2, 'mỗi lần làm tiếp (hệ thống tự + chủ chọn) được thêm một nửa số lượt gốc');
    assert.ok(ctx.store.listEvents(task.id).some((e) => e.kind === 'recover' && /Làm tiếp/.test(e.summary)));
  } finally {
    await ctx.cleanup();
  }
});

test('Nâng model rồi làm tiếp: sonnet lên opus, dùng lại phiên cũ', async () => {
  const ctx = await setup('maxturns');
  try {
    const task = await ctx.failed();
    assert.equal(task.model, 'sonnet');
    process.env.FAKE_CLAUDE_SCENARIO = 'success';
    await recoverTask(ctx.runner, task.id, { action: 'raise' });
    const done = await waitFor(() => ctx.store.getTask(task.id).status === 'done' && ctx.store.getTask(task.id), { label: 'việc xong sau khi nâng model' });
    assert.equal(done.model, 'opus');
    const call = ctx.calls().at(-1);
    assert.equal(flag(call, '--model'), 'opus');
    assert.equal(call.resumed, true);
  } finally {
    await ctx.cleanup();
  }
});

test('Làm lại: nhánh MỚI (nhánh cũ vẫn giữ), thư mục cũ được gỡ, phiên mới, lời dặn đi kèm đề bài gốc', async () => {
  const ctx = await setup('maxturns');
  try {
    const task = await ctx.failed();
    const oldBranch = task.branch;
    const oldDir = task.worktree;
    assert.ok(fs.existsSync(oldDir));
    process.env.FAKE_CLAUDE_SCENARIO = 'success';
    await recoverTask(ctx.runner, task.id, { action: 'redo', guidance: 'Làm gọn hơn.' });

    const done = await waitFor(() => ctx.store.getTask(task.id).status === 'done' && ctx.store.getTask(task.id), { label: 'việc xong sau khi làm lại' });
    assert.notEqual(done.branch, oldBranch);
    assert.equal(done.branch, `${oldBranch}-2`, 'tên nhánh không được trùng nhánh cũ (trước đây trùng tên làm việc làm lại hỏng)');
    assert.equal(git(ctx.project, 'rev-parse', '--verify', oldBranch).length, 40, 'nhánh cũ vẫn còn, phần đã làm cũ không mất');
    assert.equal(fs.existsSync(oldDir), false, 'thư mục làm việc cũ đã được gỡ');
    assert.equal(done.recoveries, 1);

    const call = ctx.calls().at(-1);
    assert.equal(call.resumed, false, 'làm lại là phiên mới');
    assert.match(call.prompt, /Tạo file hello\.txt/);
    assert.match(call.prompt, /Làm gọn hơn\./);
    assert.equal(call.cwd, fs.realpathSync(done.worktree));
  } finally {
    await ctx.cleanup();
  }
});

test('Nhận phần đã làm: việc lẻ thành "xong" với đúng danh sách file, ghi rõ lý do dừng', async () => {
  const ctx = await setup('maxturns');
  try {
    const task = await ctx.failed();
    const result = await recoverTask(ctx.runner, task.id, { action: 'accept' });
    assert.equal(result.status, 'done');
    assert.deepEqual(JSON.parse(result.changed_files), ['hello.txt']);
    assert.match(result.result, /nhận phần nhân viên làm dở/);
    assert.equal(result.error, null);
    assert.equal(result.failure_code, null);
  } finally {
    await ctx.cleanup();
  }
});

test('Bỏ qua: việc dừng hẳn, phần đã làm vẫn còn trên nhánh', async () => {
  const ctx = await setup('maxturns');
  try {
    const task = await ctx.failed();
    const result = await recoverTask(ctx.runner, task.id, { action: 'skip' });
    assert.equal(result.status, 'stopped');
    assert.match(result.error, /bỏ qua/);
    assert.equal(git(ctx.project, 'show', `${task.branch}:hello.txt`), 'xin chào');
  } finally {
    await ctx.cleanup();
  }
});

test('từ chối đúng cách: hành động không có trong danh sách, không có phần để nhận, việc chưa lỗi, lời dặn quá dài, lời dặn cho hành động không nhận', async () => {
  const ctx = await setup('crash');
  try {
    const task = await ctx.failed();
    await assert.rejects(recoverTask(ctx.runner, task.id, { action: 'accept' }), (e) => e instanceof UserError && /Không thể "accept"/.test(e.message));
    await assert.rejects(recoverTask(ctx.runner, task.id, { action: 'xoa-het' }), (e) => e instanceof UserError);
    await assert.rejects(recoverTask(ctx.runner, task.id, { action: undefined }), (e) => e instanceof UserError);
    await assert.rejects(recoverTask(ctx.runner, task.id, { action: 'continue', guidance: 'x'.repeat(2001) }), /quá dài/);
    await assert.rejects(recoverTask(ctx.runner, task.id, { action: 'skip', guidance: 'đừng làm nữa' }), /không nhận lời dặn/);
    await assert.rejects(recoverTask(ctx.runner, 9999, { action: 'skip' }), /Không có việc này/);
    assert.equal(ctx.store.getTask(task.id).status, 'failed', 'các lần từ chối không được làm đổi gì');
    assert.equal(ctx.store.getTask(task.id).recoveries, 0);

    // Việc đã bỏ qua rồi thì không xử lý thêm được.
    await recoverTask(ctx.runner, task.id, { action: 'skip' });
    await assert.rejects(recoverTask(ctx.runner, task.id, { action: 'redo' }), /không ở trạng thái lỗi/);
  } finally {
    await ctx.cleanup();
  }
});

test('bấm đúp: chỉ một lần xử lý được thực hiện', async () => {
  const ctx = await setup('maxturns');
  try {
    const task = await ctx.failed();
    process.env.FAKE_CLAUDE_SCENARIO = 'success';
    const results = await Promise.allSettled([
      recoverTask(ctx.runner, task.id, { action: 'redo' }),
      recoverTask(ctx.runner, task.id, { action: 'redo' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    await waitFor(() => ctx.store.getTask(task.id).status === 'done', { label: 'việc xong' });
    const branches = git(ctx.project, 'branch', '--list', 'company/an-task*').split('\n').map((s) => s.trim().replace(/^[*+]\s*/, ''));
    assert.equal(branches.length, 2, 'đúng một nhánh cũ và một nhánh mới, không sinh thêm');
    assert.equal(ctx.store.getTask(task.id).recoveries, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('việc con của việc lớn: đang chạy hoặc "cần xem" thì xử lý được (cái sau mở lại việc lớn); đã dừng thì không, và nói rõ lý do', async () => {
  const ctx = await setup('maxturns');
  try {
    const job = ctx.store.createJob({ title: 'Việc lớn', prompt: 'p', team: 'backend', lead: 'Minh', status: 'running' });
    const found = { team: { id: 'backend' }, member: { name: 'An' }, role: { id: 'dev', model: 'sonnet', effort: 'medium', title: 'Dev' } };
    const child = ctx.runner.createWork({ found, title: 'Con', prompt: 'p', level: 'normal', jobId: job.id });
    ctx.store.updateTask(child.id, { status: 'failed', error: 'Quá thời gian cho phép (30 phút).', failure_code: 'timeout' });

    const open = await inspectFailure({ store: ctx.store, projectRoot: ctx.project, id: child.id });
    assert.equal(open.diagnosis.recoverable, true);
    assert.equal(open.diagnosis.reopensJob, null, 'việc lớn còn chạy thì không cần mở lại');

    ctx.store.updateJob(job.id, { status: 'attention' });
    const attention = await inspectFailure({ store: ctx.store, projectRoot: ctx.project, id: child.id });
    assert.equal(attention.diagnosis.recoverable, true);
    assert.equal(attention.diagnosis.reopensJob, job.id, 'việc lớn đã kết luận "cần xem" thì được mở lại');

    ctx.store.updateJob(job.id, { status: 'stopped' });
    const closed = await inspectFailure({ store: ctx.store, projectRoot: ctx.project, id: child.id });
    assert.equal(closed.diagnosis.recoverable, false);
    assert.match(closed.diagnosis.blockedReason, /đã dừng/);
    assert.deepEqual(closed.diagnosis.options, []);
    await assert.rejects(recoverTask(ctx.runner, child.id, { action: 'redo' }), /đã dừng/);
  } finally {
    await ctx.cleanup();
  }
});

test('createWorktree không đụng nhánh cũ: tên trùng thì tự thêm đuôi -2, -3', async () => {
  const root = tmpDir();
  try {
    const { project } = makeProject(root);
    const worktreesDir = path.join(root, 'worktrees');
    const one = await createWorktree({ projectRoot: project, worktreesDir, member: 'An', taskId: 7 });
    const two = await createWorktree({ projectRoot: project, worktreesDir, member: 'An', taskId: 7 });
    const three = await createWorktree({ projectRoot: project, worktreesDir, member: 'An', taskId: 7 });
    assert.deepEqual([one.branch, two.branch, three.branch], ['company/an-task7', 'company/an-task7-2', 'company/an-task7-3']);
    assert.equal(new Set([one.dir, two.dir, three.dir]).size, 3);
    assert.ok([one, two, three].every((w) => fs.existsSync(w.dir)));
  } finally {
    removeDir(root);
  }
});

test('gỡ worktree không bao giờ xóa nội dung thật của dự án qua liên kết (node_modules), và chỉ gỡ thư mục nằm trong worktreesDir', async () => {
  const root = tmpDir();
  try {
    const { project } = makeProject(root);
    fs.mkdirSync(path.join(project, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(project, 'node_modules', 'pkg', 'index.js'), 'quan trọng\n');
    const worktreesDir = path.join(root, 'worktrees');
    const wt = await createWorktree({ projectRoot: project, worktreesDir, member: 'An', taskId: 1, links: ['node_modules'] });
    assert.deepEqual(wt.linked, ['node_modules']);
    fs.writeFileSync(path.join(wt.dir, 'dang-lam.txt'), 'chưa commit\n');

    // Từ chối gỡ thư mục ngoài worktreesDir (kể cả chính dự án).
    assert.equal(await removeWorktreeKeepBranch({ projectRoot: project, worktreesDir, dir: project }), false);
    assert.equal(await removeWorktreeKeepBranch({ projectRoot: project, worktreesDir, dir: worktreesDir }), false);
    assert.equal(await removeWorktreeKeepBranch({ projectRoot: project, worktreesDir, dir: path.join(worktreesDir, '..', 'proj') }), false);
    assert.ok(fs.existsSync(path.join(project, 'README.md')));

    assert.equal(await removeWorktreeKeepBranch({ projectRoot: project, worktreesDir, dir: wt.dir }), true);
    assert.equal(fs.existsSync(wt.dir), false);
    assert.equal(fs.readFileSync(path.join(project, 'node_modules', 'pkg', 'index.js'), 'utf8').replace(/\r\n/g, '\n'), 'quan trọng\n', 'nội dung thật của dự án phải còn nguyên');
    assert.equal(git(project, 'rev-parse', '--verify', wt.branch).length, 40, 'nhánh được giữ');
    assert.equal(git(project, 'worktree', 'list', '--porcelain').includes(wt.dir.split('\\').join('/')), false, 'git không còn nhớ thư mục đã gỡ');
  } finally {
    removeDir(root);
  }
});

function request(port, { method = 'GET', path: urlPath, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* không phải JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('API: GET /recovery cho chẩn đoán, POST /recover thực hiện (kiểm tra nguồn), 400 khi lựa chọn không hợp lệ', async () => {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  Object.assign(process.env, { FAKE_CLAUDE_SCENARIO: 'maxturns' });
  const app = await startServer({ cfg: testConfig(root, project, local), withUi: false, log: () => {} });
  try {
    const { id } = await app.runner.submit({ title: 'T', prompt: 'p', member: 'An', level: 'normal' });
    await waitFor(() => app.store.getTask(id).status === 'failed', { label: 'việc lỗi' });
    const host = { host: `localhost:${app.port}` };
    const json = { ...host, 'content-type': 'application/json' };

    const info = await request(app.port, { path: `/api/tasks/${id}/recovery`, headers: host });
    assert.equal(info.status, 200);
    assert.equal(info.json.diagnosis.code, 'max_turns');
    assert.ok(info.json.diagnosis.options.length >= 4);
    assert.match(info.json.work.stat, /hello\.txt/);

    const evil = await request(app.port, { method: 'POST', path: `/api/tasks/${id}/recover`, body: JSON.stringify({ action: 'skip' }), headers: { ...json, origin: 'https://evil.example.com' } });
    assert.equal(evil.status, 403, 'trang web lạ không được tự bấm xử lý việc lỗi');
    assert.equal(app.store.getTask(id).status, 'failed');

    const bad = await request(app.port, { method: 'POST', path: `/api/tasks/${id}/recover`, body: JSON.stringify({ action: 'doi-ten-lua' }), headers: json });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Không thể/);

    const ok = await request(app.port, { method: 'POST', path: `/api/tasks/${id}/recover`, body: JSON.stringify({ action: 'skip' }), headers: json });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.task.status, 'stopped');

    const none = await request(app.port, { path: '/api/tasks/9999/recovery', headers: host });
    assert.equal(none.status, 400);
  } finally {
    await app.close();
    for (const key of ENV_KEYS) delete process.env[key];
    removeDir(root);
  }
});

// ---------- Tự thử lại một lần ----------

test('tiến trình tự thoát: tự làm tiếp đúng phiên cũ MỘT lần rồi xong, chủ không phải làm gì', async () => {
  const ctx = await setup('crash_once');
  try {
    const { id } = await ctx.submit();
    const done = await waitFor(() => ctx.store.getTask(id).status === 'done' && ctx.store.getTask(id), { label: 'việc xong sau khi tự thử lại' });
    assert.equal(done.attempts, 2);
    assert.equal(done.auto_retries, 1);
    assert.equal(done.recoveries, 0, 'đây là tự thử lại, không tính là chủ cho làm tiếp');
    assert.equal(done.failure_code, null);
    const [first, second] = ctx.calls();
    assert.equal(first.resumed, false);
    assert.equal(second.resumed, true, 'tự thử lại phải dùng lại phiên cũ');
    assert.ok(ctx.store.listEvents(id).some((e) => e.kind === 'warn' && /Tự thử lại một lần/.test(e.summary)));
  } finally {
    await ctx.cleanup();
  }
});

test('lỗi lặp lại sau lần tự thử: dừng ở "lỗi" (không thử vô hạn) và chờ chủ quyết', async () => {
  const ctx = await setup('crash');
  try {
    const task = await ctx.failed();
    assert.equal(task.auto_retries, 1);
    assert.equal(task.attempts, 2, 'chạy đúng hai lần: lần đầu và một lần tự thử');
    assert.equal(task.failure_code, 'crash');
    assert.equal(ctx.calls().length, 2);
  } finally {
    await ctx.cleanup();
  }
});

test('hết số lượt thì không "tự thử lại" phiên mới (tốn hạn mức vô ích) mà "tự làm tiếp" cùng phiên đúng một lần', async () => {
  const ctx = await setup('maxturns');
  try {
    const task = await ctx.failed();
    assert.equal(task.auto_retries, 0);
    assert.equal(task.auto_continues, 1);
    assert.equal(task.attempts, 2);
    assert.equal(ctx.calls().length, 2);
    assert.equal(ctx.calls()[1].resumed, true, 'lần hai nối phiên cũ');
  } finally {
    await ctx.cleanup();
  }
});

test('tự thử lại có chờ: trong lúc chờ việc ở trạng thái xếp hàng và chưa chạy lần hai', async () => {
  const ctx = await setup('crash');
  ctx.cfg.autoRetryDelayMs = 60_000;
  try {
    const { id } = await ctx.submit();
    const queued = await waitFor(() => {
      const t = ctx.store.getTask(id);
      return t.auto_retries === 1 && t.status === 'queued' && t;
    }, { label: 'việc chờ tự thử lại' });
    assert.ok(queued.resume_at > Date.now() + 30_000, 'có giờ hẹn làm tiếp ở tương lai');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(ctx.calls().length, 1, 'chưa chạy lần hai khi chưa tới giờ');
    assert.ok(ctx.runner.stop(id), 'chủ vẫn dừng được việc đang chờ');
    assert.equal(ctx.store.getTask(id).status, 'stopped');
  } finally {
    await ctx.cleanup();
  }
});
