import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { toolsForKind } from '../server/agent-tools.mjs';
import { openDb } from '../server/db.mjs';
import { startServer } from '../server/index.mjs';
import { git, makeProject, removeDir, testConfig, tmpDir, waitFor } from './helpers.mjs';

const FAKE_KEYS = [
  'FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_TRIAGE', 'FAKE_PLAN', 'FAKE_PLANS', 'FAKE_REVIEW', 'FAKE_REVIEW_MAP',
  'FAKE_UNIQUE', 'FAKE_CONFLICT', 'FAKE_WORK_DELAY_MS', 'FAKE_DPLAN', 'FAKE_DPLAN_V2', 'FAKE_DREVIEW', 'FAKE_REWORK_JOB',
];

async function boot(env = {}, overrides = {}) {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg = testConfig(root, project, local, overrides);
  const logFile = path.join(root, 'fake.log');
  Object.assign(process.env, { FAKE_CLAUDE_LOG: logFile, FAKE_UNIQUE: '1', ...env });
  const app = await startServer({ cfg, withUi: false, log: () => {} });
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const cleanup = async () => {
    await app.close();
    for (const key of FAKE_KEYS) delete process.env[key];
    removeDir(root);
  };
  return { root, project, cfg, app, runner: app.runner, store: app.store, calls, cleanup };
}

const flag = (call, name) => call.args[call.args.indexOf(name) + 1];

// Kế hoạch của từng Trưởng nhóm (khóa là id team) và của Giám đốc.
const teamPlans = JSON.stringify({
  backend: [{ member: 'An', title: 'Làm API', description: 'Làm API đúng hợp đồng', acceptance: 'test qua', files: ['src/api'], level: 'normal' }],
  frontend: [{ member: 'Cúc', title: 'Làm giao diện', description: 'Làm giao diện đúng hợp đồng', acceptance: 'test qua', files: ['src/ui'], level: 'normal' }],
  quality: [{ member: 'Quân', title: 'Viết test tích hợp', description: 'Test trên mã đã ghép', acceptance: 'test qua', files: ['test/int'], level: 'normal' }],
});
const CONTRACT = 'POST /api/login nhận {"email","password"}, trả {"token"} khi đúng; 401 {"error"} khi sai. Frontend lưu token trong bộ nhớ.';
const dplan = (extra = {}) => JSON.stringify({
  contract: CONTRACT,
  jobs: [
    { team: 'backend', title: 'API đăng nhập', description: 'Làm API đăng nhập', acceptance: 'test qua' },
    { team: 'frontend', title: 'Màn hình đăng nhập', description: 'Làm màn hình đăng nhập', acceptance: 'test qua' },
    { team: 'quality', title: 'Test đăng nhập', description: 'Test tích hợp đăng nhập', acceptance: 'test qua', depends_on: ['API đăng nhập', 'Màn hình đăng nhập'] },
  ],
  ...extra,
});
const newEpic = (ctx, over = {}) => ctx.runner.epics.create({ title: 'Đăng nhập bằng email', prompt: 'Thêm tính năng đăng nhập bằng email', ...over });
const epicIn = (ctx, id, statuses) => waitFor(() => statuses.includes(ctx.store.getEpic(id).status) && ctx.store.getEpic(id), { timeout: 60000, label: `yêu cầu #${id} đạt ${statuses.join('/')}` });

