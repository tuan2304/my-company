import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { inspectEpicFailure, recoverEpic } from '../server/epic-recovery.mjs';
import { startServer } from '../server/index.mjs';
import { inspectFailure, recoverTask } from '../server/recovery.mjs';
import { UserError } from '../server/runner.mjs';
import { git, makeProject, removeDir, testConfig, tmpDir, waitFor } from './helpers.mjs';

const FAKE_KEYS = [
  'FAKE_CLAUDE_LOG', 'FAKE_PLANS', 'FAKE_REVIEW', 'FAKE_REVIEW_MAP', 'FAKE_UNIQUE', 'FAKE_CONFLICT', 'FAKE_DPLAN', 'FAKE_DREVIEW', 'FAKE_LEAD_FAIL',
];

async function boot(env = {}, overrides = {}) {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg = testConfig(root, project, local, overrides);
  const logFile = path.join(root, 'fake.log');
  Object.assign(process.env, { FAKE_CLAUDE_LOG: logFile, FAKE_UNIQUE: '1', ...env });
  const app = await startServer({ cfg, withUi: false, log: () => {} });
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const ctx = { root, project, cfg, app, runner: app.runner, store: app.store, calls };
  ctx.cleanup = async () => {
    await ctx.app.close();
    for (const key of FAKE_KEYS) delete process.env[key];
    removeDir(root);
  };
  // Tắt máy chủ rồi bật lại trên cùng dữ liệu (như chủ tắt máy rồi chạy lại npm start).
  ctx.restart = async () => {
    await ctx.app.close();
    ctx.app = await startServer({ cfg, withUi: false, log: () => {} });
    ctx.runner = ctx.app.runner;
    ctx.store = ctx.app.store;
  };
  return ctx;
}

const flag = (call, name) => call.args[call.args.indexOf(name) + 1];
const backendOnly = JSON.stringify({ backend: [{ member: 'An', title: 'Làm API', description: 'Làm API', acceptance: 'test qua', files: ['src/api'], level: 'normal' }] });
const teamPlans = JSON.stringify({
  backend: [{ member: 'An', title: 'Làm API', description: 'Làm API', acceptance: 'test qua', files: ['src/api'], level: 'normal' }],
  frontend: [{ member: 'Cúc', title: 'Làm giao diện', description: 'Làm giao diện', acceptance: 'test qua', files: ['src/ui'], level: 'normal' }],
  quality: [{ member: 'Quân', title: 'Viết test', description: 'Test trên mã đã ghép', acceptance: 'test qua', files: ['test/int'], level: 'normal' }],
});
const oneJob = () => JSON.stringify({ jobs: [{ team: 'backend', title: 'API đăng nhập', description: 'Làm API đăng nhập', acceptance: 'test qua' }] });
const twoJobs = () => JSON.stringify({
  jobs: [
    { team: 'backend', title: 'API đăng nhập', description: 'Làm API đăng nhập', acceptance: 'test qua' },
    { team: 'frontend', title: 'Màn hình đăng nhập', description: 'Làm màn hình', acceptance: 'test qua' },
  ],
});
const threeJobs = () => JSON.stringify({
  contract: 'POST /api/login nhận {"email","password"}, trả {"token"} khi đúng; 401 {"error"} khi sai.',
  jobs: [
    { team: 'backend', title: 'API đăng nhập', description: 'Làm API đăng nhập', acceptance: 'test qua' },
    { team: 'frontend', title: 'Màn hình đăng nhập', description: 'Làm màn hình', acceptance: 'test qua' },
    { team: 'quality', title: 'Test đăng nhập', description: 'Test tích hợp', acceptance: 'test qua', depends_on: ['API đăng nhập', 'Màn hình đăng nhập'] },
  ],
});
const newEpic = (ctx) => ctx.runner.epics.create({ title: 'Đăng nhập bằng email', prompt: 'Thêm tính năng đăng nhập bằng email' });
const epicIn = (ctx, id, statuses) => waitFor(() => statuses.includes(ctx.store.getEpic(id).status) && ctx.store.getEpic(id), { timeout: 90000, label: `yêu cầu #${id} đạt ${statuses.join('/')}` });
const dirTasks = (ctx, id, kind) => ctx.store.epicTasks(id).filter((t) => t.kind === kind);
const outFile = (task) => `out-${path.basename(task.worktree)}.txt`;
const actions = (info) => info.diagnosis.options.map((o) => o.action);
const info = (ctx, id) => inspectEpicFailure({ store: ctx.store, projectRoot: ctx.project, id });

