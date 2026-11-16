import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { startServer } from '../server/index.mjs';
import { inspectFailure, recoverTask } from '../server/recovery.mjs';
import { UserError } from '../server/runner.mjs';
import { git, makeProject, removeDir, testConfig, tmpDir, waitFor } from './helpers.mjs';

const FAKE_KEYS = ['FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_SCENARIO', 'FAKE_PLAN', 'FAKE_REVIEW', 'FAKE_REVIEW_MAP', 'FAKE_UNIQUE'];

async function boot(env = {}) {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg = testConfig(root, project, local);
  Object.assign(process.env, { FAKE_CLAUDE_LOG: path.join(root, 'fake.log'), ...env });
  const app = await startServer({ cfg, withUi: false, log: () => {} });
  const cleanup = async () => {
    await app.close();
    for (const key of FAKE_KEYS) delete process.env[key];
    removeDir(root);
  };
  return { root, project, cfg, app, runner: app.runner, store: app.store, cleanup };
}

const plan2 = () => JSON.stringify([
  { member: 'An', title: 'Việc của An', description: 'Làm phần A', acceptance: 'test chạy qua', files: ['src/a'], level: 'normal' },
  { member: 'Bình', title: 'Việc của Bình', description: 'Làm phần B', acceptance: 'test chạy qua', files: ['src/b'], level: 'normal' },
]);
const newJob = (ctx) => ctx.runner.jobs.create({ team: 'backend', title: 'Làm tính năng X', prompt: 'Chia việc giúp tôi' });
const jobIn = (ctx, id, statuses) => waitFor(() => statuses.includes(ctx.store.getJob(id).status) && ctx.store.getJob(id), { timeout: 40000, label: `việc lớn #${id}` });
const lsTree = (ctx, branch) => git(ctx.project, 'ls-tree', '-r', '--name-only', branch).split('\n');
const outFile = (task) => `out-${path.basename(task.worktree)}.txt`;
const foundAn = { team: { id: 'backend' }, member: { name: 'An' }, role: { id: 'dev', model: 'sonnet', effort: 'medium', title: 'Dev' } };

/** Việc lớn mà bài của An bị trả hết lượt (lỗi), bài của Bình đạt: việc lớn kết thúc ở "cần xem". */
async function jobWithFailedChild() {
  const ctx = await boot({ FAKE_PLAN: plan2(), FAKE_UNIQUE: '1', FAKE_REVIEW: 'approve', FAKE_REVIEW_MAP: JSON.stringify({ 2: 'reject_always' }) });
  const job = await newJob(ctx);
  const attention = await jobIn(ctx, job.id, ['attention']);
  const [, an, binh] = ctx.store.jobTasks(job.id);
  assert.equal(an.status, 'failed');
  assert.equal(an.failure_code, 'rejected_final');
  return { ctx, job, attention, an, binh };
}

test('việc con lỗi, việc lớn đã kết thúc: mở lại việc lớn, nhận bài, Trưởng nhóm duyệt, gộp lại sang nhánh MỚI chứa cả hai phần', async () => {
  const { ctx, job, attention, an, binh } = await jobWithFailedChild();
  try {
    assert.equal(attention.merge_branch, `company/job${job.id}`);
    const info = await inspectFailure({ store: ctx.store, projectRoot: ctx.project, id: an.id });
    assert.equal(info.diagnosis.recoverable, true);
    assert.equal(info.diagnosis.reopensJob, job.id);
    assert.deepEqual(info.diagnosis.options.map((o) => o.action), ['continue', 'raise', 'redo', 'accept', 'skip']);

    // Trưởng nhóm nay duyệt đạt (chủ đã nhận phần của An và bài được duyệt lại).
    process.env.FAKE_REVIEW_MAP = '{}';
    await recoverTask(ctx.runner, an.id, { action: 'accept' });
    const done = await waitFor(() => ctx.store.getJob(job.id).merge_branch === `company/job${job.id}-2` && ctx.store.getJob(job.id), { timeout: 40000, label: 'gộp lại' });
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(git(ctx.project, 'rev-parse', '--verify', attention.merge_branch).length, 40, 'nhánh gộp cũ vẫn giữ');
    const merged = lsTree(ctx, done.merge_branch);
    assert.ok(merged.includes(outFile(an)) && merged.includes(outFile(binh)), 'nhánh mới có đủ phần của cả hai người');
    assert.equal(ctx.store.getTask(an.id).status, 'done');
    assert.equal(done.conflict_files, null);
  } finally {
    await ctx.cleanup();
  }
});