test('đường đi đầy đủ: Giám đốc lập kế hoạch + hợp đồng, chủ duyệt, Backend và Frontend song song, Chất lượng sau, ghép, Giám đốc kiểm tra, chủ duyệt', async () => {
  const ctx = await boot({ FAKE_DPLAN: dplan(), FAKE_PLANS: teamPlans, FAKE_WORK_DELAY_MS: '700' });
  try {
    const epic = await newEpic(ctx);
    assert.equal(epic.status, 'planning');
    assert.equal(epic.director, 'Hòa');

    // 1. Kế hoạch xong thì dừng lại chờ chủ duyệt: chưa việc nào của team được bắt đầu.
    const planned = await epicIn(ctx, epic.id, ['awaiting_plan']);
    assert.equal(planned.contract, CONTRACT);
    assert.match(planned.plan_summary, /Kế hoạch của Giám đốc: 3 việc cho team/);
    const [api, ui, qa] = ctx.store.epicJobs(epic.id);
    assert.deepEqual([api.status, ui.status, qa.status], ['draft', 'draft', 'waiting']);
    assert.deepEqual(JSON.parse(qa.depends_on), [api.id, ui.id]);
    assert.equal(ctx.store.jobTasks(api.id).length, 0, 'chưa duyệt thì Trưởng nhóm của team chưa chạy');
    assert.equal(ctx.calls().length, 1, 'mới chỉ có lượt lập kế hoạch của Giám đốc');
    assert.throws(() => ctx.runner.epics.approveResult(epic.id), /chờ duyệt kết quả/);

    // 2. Chủ duyệt kế hoạch: hai team không phụ thuộc chạy, team Chất lượng chờ.
    await ctx.runner.epics.approvePlan(epic.id);
    assert.equal(ctx.store.getEpic(epic.id).status, 'running');
    await waitFor(() => ctx.store.getJob(api.id).status === 'done' && ctx.store.getJob(ui.id).status === 'done', { timeout: 60000, label: 'Backend và Frontend xong' });

    const apiWork = ctx.store.jobTasks(api.id).find((t) => t.kind === 'work');
    const uiWork = ctx.store.jobTasks(ui.id).find((t) => t.kind === 'work');
    assert.deepEqual([apiWork.member, uiWork.member], ['An', 'Cúc']);
    assert.ok(apiWork.started_at < uiWork.finished_at && uiWork.started_at < apiWork.finished_at, 'Backend và Frontend làm chồng thời gian (song song)');
    // Hợp đồng được đính kèm vào việc lớn của từng team.
    assert.match(ctx.store.getJob(api.id).prompt, /Hợp đồng chung của yêu cầu[\s\S]*POST \/api\/login/);
    assert.match(ctx.store.getJob(ui.id).prompt, /POST \/api\/login/);

    // 3. Team Chất lượng bắt đầu SAU, trên mã đã ghép của hai team kia.
    await waitFor(() => ctx.store.getJob(qa.id).status === 'done', { timeout: 60000, label: 'Chất lượng xong' });
    const qaJob = ctx.store.getJob(qa.id);
    assert.notEqual(qaJob.base_commit, planned.base_commit, 'gốc của việc test không phải mã ban đầu');
    assert.ok(qaJob.base_dir && fs.existsSync(qaJob.base_dir), 'Trưởng nhóm Chất lượng đọc code ở thư mục đã ghép');
    const qaWork = ctx.store.jobTasks(qa.id).find((t) => t.kind === 'work');
    const qaTree = git(ctx.project, 'ls-tree', '-r', '--name-only', qaWork.branch);
    assert.ok(qaTree.includes(`out-${path.basename(apiWork.worktree)}.txt`) && qaTree.includes(`out-${path.basename(uiWork.worktree)}.txt`), 'nhánh của QA đã có sẵn code của Backend và Frontend');
    assert.ok(qaWork.started_at >= apiWork.finished_at && qaWork.started_at >= uiWork.finished_at, 'QA chỉ bắt đầu sau khi hai team kia xong');
    assert.match(ctx.store.getJob(qa.id).prompt, /POST \/api\/login/);

    // 4. Ghép kết quả của cả ba team rồi Giám đốc kiểm tra, chờ chủ duyệt kết quả.
    const reviewed = await epicIn(ctx, epic.id, ['awaiting_result', 'attention', 'failed']);
    assert.equal(reviewed.status, 'awaiting_result', reviewed.error ?? '');
    assert.equal(reviewed.verdict, 'accept');
    assert.match(reviewed.final_report, /Báo cáo cuối cho chủ/);
    assert.equal(reviewed.merge_branch, `company/epic${epic.id}`);
    const epicTree = git(ctx.project, 'ls-tree', '-r', '--name-only', reviewed.merge_branch);
    for (const w of [apiWork, uiWork, qaWork]) assert.ok(epicTree.includes(`out-${path.basename(w.worktree)}.txt`), `nhánh ghép có phần của ${w.member}`);
    assert.equal(git(ctx.project, 'rev-parse', 'main'), planned.base_commit, 'nhánh chính của dự án không bị đụng');
    assert.match(reviewed.summary, /Việc #\d+ \(backend\).*done/);

    // 5. Chủ duyệt kết quả thì hoàn thành.
    ctx.runner.epics.approveResult(epic.id);
    assert.equal(ctx.store.getEpic(epic.id).status, 'done');

    // Model: Giám đốc lập kế hoạch bằng opus, kiểm tra bằng sonnet; Trưởng nhóm Backend opus, Frontend sonnet.
    const dirTasks = ctx.store.epicTasks(epic.id);
    assert.deepEqual(dirTasks.map((t) => [t.kind, t.member, t.model]), [['dplan', 'Hòa', 'opus'], ['dreview', 'Hòa', 'sonnet']]);
    const leadModel = (teamId) => ctx.store.jobTasks(ctx.store.epicJobs(epic.id).find((j) => j.team === teamId).id).find((t) => t.kind === 'plan').model;
    assert.deepEqual([leadModel('backend'), leadModel('frontend'), leadModel('quality')], ['opus', 'sonnet', 'sonnet']);
    // Giám đốc chỉ có công cụ đọc và công cụ của công ty; lượt kiểm tra được chạy lệnh test.
    const directorCalls = ctx.calls().filter((c) => flag(c, '--allowedTools')?.includes('mcp__company__create_team_job'));
    assert.equal(directorCalls.length, 2);
    assert.equal(flag(directorCalls[0], '--tools'), 'Read,Grep,Glob,Bash');
    assert.doesNotMatch(flag(directorCalls[0], '--allowedTools'), /npm test|Edit|Write/);
    assert.match(flag(directorCalls[1], '--allowedTools'), /Bash\(npm test\)/);
    assert.equal(directorCalls[1].cwd, fs.realpathSync(reviewed.merge_worktree), 'Giám đốc kiểm tra ngay trên mã đã ghép');
    assert.equal(directorCalls[0].guard.mode, 'readonly');
  } finally {
    await ctx.cleanup();
  }
});

test('chủ từ chối kế hoạch: Giám đốc lập lại theo nhận xét (làm tiếp phiên cũ), tối đa 2 lần', async () => {
  const v1 = JSON.stringify({ jobs: [{ team: 'backend', title: 'Việc cũ', description: 'd' }] });
  const v2 = JSON.stringify({ contract: CONTRACT, jobs: [{ team: 'backend', title: 'Việc mới 1', description: 'd' }, { team: 'frontend', title: 'Việc mới 2', description: 'd' }] });
  const ctx = await boot({ FAKE_DPLAN: v1, FAKE_DPLAN_V2: v2, FAKE_PLANS: teamPlans });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    assert.deepEqual(ctx.store.epicJobs(epic.id).map((j) => j.title), ['Việc cũ']);

    assert.throws(() => ctx.runner.epics.rejectPlan(epic.id, 'ngắn'), /ghi nhận xét/);
    ctx.runner.epics.rejectPlan(epic.id, 'Cần thêm phần giao diện và hợp đồng API.');
    assert.equal(ctx.store.getEpic(epic.id).status, 'planning');
    assert.equal(ctx.store.getEpic(epic.id).replans, 1);
    assert.deepEqual(ctx.store.epicJobs(epic.id), [], 'việc nháp của kế hoạch cũ bị xóa');

    const again = await epicIn(ctx, epic.id, ['awaiting_plan']);
    assert.deepEqual(ctx.store.epicJobs(epic.id).map((j) => j.title), ['Việc mới 1', 'Việc mới 2']);
    assert.match(again.plan_summary, /đã lập lại theo nhận xét/);
    assert.equal(again.contract, CONTRACT);
    const replan = ctx.calls().filter((c) => flag(c, '--allowedTools')?.includes('set_contract'))[1];
    assert.equal(replan.resumed, true, 'làm tiếp đúng phiên cũ của Giám đốc');
    assert.match(replan.prompt, /Cần thêm phần giao diện/);

    ctx.runner.epics.rejectPlan(epic.id, 'Vẫn chưa ổn, làm lại lần nữa.');
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    assert.throws(() => ctx.runner.epics.rejectPlan(epic.id, 'Lại không ổn nữa.'), /đã được lập lại 2 lần/);
  } finally {
    await ctx.cleanup();
  }
});