test('Giám đốc lập kế hoạch lỗi: yêu cầu "lỗi"; chọn Làm tiếp kèm lời dặn thì chạy lại đúng lượt đó, tiếp phiên cũ, có thêm lượt', async () => {
  const ctx = await boot({ FAKE_LEAD_FAIL: 'dplan', FAKE_DPLAN: oneJob(), FAKE_PLANS: teamPlans });
  try {
    const epic = await newEpic(ctx);
    const failed = await epicIn(ctx, epic.id, ['failed']);
    assert.match(failed.error, /lỗi khi lập kế hoạch/);
    const run = dirTasks(ctx, epic.id, 'dplan')[0];
    assert.equal(run.status, 'failed');
    assert.equal(run.failure_code, 'crash');

    const before = await info(ctx, epic.id);
    assert.equal(before.diagnosis.code, 'plan_failed');
    assert.equal(before.diagnosis.recoverable, true);
    assert.match(before.diagnosis.title, /Giám đốc không lập được kế hoạch/);
    assert.deepEqual(actions(before), ['continue', 'redo']);
    assert.equal(before.diagnosis.recommended, 'continue');
    assert.ok(before.evidence.some((e) => e.kind === 'error'), 'có dòng nhật ký lỗi làm bằng chứng');

    delete process.env.FAKE_LEAD_FAIL;
    const after = await recoverEpic(ctx.runner, epic.id, { action: 'continue', guidance: 'Chỉ giao việc cho backend.' });
    assert.equal(after.status, 'planning');
    assert.equal(after.error, null);
    const planned = await epicIn(ctx, epic.id, ['awaiting_plan', 'failed']);
    assert.equal(planned.status, 'awaiting_plan', planned.error ?? '');

    const runs = dirTasks(ctx, epic.id, 'dplan');
    assert.equal(runs.length, 1, 'cùng một lượt được chạy lại, không đẻ thêm lượt');
    assert.equal(runs[0].id, run.id);
    assert.equal(runs[0].recoveries, 1);
    assert.equal(runs[0].owner_guidance, null, 'lời dặn đã giao thì xóa');
    const planCalls = ctx.calls().filter((c) => flag(c, '--allowedTools')?.includes('set_contract'));
    assert.equal(planCalls.length, 2);
    assert.equal(planCalls[1].resumed, true, 'làm tiếp phiên cũ');
    assert.match(planCalls[1].prompt, /Lời dặn của chủ công ty[\s\S]*Chỉ giao việc cho backend/);
    assert.equal(Number(flag(planCalls[1], '--max-turns')), Math.ceil(Number(flag(planCalls[0], '--max-turns')) * 1.5), 'có thêm một nửa số lượt');
  } finally {
    await ctx.cleanup();
  }
});