test('việc con lỗi: chủ bỏ qua thì việc lớn kết luận lại với phần còn lại, nhánh gộp mới không có phần đã bỏ', async () => {
  const { ctx, job, attention, an, binh } = await jobWithFailedChild();
  try {
    await recoverTask(ctx.runner, an.id, { action: 'skip' });
    const final = await waitFor(() => ctx.store.getJob(job.id).merge_branch === `company/job${job.id}-2` && ctx.store.getJob(job.id), { timeout: 40000, label: 'gộp lại' });
    assert.equal(final.status, 'attention');
    assert.equal(ctx.store.getTask(an.id).status, 'stopped');
    const merged = lsTree(ctx, final.merge_branch);
    assert.ok(merged.includes(outFile(binh)));
    assert.ok(!merged.includes(outFile(an)));
    assert.equal(git(ctx.project, 'rev-parse', '--verify', attention.merge_branch).length, 40);
  } finally {
    await ctx.cleanup();
  }
});

test('việc con lỗi: "Làm lại" tạo nhánh mới cho việc con và việc lớn chạy lại cho tới khi xong', async () => {
  const { ctx, job, an } = await jobWithFailedChild();
  try {
    process.env.FAKE_REVIEW_MAP = '{}';
    await recoverTask(ctx.runner, an.id, { action: 'redo', guidance: 'Làm đủ test lần này.' });
    const done = await waitFor(() => ctx.store.getJob(job.id).status === 'done' && ctx.store.getJob(job.id), { timeout: 40000, label: 'việc lớn xong sau khi làm lại' });
    const redone = ctx.store.getTask(an.id);
    assert.equal(redone.status, 'done');
    assert.equal(redone.branch, `company/an-task${an.id}-2`);
    assert.equal(redone.recoveries, 1);
    assert.equal(done.merge_branch, `company/job${job.id}-2`);
  } finally {
    await ctx.cleanup();
  }
});

test('việc con của việc lớn thuộc một yêu cầu: chỉ xem được lỗi, không xử lý riêng (Giám đốc điều phối); việc lớn đã xong/dừng cũng vậy', async () => {
  const ctx = await boot();
  try {
    const fail = (jobId) => {
      const t = ctx.runner.createWork({ found: foundAn, title: `Con ${jobId}`, prompt: 'p', level: 'normal', jobId });
      return ctx.store.updateTask(t.id, { status: 'failed', error: 'Quá thời gian cho phép (30 phút).', failure_code: 'timeout' });
    };
    const epic = ctx.store.createEpic({ title: 'Yêu cầu', prompt: 'p', director: 'Giám đốc' });
    const inEpic = fail(ctx.store.createJob({ title: 'J1', prompt: 'p', team: 'backend', lead: 'Minh', status: 'attention', epicId: epic.id }).id);
    const stopped = fail(ctx.store.createJob({ title: 'J2', prompt: 'p', team: 'backend', lead: 'Minh', status: 'stopped' }).id);
    const finished = fail(ctx.store.createJob({ title: 'J3', prompt: 'p', team: 'backend', lead: 'Minh', status: 'done' }).id);
    for (const [task, pattern] of [[inEpic, /yêu cầu/], [stopped, /dừng/], [finished, /xong/]]) {
      const info = await inspectFailure({ store: ctx.store, projectRoot: ctx.project, id: task.id });
      assert.equal(info.diagnosis.recoverable, false);
      assert.match(info.diagnosis.blockedReason, pattern);
      await assert.rejects(recoverTask(ctx.runner, task.id, { action: 'redo' }), (e) => e instanceof UserError && pattern.test(e.message));
    }
    assert.equal(ctx.store.getEpic(epic.id).status, 'planning', 'không đụng tới yêu cầu');
    await assert.rejects(ctx.runner.jobs.reopen(inEpic.job_id), /không mở lại được/);
    await assert.rejects(ctx.runner.jobs.reopen(finished.job_id), /không mở lại được/);
    await assert.rejects(ctx.runner.jobs.reopen(99999), /Không có việc lớn/);
  } finally {
    await ctx.cleanup();
  }
});