test('Giám đốc giao một đợt làm lại: việc sửa chạy trên mã đã ghép, finish_epic sớm bị từ chối, rồi ghép lại và duyệt', async () => {
  const rework = JSON.stringify({ team: 'backend', title: 'Sửa lỗi sau kiểm tra', description: 'Sửa lỗi Giám đốc phát hiện: thiếu kiểm tra mật khẩu rỗng.', acceptance: 'test qua' });
  const ctx = await boot({
    FAKE_DPLAN: JSON.stringify({ contract: CONTRACT, jobs: [{ team: 'backend', title: 'API đăng nhập', description: 'd' }] }),
    FAKE_PLANS: teamPlans, FAKE_DREVIEW: 'rework_once', FAKE_REWORK_JOB: rework,
  });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    const final = await epicIn(ctx, epic.id, ['awaiting_result', 'attention', 'failed']);
    assert.equal(final.status, 'awaiting_result', final.error ?? '');
    assert.equal(final.round, 1);
    assert.equal(final.merge_branch, `company/epic${epic.id}-r1`);

    const jobs = ctx.store.epicJobs(epic.id);
    const fix = jobs.find((j) => j.title === 'Sửa lỗi sau kiểm tra');
    assert.equal(fix.round, 1);
    assert.equal(fix.status, 'done');
    assert.equal(fix.base_ref, `company/epic${epic.id}`, 'việc sửa lấy gốc là nhánh đã ghép lần đầu');
    assert.equal(fix.base_commit, git(ctx.project, 'rev-parse', `company/epic${epic.id}`));
    const tree = git(ctx.project, 'ls-tree', '-r', '--name-only', final.merge_branch).split('\n');
    assert.ok(tree.length >= 2, 'nhánh ghép đợt 2 chứa cả phần ban đầu lẫn phần sửa');

    const dirTasks = ctx.store.epicTasks(epic.id);
    assert.deepEqual(dirTasks.map((t) => t.kind), ['dplan', 'dreview', 'dreview']);
    const firstReview = dirTasks[1];
    assert.match(firstReview.result, /finish sớm: bị từ chối/, 'finish_epic ngay sau khi giao việc làm lại phải bị từ chối');
    assert.doesNotMatch(firstReview.result, /LỌT/);
    assert.equal(final.verdict, 'accept');

    // Hết lượt làm lại thì không giao thêm được nữa.
    const plan = dirTasks[2];
    await assert.rejects(ctx.runner.epics.createTeamJob(plan, { team: 'backend', title: 'Thêm nữa', description: 'd' }), /không giao thêm được|hết lượt làm lại/);
  } finally {
    await ctx.cleanup();
  }
});