test('Giám đốc lập kế hoạch xong mà không giao việc nào: yêu cầu "lỗi"; chọn Chạy lại từ đầu thì phiên mới và đi tiếp tới khi chờ duyệt', async () => {
  const ctx = await boot({ FAKE_DPLAN: '{"jobs":[]}', FAKE_PLANS: teamPlans });
  try {
    const epic = await newEpic(ctx);
    const failed = await epicIn(ctx, epic.id, ['failed']);
    assert.match(failed.error, /không chia ra việc nào/);
    assert.equal(dirTasks(ctx, epic.id, 'dplan')[0].status, 'done');

    const before = await info(ctx, epic.id);
    assert.equal(before.diagnosis.code, 'plan_empty');
    assert.match(before.diagnosis.title, /chưa giao việc nào/);
    assert.deepEqual(actions(before), ['continue', 'redo']);

    process.env.FAKE_DPLAN = oneJob();
    await recoverEpic(ctx.runner, epic.id, { action: 'redo', guidance: 'Giao việc cho team backend.' });
    assert.equal((await epicIn(ctx, epic.id, ['awaiting_plan', 'failed'])).status, 'awaiting_plan');
    const last = ctx.calls().filter((c) => flag(c, '--allowedTools')?.includes('set_contract')).at(-1);
    assert.equal(last.resumed, false, 'chạy lại từ đầu: không tiếp phiên cũ');
    assert.match(last.prompt, /Lời dặn của chủ công ty[\s\S]*Giao việc cho team backend/);
    assert.equal(ctx.store.epicJobs(epic.id).length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('Giám đốc kiểm tra mà không kết luận: yêu cầu "cần xem"; Nâng model rồi chạy lại thì kiểm tra xong và chờ duyệt', async () => {
  const ctx = await boot({ FAKE_LEAD_FAIL: 'dreview', FAKE_DPLAN: oneJob(), FAKE_PLANS: teamPlans });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    const stuck = await epicIn(ctx, epic.id, ['attention', 'awaiting_result']);
    assert.equal(stuck.status, 'attention');
    assert.match(stuck.error, /sau hai lượt kiểm tra/);
    assert.equal(dirTasks(ctx, epic.id, 'dreview').length, 2);

    const before = await info(ctx, epic.id);
    assert.equal(before.diagnosis.code, 'review_failed');
    assert.match(before.diagnosis.title, /Giám đốc không kiểm tra xong/);
    assert.deepEqual(actions(before), ['continue', 'raise', 'redo']);

    const run = dirTasks(ctx, epic.id, 'dreview').at(-1);
    delete process.env.FAKE_LEAD_FAIL;
    const reopened = await recoverEpic(ctx.runner, epic.id, { action: 'raise', guidance: 'Phải kết luận bằng finish_epic.' });
    assert.equal(reopened.status, 'reviewing');
    const done = await epicIn(ctx, epic.id, ['awaiting_result', 'attention']);
    assert.equal(done.status, 'awaiting_result', done.error ?? '');
    assert.equal(done.verdict, 'accept');
    const rerun = ctx.store.getTask(run.id);
    assert.notEqual(rerun.model, run.model, 'đã nâng model');
    assert.equal(dirTasks(ctx, epic.id, 'dreview').length, 2, 'không đẻ thêm lượt');
  } finally {
    await ctx.cleanup();
  }
});

test('việc con lỗi kéo cả chuỗi việc lớn lỗi: cứu việc con thì yêu cầu mở lại, việc phụ thuộc chạy tiếp, ghép lại và chờ duyệt', async () => {
  // maxConcurrent 1 để số thứ tự việc cố định: dplan #1, plan #2 (backend) #3 (frontend), việc của An #4, của Cúc #5.
  const ctx = await boot(
    { FAKE_DPLAN: threeJobs(), FAKE_PLANS: teamPlans, FAKE_REVIEW: 'approve', FAKE_REVIEW_MAP: JSON.stringify({ 4: 'reject_always' }) },
    { maxConcurrent: 1 },
  );
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    const stuck = await epicIn(ctx, epic.id, ['attention', 'awaiting_result']);
    assert.equal(stuck.status, 'attention');
    const [api, ui, qa] = ctx.store.epicJobs(epic.id);
    const an = ctx.store.getTask(4);
    assert.deepEqual([an.kind, an.member], ['work', 'An'], 'giả định về số thứ tự việc');
    assert.deepEqual([api.status, ui.status, qa.status], ['failed', 'done', 'blocked'], 'việc phụ thuộc chờ chủ quyết, không bị đánh lỗi dây chuyền');
    assert.match(qa.error, /phụ thuộc/);
    assert.equal(an.failure_code, 'rejected_final');

    // Yêu cầu: nguyên nhân là việc của team; có thể bỏ phần lỗi vì còn việc đã xong, hoặc quyết cho việc bị chặn.
    const epicInfo = await info(ctx, epic.id);
    assert.equal(epicInfo.diagnosis.code, 'jobs_bad');
    assert.deepEqual(epicInfo.diagnosis.badJobs.map((j) => j.id), [api.id, qa.id]);
    assert.deepEqual(actions(epicInfo), [`start_job:${qa.id}`, `cancel_job:${qa.id}`, 'proceed']);
    // Việc con: nay xử lý được dù việc lớn thuộc yêu cầu.
    const childInfo = await inspectFailure({ store: ctx.store, projectRoot: ctx.project, id: an.id });
    assert.equal(childInfo.diagnosis.recoverable, true);
    assert.equal(childInfo.diagnosis.reopensJob, api.id);

    process.env.FAKE_REVIEW_MAP = '{}';
    await recoverTask(ctx.runner, an.id, { action: 'accept' });
    assert.equal(ctx.store.getEpic(epic.id).status, 'running', 'yêu cầu được mở lại');
    assert.equal(ctx.store.getEpic(epic.id).error, null);
    assert.equal(ctx.store.getJob(qa.id).status, 'waiting', 'việc bị lỗi dây chuyền được cho chờ lại');

    const finished = await epicIn(ctx, epic.id, ['awaiting_result', 'attention', 'failed']);
    assert.equal(finished.status, 'awaiting_result', finished.error ?? '');
    const jobs = ctx.store.epicJobs(epic.id);
    assert.deepEqual(jobs.map((j) => j.status), ['done', 'done', 'done']);
    assert.equal(jobs[0].merge_branch, `company/job${api.id}`, 'việc lớn chưa từng gộp được nên nhánh đầu tiên là job<id>');
    const tree = git(ctx.project, 'ls-tree', '-r', '--name-only', finished.merge_branch);
    const works = jobs.map((j) => ctx.store.jobTasks(j.id).find((t) => t.kind === 'work'));
    for (const w of works) assert.ok(tree.includes(outFile(w)), `nhánh ghép của yêu cầu có phần của ${w.member}`);
    assert.ok(ctx.store.jobTasks(qa.id).some((t) => t.kind === 'plan'), 'việc kiểm thử chạy thật sau khi việc nó chờ đã xong');
  } finally {
    await ctx.cleanup();
  }
});

test('bỏ phần lỗi: yêu cầu có một việc xong và một việc lỗi thì ghép phần đã xong, Giám đốc được báo phần nào thiếu', async () => {
  // dplan #1, plan #2 (backend) #3 (frontend), việc của An #4, của Cúc #5.
  const ctx = await boot(
    { FAKE_DPLAN: twoJobs(), FAKE_PLANS: teamPlans, FAKE_REVIEW: 'approve', FAKE_REVIEW_MAP: JSON.stringify({ 5: 'reject_always' }) },
    { maxConcurrent: 1 },
  );
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    const stuck = await epicIn(ctx, epic.id, ['attention', 'awaiting_result']);
    assert.equal(stuck.status, 'attention');
    const [api, ui] = ctx.store.epicJobs(epic.id);
    assert.deepEqual([api.status, ui.status], ['done', 'failed']);
    assert.equal(ctx.store.getTask(5).member, 'Cúc');

    const before = await info(ctx, epic.id);
    assert.deepEqual(actions(before), ['proceed']);
    await assert.rejects(recoverEpic(ctx.runner, epic.id, { action: 'proceed', guidance: 'không nhận' }), /không nhận lời dặn/);
    assert.equal(ctx.store.getEpic(epic.id).status, 'attention', 'lời dặn bị từ chối thì không đổi gì');

    await recoverEpic(ctx.runner, epic.id, { action: 'proceed' });
    const done = await epicIn(ctx, epic.id, ['awaiting_result', 'attention', 'failed']);
    assert.equal(done.status, 'awaiting_result', done.error ?? '');
    assert.equal(done.merge_branch, `company/epic${epic.id}`);
    const tree = git(ctx.project, 'ls-tree', '-r', '--name-only', done.merge_branch);
    const apiWork = ctx.store.jobTasks(api.id).find((t) => t.kind === 'work');
    const uiWork = ctx.store.jobTasks(ui.id).find((t) => t.kind === 'work');
    assert.ok(tree.includes(outFile(apiWork)));
    assert.ok(!tree.includes(outFile(uiWork)), 'phần bị bỏ không có trong nhánh ghép');
    const review = ctx.calls().filter((c) => flag(c, '--allowedTools')?.includes('finish_epic')).at(-1);
    assert.match(review.prompt, /KHÔNG hoàn chỉnh/);
    assert.match(review.prompt, /Màn hình đăng nhập/);
  } finally {
    await ctx.cleanup();
  }
});

test('Trưởng nhóm lập kế hoạch lỗi trong việc lớn của yêu cầu: chạy lại đúng lượt đó (mở lại việc lớn và yêu cầu), lời dặn đi kèm', async () => {
  const ctx = await boot({ FAKE_LEAD_FAIL: 'plan', FAKE_DPLAN: oneJob(), FAKE_PLANS: backendOnly, FAKE_REVIEW: 'approve' });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    const stuck = await epicIn(ctx, epic.id, ['attention', 'awaiting_result']);
    assert.equal(stuck.status, 'attention');
    const [job] = ctx.store.epicJobs(epic.id);
    assert.equal(job.status, 'failed');
    const plan = ctx.store.jobTasks(job.id).find((t) => t.kind === 'plan');
    assert.equal(plan.status, 'failed');

    const before = await inspectFailure({ store: ctx.store, projectRoot: ctx.project, id: plan.id });
    assert.equal(before.diagnosis.recoverable, true);
    assert.equal(before.diagnosis.reopensJob, job.id);
    assert.match(before.diagnosis.title, /Tiến trình Claude thoát/);
    assert.deepEqual(before.diagnosis.options.map((o) => o.action), ['continue', 'redo']);
    assert.match(before.diagnosis.options[0].hint, /Trưởng nhóm/, 'lời hướng dẫn nói về Trưởng nhóm, không phải nhân viên');
    assert.equal(before.work, null);

    delete process.env.FAKE_LEAD_FAIL;
    await recoverTask(ctx.runner, plan.id, { action: 'continue', guidance: 'Giao cả việc cho An.' });
    assert.equal(ctx.store.getEpic(epic.id).status, 'running');
    assert.equal(ctx.store.getJob(job.id).status, 'planning');
    const done = await epicIn(ctx, epic.id, ['awaiting_result', 'attention', 'failed']);
    assert.equal(done.status, 'awaiting_result', done.error ?? '');
    assert.equal(ctx.store.jobTasks(job.id).filter((t) => t.kind === 'plan').length, 1, 'cùng một lượt được chạy lại');
    const planCalls = ctx.calls().filter((c) => flag(c, '--allowedTools')?.includes('mcp__company__assign_to_member'));
    assert.equal(planCalls.length, 2);
    assert.equal(planCalls[1].resumed, true);
    assert.match(planCalls[1].prompt, /Lời dặn của chủ công ty[\s\S]*Giao cả việc cho An/);
  } finally {
    await ctx.cleanup();
  }
});