test('lập kế hoạch lại: việc lớn lỗi vì chưa chia được việc thì Trưởng nhóm lập kế hoạch lại và chạy tới khi xong', async () => {
  const ctx = await boot({ FAKE_PLAN: '[]', FAKE_UNIQUE: '1', FAKE_REVIEW: 'approve' });
  try {
    const job = await newJob(ctx);
    const failed = await jobIn(ctx, job.id, ['failed']);
    assert.match(failed.error, /không chia ra việc nào/);

    process.env.FAKE_PLAN = plan2();
    const replanned = ctx.runner.jobs.replan(job.id);
    assert.equal(replanned.status, 'planning');
    assert.equal(replanned.error, null);
    const done = await jobIn(ctx, job.id, ['done', 'attention', 'failed']);
    assert.equal(done.status, 'done', done.error ?? '');
    const tasks = ctx.store.jobTasks(job.id);
    assert.equal(tasks.filter((t) => t.kind === 'plan').length, 2, 'lượt lập kế hoạch cũ vẫn còn trong lịch sử');
    assert.equal(tasks.filter((t) => t.kind === 'work').length, 2);
    assert.equal(done.plan_task_id, tasks.filter((t) => t.kind === 'plan')[1].id);
  } finally {
    await ctx.cleanup();
  }
});