test('một team thất bại: việc phụ thuộc bị hủy dây chuyền, yêu cầu cần chủ xem, không qua Giám đốc kiểm tra', async () => {
  const ctx = await boot({ FAKE_DPLAN: dplan(), FAKE_PLANS: teamPlans, FAKE_REVIEW: 'reject_always' });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    const done = await epicIn(ctx, epic.id, ['attention', 'failed', 'awaiting_result']);
    assert.equal(done.status, 'attention');
    const jobs = ctx.store.epicJobs(epic.id);
    // Trưởng nhóm trả bài mọi lần nên Backend và Frontend đều không đạt; việc test phụ thuộc vào cả hai nên bị hủy.
    assert.deepEqual(jobs.map((j) => j.status), ['failed', 'failed', 'failed']);
    assert.match(jobs[2].error, /mà việc này phụ thuộc không hoàn thành/);
    assert.equal(ctx.store.jobTasks(jobs[2].id).length, 0, 'việc phụ thuộc không bao giờ được bắt đầu');
    assert.match(done.error, /3 việc của team chưa đạt/);
    assert.equal(ctx.store.epicTasks(epic.id).filter((t) => t.kind === 'dreview').length, 0, 'chưa đạt thì không tới bước Giám đốc kiểm tra');
  } finally {
    await ctx.cleanup();
  }
});

test('ghép kết quả các team bị xung đột: không tự giải quyết, báo file xung đột', async () => {
  const two = JSON.stringify({ jobs: [
    { team: 'backend', title: 'API', description: 'd' }, { team: 'frontend', title: 'UI', description: 'd' },
  ] });
  const ctx = await boot({ FAKE_DPLAN: two, FAKE_PLANS: teamPlans, FAKE_CONFLICT: '1', FAKE_UNIQUE: '' });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    const done = await epicIn(ctx, epic.id, ['attention', 'failed', 'awaiting_result']);
    assert.equal(done.status, 'attention');
    assert.deepEqual(JSON.parse(done.conflict_files), ['shared.txt']);
    assert.match(done.error, /Xung đột khi ghép kết quả các team/);
    assert.deepEqual(ctx.store.epicJobs(epic.id).map((j) => j.status), ['done', 'done'], 'từng team vẫn xong phần của mình');
  } finally {
    await ctx.cleanup();
  }
});