test('lập kế hoạch lại cho việc lớn lỗi của một yêu cầu (nút của việc lớn): mở lại yêu cầu và chạy tới khi chờ duyệt', async () => {
  const ctx = await boot({ FAKE_LEAD_FAIL: 'plan', FAKE_DPLAN: oneJob(), FAKE_PLANS: teamPlans, FAKE_REVIEW: 'approve' });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    await epicIn(ctx, epic.id, ['attention']);
    const [job] = ctx.store.epicJobs(epic.id);
    assert.equal(job.status, 'failed');

    delete process.env.FAKE_LEAD_FAIL;
    const replanned = ctx.runner.jobs.replan(job.id, { guidance: 'Chia nhỏ việc.' });
    assert.equal(replanned.status, 'planning');
    assert.equal(ctx.store.getEpic(epic.id).status, 'running');
    const done = await epicIn(ctx, epic.id, ['awaiting_result', 'attention', 'failed']);
    assert.equal(done.status, 'awaiting_result', done.error ?? '');
    const plans = ctx.store.jobTasks(job.id).filter((t) => t.kind === 'plan');
    assert.equal(plans.length, 2, 'lập lại là một lượt mới; lượt lỗi cũ vẫn trong lịch sử');
    assert.equal(ctx.store.getJob(job.id).plan_task_id, plans[1].id);
    const last = ctx.calls().filter((c) => flag(c, '--allowedTools')?.includes('assign_to_member')).at(-1);
    assert.match(last.prompt, /Lời dặn của chủ công ty[\s\S]*Chia nhỏ việc/);
  } finally {
    await ctx.cleanup();
  }
});

test('ghép kết quả các team bị xung đột: giải thích rõ, kèm file xung đột, không có nút tự động (không đẩy chủ vào lựa chọn sai)', async () => {
  const ctx = await boot({ FAKE_DPLAN: twoJobs(), FAKE_PLANS: teamPlans, FAKE_REVIEW: 'approve', FAKE_CONFLICT: '1' });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    const stuck = await epicIn(ctx, epic.id, ['attention', 'awaiting_result']);
    assert.equal(stuck.status, 'attention');
    const d = (await info(ctx, epic.id)).diagnosis;
    assert.equal(d.code, 'conflict');
    assert.match(d.cause, /shared\.txt/);
    assert.deepEqual(d.options, []);
    assert.equal(d.recoverable, false);
    assert.match(d.blockedReason, /Không có cách xử lý tự động/);
    await assert.rejects(recoverEpic(ctx.runner, epic.id, { action: 'proceed' }), (e) => e instanceof UserError && /Các lựa chọn hiện có: \(không có\)/.test(e.message));
  } finally {
    await ctx.cleanup();
  }
});