test('lập kế hoạch lại bị từ chối đúng chỗ: việc lớn chưa lỗi, đã có việc con, thuộc yêu cầu, không có', async () => {
  const ctx = await boot({ FAKE_PLAN: '[]' });
  try {
    const job = await newJob(ctx);
    await jobIn(ctx, job.id, ['failed']);
    const running = ctx.store.createJob({ title: 'J', prompt: 'p', team: 'backend', lead: 'Minh', status: 'running' });
    assert.throws(() => ctx.runner.jobs.replan(running.id), /trạng thái lỗi/);
    assert.throws(() => ctx.runner.jobs.replan(99999), /Không có việc lớn/);
    const epic = ctx.store.createEpic({ title: 'E', prompt: 'p', director: 'Giám đốc' });
    const inEpic = ctx.store.createJob({ title: 'K', prompt: 'p', team: 'backend', lead: 'Minh', status: 'failed', epicId: epic.id });
    // Việc lớn của yêu cầu chỉ lập lại được khi yêu cầu cho phép (đang chạy, cần xem hoặc lỗi); yêu cầu đang lập kế hoạch thì không.
    assert.throws(() => ctx.runner.jobs.replan(inEpic.id), /thuộc yêu cầu #\d+ .*chưa mở lại riêng được/);
    assert.equal(ctx.store.getEpic(epic.id).status, 'planning', 'yêu cầu không bị đụng tới');
    const withWork = ctx.store.createJob({ title: 'L', prompt: 'p', team: 'backend', lead: 'Minh', status: 'failed' });
    ctx.runner.createWork({ found: foundAn, title: 'Con', prompt: 'p', level: 'normal', jobId: withWork.id });
    assert.throws(() => ctx.runner.jobs.replan(withWork.id), /đã có việc con/);
    assert.equal(ctx.store.getJob(running.id).status, 'running', 'các lần từ chối không đổi gì');
  } finally {
    await ctx.cleanup();
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

test('API: POST /api/jobs/:id/replan có kiểm tra nguồn; 400 khi không lập lại được', async () => {
  const ctx = await boot({ FAKE_PLAN: '[]' });
  try {
    const job = await newJob(ctx);
    await jobIn(ctx, job.id, ['failed']);
    const port = ctx.app.port;
    const json = { host: `localhost:${port}`, 'content-type': 'application/json' };
    const url = `/api/jobs/${job.id}/replan`;
    const evil = await request(port, { method: 'POST', path: url, body: '{}', headers: { ...json, origin: 'https://evil.example.com' } });
    assert.equal(evil.status, 403);
    assert.equal(ctx.store.getJob(job.id).status, 'failed');
    const ok = await request(port, { method: 'POST', path: url, body: '{}', headers: json });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.job.status, 'planning');
    const again = await request(port, { method: 'POST', path: url, body: '{}', headers: json });
    assert.equal(again.status, 400, 'bấm lần hai khi đã đang lập kế hoạch thì bị từ chối');
    await jobIn(ctx, job.id, ['failed', 'done', 'attention']);
  } finally {
    await ctx.cleanup();
  }
});

const onePlan = () => JSON.stringify([{ member: 'An', title: 'Việc của An', description: 'Làm phần A', acceptance: 'test chạy qua', files: ['src/a'], level: 'normal' }]);
const calls = (ctx) => {
  const file = path.join(ctx.root, 'fake.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

test('hết lượt hai lần mà đã có file: hệ thống tự cho làm tiếp một lần rồi nộp bài "chưa xong"; Trưởng nhóm thấy cảnh báo và duyệt được', async () => {
  const ctx = await boot({ FAKE_PLAN: onePlan(), FAKE_UNIQUE: '1', FAKE_REVIEW: 'approve', FAKE_CLAUDE_SCENARIO: 'maxturns' });
  try {
    const job = await newJob(ctx);
    const done = await jobIn(ctx, job.id, ['done', 'attention', 'failed']);
    assert.equal(done.status, 'done', done.error ?? '');
    const an = ctx.store.jobTasks(job.id).find((t) => t.kind === 'work');
    assert.deepEqual([an.status, an.partial, an.auto_continues, an.failure_code], ['done', 1, 1, 'max_turns']);
    assert.deepEqual(JSON.parse(an.changed_files), [outFile(an)]);
    assert.match(an.result, /BÀI NỘP CHƯA XONG/);
    const events = ctx.store.listEvents(an.id).map((e) => e.summary);
    assert.ok(events.some((s) => /Tự cho làm tiếp một lần/.test(s)));
    assert.ok(events.some((s) => /Đã nộp phần đã làm \(1 file\)/.test(s)));
    const review = calls(ctx).find((c) => /BÀI NỘP CHƯA XONG \(hệ thống nộp thay\)/.test(c.prompt));
    assert.ok(review, 'Trưởng nhóm được báo đây là bài chưa xong');
    assert.ok(git(ctx.project, 'ls-tree', '-r', '--name-only', done.merge_branch).split('\n').includes(outFile(an)), 'phần đã làm được gộp');
  } finally {
    await ctx.cleanup();
  }
});

test('việc con chết (tiến trình thoát) hai lần: tự giao lại một lần cho người khác còn chỗ, phiên mới, kèm ghi chú; vẫn chết thì mới lỗi', async () => {
  const ctx = await boot({ FAKE_PLAN: onePlan(), FAKE_UNIQUE: '1', FAKE_CLAUDE_SCENARIO: 'crash' });
  try {
    const job = await newJob(ctx);
    const final = await jobIn(ctx, job.id, ['done', 'attention', 'failed']);
    assert.equal(final.status, 'failed');
    const task = ctx.store.jobTasks(job.id).find((t) => t.kind === 'work');
    assert.equal(task.status, 'failed');
    assert.equal(task.reassigns, 1);
    assert.notEqual(task.member, 'An', 'giao cho người khác trong team');
    assert.equal(task.role, 'backend-dev');
    assert.equal(task.attempts, 4, 'An 2 lần (tự thử lại), người mới 2 lần');
    const events = ctx.store.listEvents(task.id).map((e) => e.summary);
    assert.ok(events.some((s) => new RegExp(`tự giao lại cho ${task.member} làm từ đầu`).test(s)));
    const handed = calls(ctx).find((c) => /Ghi chú của hệ thống về lần làm trước/.test(c.prompt));
    assert.ok(handed && /do An làm\) bị dừng vì lỗi/.test(handed.prompt), 'người mới được báo lý do lần trước lỗi');
    assert.equal(ctx.store.getTask(task.id).system_note, null, 'ghi chú dùng xong thì xóa');
  } finally {
    await ctx.cleanup();
  }
});

test('việc con báo có file mà nhánh trống: không đưa cho Trưởng nhóm duyệt, đánh lỗi no_changes để chủ xử lý', async () => {
  const ctx = await boot({ FAKE_PLAN: onePlan(), FAKE_UNIQUE: '1', FAKE_CLAUDE_SCENARIO: 'claim_only' });
  try {
    const job = await newJob(ctx);
    const final = await jobIn(ctx, job.id, ['done', 'attention', 'failed']);
    assert.notEqual(final.status, 'done');
    const tasks = ctx.store.jobTasks(job.id);
    const work = tasks.find((t) => t.kind === 'work');
    assert.equal(work.status, 'failed');
    assert.equal(work.failure_code, 'no_changes');
    assert.equal(work.reassigns, 0, 'lỗi này thường do môi trường, giao người khác cũng vậy: để chủ xem');
    assert.equal(tasks.filter((t) => t.kind === 'review').length, 0, 'Trưởng nhóm không phải duyệt bài rỗng');
    const info = await inspectFailure({ store: ctx.store, projectRoot: ctx.project, id: work.id });
    assert.match(info.diagnosis.title, /nhánh trống/);
    assert.equal(info.diagnosis.hasWork, false);
  } finally {
    await ctx.cleanup();
  }
});