test('Giám đốc không kết luận: thử lại một lần rồi báo chủ; Giám đốc không lập được kế hoạch thì yêu cầu thất bại', async () => {
  const ctx = await boot({ FAKE_DPLAN: JSON.stringify({ jobs: [{ team: 'backend', title: 'API', description: 'd' }] }), FAKE_PLANS: teamPlans, FAKE_DREVIEW: 'none' });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    const done = await epicIn(ctx, epic.id, ['attention', 'failed', 'awaiting_result']);
    assert.equal(done.status, 'attention');
    assert.match(done.error, /không đưa ra được kết luận sau hai lượt kiểm tra/);
    assert.equal(ctx.store.epicTasks(epic.id).filter((t) => t.kind === 'dreview').length, 2, 'kiểm tra lại đúng một lần');
  } finally {
    await ctx.cleanup();
  }

  const empty = await boot({ FAKE_DPLAN: JSON.stringify({ jobs: [] }) });
  try {
    const epic = await newEpic(empty);
    const done = await epicIn(empty, epic.id, ['failed']);
    assert.match(done.error, /không chia ra việc nào cho các team/);
  } finally {
    await empty.cleanup();
  }
});

test('dừng yêu cầu: dừng Giám đốc, mọi việc đang chạy và đang chờ', async () => {
  const ctx = await boot({ FAKE_DPLAN: dplan(), FAKE_PLANS: teamPlans, FAKE_CLAUDE_SCENARIO: 'hang' });
  try {
    const epic = await newEpic(ctx);
    await epicIn(ctx, epic.id, ['awaiting_plan']);
    await ctx.runner.epics.approvePlan(epic.id);
    await waitFor(() => ctx.store.epicJobs(epic.id).some((j) => ctx.store.jobTasks(j.id).some((t) => t.kind === 'work' && t.status === 'running')), { timeout: 40000, label: 'có nhân viên đang chạy' });
    await ctx.runner.epics.stop(epic.id, 'Dừng thử');
    await waitFor(() => ctx.store.epicJobs(epic.id).every((j) => j.status === 'stopped') && ctx.store.getEpic(epic.id).status === 'stopped', { label: 'mọi thứ đã dừng' });
    await waitFor(() => ctx.store.epicJobs(epic.id).flatMap((j) => ctx.store.jobTasks(j.id)).every((t) => !['queued', 'running'].includes(t.status)), { label: 'không còn việc nào chạy' });
    assert.ok(ctx.store.epicTasks(epic.id).every((t) => t.status !== 'running'), 'Giám đốc cũng không còn chạy');
    assert.equal(ctx.runner.snapshot().running.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('luật của công cụ Giám đốc: team lạ, trùng tiêu đề, phụ thuộc không có, quá số việc, hợp đồng, sai loại lượt', async () => {
  const ctx = await boot();
  try {
    ctx.runner.setManualPause(true); // chỉ gọi thẳng công cụ để kiểm tra luật, không chạy agent
    const epic = await newEpic(ctx);
    const plan = ctx.store.getTask(epic.plan_task_id);
    const make = (over) => ctx.runner.epics.createTeamJob(plan, { team: 'backend', title: 'A', description: 'd', ...over });

    assert.match(await make({}), /Đã tạo việc #\d+ "A" cho Team Backend.*sẽ chạy khi chủ duyệt kế hoạch/);
    await assert.rejects(make({ team: 'khong-co', title: 'B' }), /Không có team "khong-co".*backend/);
    await assert.rejects(make({ team: 'management', title: 'B' }), /Không có team/, 'ban giám đốc không nhận việc');
    await assert.rejects(make({ title: 'a' }), /Đã có việc tên "a"/);
    await assert.rejects(make({ title: 'B', depends_on: ['Không có'] }), /không có việc nào tên "Không có"/);
    assert.match(await make({ team: 'Team Frontend', title: 'B', depends_on: ['A'] }), /sau khi #\d+ xong/, 'gọi theo tên team và có phụ thuộc');
    await assert.rejects(make({ title: '' }), /Thiếu title/);
    for (const n of [3, 4, 5, 6]) await make({ title: `Việc ${n}` });
    await assert.rejects(make({ title: 'Quá' }), /bằng mức tối đa \(6\)/);

    assert.throws(() => ctx.runner.epics.setContract(plan, { contract: 'ngắn' }), /quá ngắn/);
    assert.match(ctx.runner.epics.setContract(plan, { contract: CONTRACT }), /Đã lưu hợp đồng/);
    assert.throws(() => ctx.runner.epics.finish(plan, { verdict: 'accept', report: 'đủ dài để qua' }), /Không kết thúc được lúc này/);

    // Công cụ chỉ dùng được đúng loại lượt: lượt lập kế hoạch không có finish_epic, Trưởng nhóm không có create_team_job.
    const token = 'ma-giam-doc';
    ctx.runner.agentRuns.set(token, plan.id);
    const denied = await ctx.runner.callAgentTool(token, 'finish_epic', { verdict: 'accept', report: 'đủ dài để qua' });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /không dùng được trong lượt làm việc này/);
    assert.equal((await ctx.runner.callAgentTool(token, 'assign_to_member', {})).isError, true);
    assert.match((await ctx.runner.callAgentTool(token, 'get_company_overview', {})).text, /## Team Backend[\s\S]*An .*còn nhận thêm[\s\S]*## Team Frontend[\s\S]*Cúc[\s\S]*## Team Chất lượng[\s\S]*Quân/);
    assert.doesNotMatch((await ctx.runner.callAgentTool(token, 'get_company_overview', {})).text, /Ban giám đốc|Hòa/);
    const overview = (await ctx.runner.callAgentTool(token, 'get_company_overview', {})).text;
    for (const [name, hint] of [['Team DevOps', /KHÔNG tự triển khai/], ['Team Thiết kế UI\/UX', /ĐẶC TẢ thiết kế/], ['Team Bảo mật', /KHÔNG sửa code chính/], ['Team Báo cáo', /MỘT tệp/]]) {
      assert.match(overview, new RegExp(`## ${name}[^\n]*\nPhạm vi: [^\n]*`), `${name} có dòng Phạm vi trong tổng quan`);
      assert.match(overview, hint);
    }
    ctx.runner.agentRuns.delete(token);
  } finally {
    await ctx.cleanup();
  }
});

test('tạo yêu cầu: kiểm tra đầu vào, danh sách công cụ theo loại lượt', async () => {
  const ctx = await boot();
  try {
    ctx.runner.setManualPause(true);
    await assert.rejects(newEpic(ctx, { title: ' ' }), /Thiếu tiêu đề/);
    await assert.rejects(newEpic(ctx, { prompt: '' }), /Thiếu mô tả/);
    // Giám đốc không nhận việc lẻ và không phải đích giao việc của team.
    await assert.rejects(ctx.runner.submit({ title: 'x', prompt: 'y', member: 'Hòa', level: 'normal' }), /Trưởng nhóm/);
    await assert.rejects(ctx.runner.jobs.create({ team: 'management', title: 'x', prompt: 'y' }), /chưa có nhân viên nào/);
  } finally {
    await ctx.cleanup();
  }
  const names = (kind) => toolsForKind(kind).map((t) => t.name).sort();
  assert.deepEqual(names('dplan'), ['create_team_job', 'get_company_overview', 'set_contract']);
  assert.deepEqual(names('dreview'), ['create_team_job', 'finish_epic', 'get_company_overview']);
  assert.deepEqual(names('plan'), ['assign_contest', 'assign_to_member', 'get_team_workload']);
  assert.deepEqual(names('review'), ['review_submission']);
  assert.deepEqual(names('work'), ['ask_colleague', 'ask_lead', 'ask_owner', 'call_meeting']);
  assert.deepEqual(names('answer'), [], 'lượt trả lời không có công cụ MCP nào');
});

test('API của yêu cầu, bảng tải team và nhật ký hội thoại', async () => {
  const ctx = await boot({ FAKE_DPLAN: dplan(), FAKE_PLANS: teamPlans });
  try {
    const base = `http://127.0.0.1:${ctx.app.port}`;
    const headers = { host: `localhost:${ctx.app.port}`, 'content-type': 'application/json' };
    const post = (p, body = {}) => fetch(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const get = (p) => fetch(`${base}${p}`, { headers: { host: headers.host } });

    const bad = await post('/api/epics', { title: '', prompt: 'x' });
    assert.equal(bad.status, 400);
    const created = await post('/api/epics', { title: 'Qua HTTP', prompt: 'Thêm đăng nhập', acceptance: 'test qua' });
    assert.equal(created.status, 201);
    const { epic } = await created.json();
    await epicIn(ctx, epic.id, ['awaiting_plan']);

    const detail = await (await get(`/api/epics/${epic.id}`)).json();
    assert.equal(detail.epic.status, 'awaiting_plan');
    assert.equal(detail.jobs.length, 3);
    assert.deepEqual(detail.tasks.map((t) => t.kind), ['dplan']);
    assert.equal((await get('/api/epics/999')).status, 404);
    assert.equal((await get('/api/epics')).status, 200);

    assert.equal((await post(`/api/epics/${epic.id}/approve-result`)).status, 400, 'chưa tới lúc duyệt kết quả');
    assert.equal((await post(`/api/epics/${epic.id}/reject-plan`, { feedback: 'x' })).status, 400, 'nhận xét quá ngắn');
    assert.equal((await post(`/api/epics/${epic.id}/approve-plan`)).status, 200);
    await epicIn(ctx, epic.id, ['awaiting_result', 'attention', 'failed']);
    const approved = await post(`/api/epics/${epic.id}/approve-result`);
    assert.equal((await approved.json()).epic.status, 'done');

    const workload = await (await get('/api/workload')).json();
    assert.deepEqual(workload.teams.map((t) => t.id).sort(), ['backend', 'design', 'devops', 'frontend', 'management', 'quality', 'report', 'security']);
    const backend = workload.teams.find((t) => t.id === 'backend');
    assert.deepEqual(backend.workers.map((w) => w.name), ['An', 'Bình', 'Hương']);
    assert.equal(workload.teams.find((t) => t.id === 'management').workers.length, 0);

    const feed = await (await get('/api/feed?limit=200')).json();
    const kinds = new Set(feed.events.map((e) => e.kind));
    assert.ok(kinds.has('job') && kinds.has('review') && kinds.has('tool'), 'nhật ký hội thoại gồm giao việc, duyệt bài và lệnh gọi công cụ của công ty');
    assert.ok(feed.events.filter((e) => e.kind === 'tool').every((e) => e.summary.startsWith('mcp__company__')));
    assert.ok(feed.events.some((e) => e.member === 'Hòa') && feed.events.some((e) => e.member === 'Minh'), 'có cả Giám đốc và Trưởng nhóm');
    assert.equal((await post(`/api/epics/${epic.id}/stop`)).status, 200, 'dừng yêu cầu đã xong thì không lỗi');
  } finally {
    await ctx.cleanup();
  }
});

test('cơ sở dữ liệu giai đoạn 2 được nâng cấp thêm cột cho jobs và bảng epics', () => {
  const root = tmpDir();
  try {
    const file = path.join(root, 'cu.db');
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, prompt TEXT NOT NULL, acceptance TEXT NOT NULL DEFAULT '', team TEXT NOT NULL, lead TEXT NOT NULL, status TEXT NOT NULL, summary TEXT, error TEXT, base_commit TEXT, merge_branch TEXT, merge_worktree TEXT, conflict_files TEXT, plan_task_id INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER)");
    old.exec("INSERT INTO jobs (title, prompt, team, lead, status, created_at) VALUES ('cũ', 'p', 'backend', 'Minh', 'done', 1)");
    old.close();
    const store = openDb(file);
    const job = store.getJob(1);
    assert.deepEqual([job.epic_id, job.depends_on, job.round], [null, null, 0]);
    const epic = store.createEpic({ title: 'e', prompt: 'p', director: 'Hòa' });
    assert.deepEqual([epic.status, epic.round, epic.replans], ['planning', 0, 0]);
    const draft = store.createJob({ title: 't', prompt: 'p', team: 'backend', lead: 'Minh', epicId: epic.id, dependsOn: [1], status: 'waiting' });
    assert.deepEqual(JSON.parse(draft.depends_on), [1]);
    store.deleteUnstartedJobs(epic.id);
    assert.equal(store.epicJobs(epic.id).length, 0);
    store.close();
  } finally {
    removeDir(root);
  }
});