test('Giám đốc đánh giá chưa đạt: chủ có thể vẫn nhận kết quả để tự duyệt (không dead end)', async () => {
  const ctx = await boot({ FAKE_DREVIEW: 'attention', FAKE_DPLAN: oneJob(), FAKE_PLANS: teamPlans, FAKE_REVIEW: 'approve' });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    const stuck = await epicIn(ctx, epic.id, ['attention', 'awaiting_result']);
    assert.equal(stuck.status, 'attention');
    assert.equal(stuck.verdict, 'attention');
    const d = (await info(ctx, epic.id)).diagnosis;
    assert.equal(d.code, 'verdict_attention');
    assert.match(d.cause, /Báo cáo của Giám đốc/);
    assert.deepEqual(d.options.map((o) => o.action), ['accept']);
    await assert.rejects(recoverEpic(ctx.runner, epic.id, { action: 'accept', guidance: 'x' }), /không nhận lời dặn/);

    const accepted = await recoverEpic(ctx.runner, epic.id, { action: 'accept' });
    assert.equal(accepted.status, 'awaiting_result');
    assert.equal(accepted.error, null);
    await ctx.runner.epics.approveResult(epic.id);
    assert.equal(ctx.store.getEpic(epic.id).status, 'done');
  } finally {
    await ctx.cleanup();
  }
});

test('từ chối đúng chỗ: yêu cầu không ở lỗi/cần xem, không tồn tại, bấm đúp; lượt duyệt bài và lượt cũ không chạy lại riêng được', async () => {
  const ctx = await boot({ FAKE_LEAD_FAIL: 'dplan', FAKE_DPLAN: oneJob() });
  try {
    await assert.rejects(recoverEpic(ctx.runner, 99999, { action: 'continue' }), /Không có yêu cầu/);
    const running = ctx.store.createEpic({ title: 'E', prompt: 'p', director: 'Hòa' });
    ctx.store.updateEpic(running.id, { status: 'running' });
    const d = (await info(ctx, running.id)).diagnosis;
    assert.equal(d.recoverable, false);
    assert.match(d.blockedReason, /đang làm/);
    await assert.rejects(recoverEpic(ctx.runner, running.id, { action: 'continue' }), /đang làm/);

    // Bấm đúp: chỉ một lần được xử lý.
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['failed']);
    delete process.env.FAKE_LEAD_FAIL;
    const results = await Promise.allSettled([
      recoverEpic(ctx.runner, epic.id, { action: 'continue' }),
      recoverEpic(ctx.runner, epic.id, { action: 'continue' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(ctx.store.getTask(dirTasks(ctx, epic.id, 'dplan')[0].id).recoveries, 1);
    await epicIn(ctx, epic.id, ['awaiting_plan', 'failed']);
    await assert.rejects(recoverEpic(ctx.runner, epic.id, { action: 'continue' }), /chờ bạn duyệt/);

    // Kế hoạch đang chờ duyệt: lượt lập kế hoạch không chạy lại riêng được (chủ duyệt hoặc từ chối kèm nhận xét).
    const plan = dirTasks(ctx, epic.id, 'dplan')[0];
    ctx.store.updateTask(plan.id, { status: 'failed', error: 'x', failure_code: 'crash' });
    const blocked = await inspectFailure({ store: ctx.store, projectRoot: ctx.project, id: plan.id });
    assert.equal(blocked.diagnosis.recoverable, false);
    assert.match(blocked.diagnosis.blockedReason, /chờ bạn duyệt/);
    await assert.rejects(recoverTask(ctx.runner, plan.id, { action: 'redo' }), /chờ bạn duyệt/);

    // Lượt duyệt bài: lỗi hai lần thì bài nộp mới bị đánh dấu lỗi, chủ quyết ở đó.
    const found = { team: { id: 'backend' }, member: { name: 'Minh' }, role: { id: 'lead', model: 'sonnet', effort: 'medium' } };
    const job = ctx.store.createJob({ title: 'J', prompt: 'p', team: 'backend', lead: 'Minh', status: 'running' });
    const review = ctx.runner.createLeadTask({ kind: 'review', job, subject: ctx.runner.createWork({ found: { ...found, member: { name: 'An' } }, title: 'Con', prompt: 'p', level: 'normal', jobId: job.id }) });
    ctx.store.updateTask(review.id, { status: 'failed', error: 'x', failure_code: 'crash' });
    const reviewInfo = await inspectFailure({ store: ctx.store, projectRoot: ctx.project, id: review.id });
    assert.equal(reviewInfo.diagnosis.recoverable, false);
    assert.match(reviewInfo.diagnosis.blockedReason, /duyệt bài/);
    assert.deepEqual(reviewInfo.diagnosis.options, []);
  } finally {
    await ctx.cleanup();
  }
});

test('chẩn đoán lượt của Trưởng nhóm/Giám đốc: lời giải thích đổi người được nói tới; không có "nhận phần đã làm" hay "bỏ qua"', async () => {
  const { diagnose } = await import('../server/diagnose.mjs');
  const lead = { kind: 'plan', model: 'sonnet', failure_code: 'timeout', error: 'Quá thời gian cho phép (30 phút).' };
  const d = diagnose(lead, { hasWork: false, canResume: true, recoverable: true });
  assert.match(d.cause, /Trưởng nhóm/);
  assert.doesNotMatch(d.cause, /[Nn]hân viên/);
  assert.deepEqual(d.options.map((o) => o.action), ['continue', 'raise', 'redo']);
  assert.equal(d.recommended, 'continue');
  assert.equal(d.options.find((o) => o.action === 'redo').guidance, 'recommended');
  // Không còn phiên: chỉ nâng model (chạy từ đầu) hoặc chạy lại từ đầu; gợi ý chạy lại từ đầu.
  const noSession = diagnose({ ...lead, kind: 'dplan', model: 'sonnet' }, { hasWork: false, canResume: false, recoverable: true });
  assert.match(noSession.cause, /Giám đốc/);
  assert.deepEqual(noSession.options.map((o) => o.action), ['raise', 'redo']);
  assert.equal(noSession.recommended, 'redo');
  // Không được xử lý thì không có phương án.
  assert.deepEqual(diagnose(lead, { hasWork: false, canResume: true, recoverable: false, blockedReason: 'x' }).options, []);
  // Việc "làm" vẫn như cũ.
  assert.deepEqual(diagnose({ kind: 'work', model: 'sonnet', failure_code: 'timeout' }, { hasWork: true, canResume: true, recoverable: true }).options.map((o) => o.action), ['continue', 'raise', 'redo', 'accept', 'skip']);
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

test('API: GET/POST /api/epics/:id/recovery|recover — kiểm tra nguồn, 400 khi lựa chọn sai, 404 khi không có, 200 khi chạy lại', async () => {
  const ctx = await boot({ FAKE_LEAD_FAIL: 'dplan', FAKE_DPLAN: oneJob(), FAKE_PLANS: teamPlans });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['failed']);
    const port = ctx.app.port;
    const json = { host: `localhost:${port}`, 'content-type': 'application/json' };
    const base = `/api/epics/${epic.id}`;

    const got = await request(port, { path: `${base}/recovery`, headers: { host: `localhost:${port}` } });
    assert.equal(got.status, 200);
    assert.equal(got.json.diagnosis.code, 'plan_failed');
    assert.deepEqual(got.json.diagnosis.options.map((o) => o.action), ['continue', 'redo']);
    assert.equal(got.json.work, null);

    assert.equal((await request(port, { path: '/api/epics/99999/recovery', headers: { host: `localhost:${port}` } })).status, 404);
    const evil = await request(port, { method: 'POST', path: `${base}/recover`, body: '{"action":"continue"}', headers: { ...json, origin: 'https://evil.example.com' } });
    assert.equal(evil.status, 403);
    assert.equal(ctx.store.getEpic(epic.id).status, 'failed', 'bị chặn thì không đổi gì');
    const bad = await request(port, { method: 'POST', path: `${base}/recover`, body: '{"action":"bay_bay"}', headers: json });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Các lựa chọn hiện có/);

    delete process.env.FAKE_LEAD_FAIL;
    const ok = await request(port, { method: 'POST', path: `${base}/recover`, body: '{"action":"continue","guidance":"làm đi"}', headers: json });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.epic.status, 'planning');
    assert.equal((await epicIn(ctx, epic.id, ['awaiting_plan', 'failed'])).status, 'awaiting_plan');
  } finally {
    await ctx.cleanup();
  }
});

/** Backend lỗi (An bị trả bài hết lượt), Frontend xong, Chất lượng phụ thuộc cả hai nên "chờ quyết định". */
async function epicWithBlockedJob() {
  const ctx = await boot(
    { FAKE_DPLAN: threeJobs(), FAKE_PLANS: teamPlans, FAKE_REVIEW: 'approve', FAKE_REVIEW_MAP: JSON.stringify({ 4: 'reject_always' }) },
    { maxConcurrent: 1 },
  );
  const epic = await newEpic(ctx);
  await epicIn(ctx, epic.id, ['awaiting_plan']);
  await ctx.runner.epics.approvePlan(epic.id);
  const stuck = await epicIn(ctx, epic.id, ['attention', 'awaiting_result']);
  const [api, ui, qa] = ctx.store.epicJobs(epic.id);
  assert.deepEqual([stuck.status, api.status, ui.status, qa.status], ['attention', 'failed', 'done', 'blocked']);
  return { ctx, epic, api, ui, qa };
}

test('việc bị chặn: chủ cho chạy trên phần đã có thì nó chạy thật (gốc có phần của Frontend), xong rồi yêu cầu lại về "cần xem" chỉ vì Backend', async () => {
  const { ctx, epic, api, ui, qa } = await epicWithBlockedJob();
  try {
    process.env.FAKE_REVIEW_MAP = '{}';
    await recoverEpic(ctx.runner, epic.id, { action: `start_job:${qa.id}` });
    assert.equal(ctx.store.getEpic(epic.id).status, 'running');
    const finished = await epicIn(ctx, epic.id, ['attention', 'awaiting_result', 'failed']);
    const qaDone = ctx.store.getJob(qa.id);
    assert.equal(qaDone.status, 'done', qaDone.error ?? '');
    const tree = git(ctx.project, 'ls-tree', '-r', '--name-only', qaDone.base_commit).split('\n');
    const cuc = ctx.store.jobTasks(ui.id).find((t) => t.kind === 'work');
    assert.ok(tree.includes(outFile(cuc)), 'việc kiểm thử thấy phần của Frontend trong mã gốc của nó');
    assert.equal(finished.status, 'attention');
    assert.match(finished.error, new RegExp(`1 việc của team chưa đạt.*#${api.id}`));
    const again = await info(ctx, epic.id);
    assert.deepEqual(again.diagnosis.badJobs.map((j) => j.id), [api.id]);
    assert.deepEqual(actions(again), ['proceed']);
  } finally {
    await ctx.cleanup();
  }
});

test('việc bị chặn sau một chuỗi: việc ở giữa không có kết quả thì mã gốc lấy phần đã xong của việc ở tầng trên (không chạy trên mã trơn)', async () => {
  // API (xong) → Màn hình (Trưởng nhóm không chia được việc nên lỗi, không có nhánh) → Test (chỉ phụ thuộc Màn hình).
  const chain = JSON.stringify({
    jobs: [
      { team: 'backend', title: 'API đăng nhập', description: 'Làm API đăng nhập', acceptance: 'test qua' },
      { team: 'frontend', title: 'Màn hình đăng nhập', description: 'Làm màn hình', acceptance: 'test qua', depends_on: ['API đăng nhập'] },
      { team: 'quality', title: 'Test đăng nhập', description: 'Test tích hợp', acceptance: 'test qua', depends_on: ['Màn hình đăng nhập'] },
    ],
  });
  const plans = JSON.parse(teamPlans);
  delete plans.frontend;
  const ctx = await boot({ FAKE_DPLAN: chain, FAKE_PLANS: JSON.stringify(plans), FAKE_REVIEW: 'approve' }, { maxConcurrent: 1 });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    await epicIn(ctx, epic.id, ['attention', 'failed', 'awaiting_result']);
    const [api, ui, qa] = ctx.store.epicJobs(epic.id);
    assert.deepEqual([api.status, ui.status, qa.status], ['done', 'failed', 'blocked']);
    assert.equal(ui.merge_branch, null);

    await recoverEpic(ctx.runner, epic.id, { action: `start_job:${qa.id}` });
    await epicIn(ctx, epic.id, ['attention', 'awaiting_result', 'failed']);
    const qaDone = ctx.store.getJob(qa.id);
    assert.equal(qaDone.status, 'done', qaDone.error ?? '');
    const tree = git(ctx.project, 'ls-tree', '-r', '--name-only', qaDone.base_commit).split('\n');
    const an = ctx.store.jobTasks(api.id).find((t) => t.kind === 'work');
    assert.ok(tree.includes(outFile(an)), 'mã gốc của việc kiểm thử có phần của Backend dù chỉ phụ thuộc gián tiếp');
    const logged = ctx.store.listEvents(qaDone.plan_task_id).map((e) => e.summary);
    assert.ok(logged.some((s) => s.includes(`lấy thêm phần đã có của việc #${api.id}`)), 'báo cho chủ biết đã lấy thêm việc nào');
  } finally {
    await ctx.cleanup();
  }
});

test('việc bị chặn: chủ hủy thì nó thành lỗi, yêu cầu kết luận lại và chỉ còn nút bỏ phần lỗi; từ chối hành động với việc không bị chặn', async () => {
  const { ctx, epic, api, qa } = await epicWithBlockedJob();
  try {
    await assert.rejects(recoverEpic(ctx.runner, epic.id, { action: `start_job:${api.id}` }), (e) => e instanceof UserError && /Không thể/.test(e.message));
    await recoverEpic(ctx.runner, epic.id, { action: `cancel_job:${qa.id}` });
    const after = await epicIn(ctx, epic.id, ['attention', 'failed']);
    assert.equal(after.status, 'attention');
    assert.equal(ctx.store.getJob(qa.id).status, 'failed');
    assert.match(ctx.store.getJob(qa.id).error, /Bạn đã hủy/);
    assert.match(after.error, /2 việc của team chưa đạt/);
    assert.deepEqual(actions(await info(ctx, epic.id)), ['proceed']);
    assert.equal(ctx.store.jobTasks(qa.id).length, 0, 'việc bị hủy chưa từng chạy');
  } finally {
    await ctx.cleanup();
  }
});

test('bỏ phần lỗi khi còn việc bị chặn: việc đó được đóng thành lỗi, không lơ lửng trong yêu cầu đã kết thúc', async () => {
  const { ctx, epic, qa } = await epicWithBlockedJob();
  try {
    await recoverEpic(ctx.runner, epic.id, { action: 'proceed' });
    assert.equal(ctx.store.getJob(qa.id).status, 'failed');
    assert.match(ctx.store.getJob(qa.id).error, /bỏ phần lỗi/);
    assert.equal((await epicIn(ctx, epic.id, ['awaiting_result', 'attention', 'failed'])).status, 'awaiting_result');
  } finally {
    await ctx.cleanup();
  }
});

test('đợt làm lại mà mọi việc đều lỗi: vẫn có nút bỏ phần lỗi, Giám đốc kiểm tra kết quả đã ghép của đợt trước (không kẹt không nút)', async () => {
  // Giống yêu cầu #10 trên web96: đợt 1 chỉ có một việc sửa, việc đó lỗi; trước đây usableJobs rỗng nên giao diện không có lựa chọn nào.
  const rework = JSON.stringify({ team: 'frontend', title: 'Sửa sau kiểm tra', description: 'Sửa phần Giám đốc phát hiện', acceptance: 'test qua' });
  const plans = JSON.parse(teamPlans);
  delete plans.frontend; // Trưởng nhóm Frontend không chia được việc nên việc đợt 1 lỗi, không có nhánh.
  const ctx = await boot({ FAKE_DPLAN: oneJob(), FAKE_PLANS: JSON.stringify(plans), FAKE_REVIEW: 'approve', FAKE_DREVIEW: 'rework_once', FAKE_REWORK_JOB: rework });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    const stuck = await epicIn(ctx, epic.id, ['attention', 'awaiting_result', 'failed']);
    assert.equal(stuck.status, 'attention', stuck.error ?? '');
    assert.equal(stuck.round, 1);
    assert.equal(stuck.merge_branch, `company/epic${epic.id}`);
    const fix = ctx.store.epicJobs(epic.id).find((j) => j.round === 1);
    assert.equal(fix.status, 'failed');
    assert.equal(fix.merge_branch, null);

    const before = await info(ctx, epic.id);
    assert.equal(before.diagnosis.code, 'jobs_bad');
    assert.deepEqual(actions(before), ['proceed']);
    assert.ok(before.diagnosis.options[0].hint.includes(`đợt trước (nhánh company/epic${epic.id})`), before.diagnosis.options[0].hint);

    // Lượt kiểm tra đợt 0 (đã giao việc làm lại) thoát muộn đúng lúc yêu cầu đang ghép / kiểm tra đợt 1: không được sinh lượt thử lại thừa.
    const oldReview = dirTasks(ctx, epic.id, 'dreview')[0];
    assert.equal(oldReview.subject_id, 0);
    for (const status of ['integrating', 'reviewing']) {
      ctx.store.updateEpic(epic.id, { status });
      await ctx.runner.epics.afterChange(oldReview.id);
      assert.equal(dirTasks(ctx, epic.id, 'dreview').length, 1, `lượt kiểm tra cũ thoát muộn lúc "${status}" không sinh lượt mới`);
      assert.equal(ctx.store.getEpic(epic.id).status, status);
    }
    ctx.store.updateEpic(epic.id, { status: 'attention' });

    const firstTree = git(ctx.project, 'ls-tree', '-r', '--name-only', `company/epic${epic.id}`);
    await recoverEpic(ctx.runner, epic.id, { action: 'proceed' });
    const done = await epicIn(ctx, epic.id, ['awaiting_result', 'attention', 'failed']);
    assert.equal(done.status, 'awaiting_result', done.error ?? '');
    assert.equal(done.merge_branch, `company/epic${epic.id}-r1`);
    assert.equal(git(ctx.project, 'ls-tree', '-r', '--name-only', done.merge_branch), firstTree, 'nhánh kiểm tra giữ nguyên kết quả đợt trước');
    const review = ctx.calls().filter((c) => flag(c, '--allowedTools')?.includes('finish_epic')).at(-1);
    assert.match(review.prompt, /Sửa sau kiểm tra — failed\n\(Việc này KHÔNG hoàn chỉnh/, 'Giám đốc được báo việc đợt làm lại bị bỏ');
  } finally {
    await ctx.cleanup();
  }
});

test('máy chủ tắt giữa lúc gộp nhánh: khởi động lại thì việc lớn gộp lại, yêu cầu đi tiếp tới chờ duyệt (không đứng mãi ở "đang gộp")', async () => {
  const ctx = await boot({ FAKE_DPLAN: twoJobs(), FAKE_PLANS: teamPlans, FAKE_REVIEW: 'approve' });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    assert.equal((await epicIn(ctx, epic.id, ['awaiting_result', 'attention', 'failed'])).status, 'awaiting_result');
    const [api] = ctx.store.epicJobs(epic.id);

    // Dựng lại lúc máy tắt: việc Backend đang gộp nhánh (chưa ghi nhánh gộp), yêu cầu còn chờ nó.
    ctx.store.updateJob(api.id, { status: 'integrating', merge_branch: null, merge_worktree: null, finished_at: null });
    ctx.store.updateEpic(epic.id, { status: 'running', merge_branch: null, merge_worktree: null, verdict: null, finished_at: null });
    await ctx.restart();
    const again = await epicIn(ctx, epic.id, ['awaiting_result', 'attention', 'failed']);
    assert.equal(again.status, 'awaiting_result', again.error ?? '');
    const job = ctx.store.getJob(api.id);
    assert.equal(job.status, 'done', job.error ?? '');
    assert.equal(job.merge_branch, `company/job${api.id}-2`, 'nhánh gộp dở được giữ, lần gộp lại lấy tên mới');
    const work = ctx.store.jobTasks(api.id).find((t) => t.kind === 'work');
    assert.ok(git(ctx.project, 'ls-tree', '-r', '--name-only', job.merge_branch).split('\n').includes(outFile(work)), 'nhánh gộp lại có bài của nhân viên');
    assert.equal(again.merge_branch, `company/epic${epic.id}-2`);

    // Lần này máy tắt đúng lúc ghép kết quả của cả yêu cầu (mọi việc đã xong).
    ctx.store.updateEpic(epic.id, { status: 'integrating', merge_branch: null, merge_worktree: null, verdict: null, finished_at: null });
    await ctx.restart();
    const third = await epicIn(ctx, epic.id, ['awaiting_result', 'attention', 'failed']);
    assert.equal(third.status, 'awaiting_result', third.error ?? '');
    assert.equal(third.merge_branch, `company/epic${epic.id}-3`);
    assert.equal(ctx.store.epicJobs(epic.id).filter((j) => j.status === 'integrating').length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('máy chủ tắt giữa lúc ghép sau khi chủ chọn bỏ phần lỗi: ghép lại vẫn giữ lựa chọn đó (không quay về "cần xem")', async () => {
  const { ctx, epic, api, ui } = await epicWithBlockedJob();
  try {
    process.env.FAKE_REVIEW_MAP = '{}';
    await recoverEpic(ctx.runner, epic.id, { action: 'proceed' });
    assert.equal((await epicIn(ctx, epic.id, ['awaiting_result', 'attention', 'failed'])).status, 'awaiting_result');
    ctx.store.updateEpic(epic.id, { status: 'integrating', merge_branch: null, merge_worktree: null, verdict: null, finished_at: null });
    await ctx.restart();
    const again = await epicIn(ctx, epic.id, ['awaiting_result', 'attention', 'failed']);
    assert.equal(again.status, 'awaiting_result', again.error ?? '');
    assert.equal(ctx.store.getJob(api.id).status, 'failed', 'việc lỗi vẫn bị bỏ');
    const tree = git(ctx.project, 'ls-tree', '-r', '--name-only', again.merge_branch).split('\n');
    const cuc = ctx.store.jobTasks(ui.id).find((t) => t.kind === 'work');
    assert.ok(tree.includes(outFile(cuc)), 'nhánh ghép lại có phần của Frontend');
  } finally {
    await ctx.cleanup();
  }
});
