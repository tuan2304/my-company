import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ownerRequests } from '../server/owner-requests.mjs';
import { startServer } from '../server/index.mjs';
import { validateSets } from '../server/contest.mjs';
import { composeSkillPack } from '../server/skills.mjs';
import { REPO, git, makeProject, removeDir, testConfig, tmpDir, waitFor } from './helpers.mjs';

const FAKE_KEYS = ['FAKE_CLAUDE_LOG', 'FAKE_PLAN', 'FAKE_CONTEST', 'FAKE_UNIQUE', 'FAKE_WORK_DELAY_MS', 'FAKE_BROWSER_FAIL', 'FAKE_REVIEW'];
const LOCK = path.join(REPO, 'skills.lock');
const FIXTURES = path.join(REPO, 'tests', 'fixtures');
const SETS = { a: ['impeccable', 'ui-ux-pro-max'], b: ['design-taste-frontend', 'ui-ux-pro-max'] };
const CONTEST = (extra = {}) => JSON.stringify({ members: ['An', 'Bình'], title: 'Trang chủ', description: 'Làm trang chủ cho cửa hàng', acceptance: 'Có tiêu đề và danh sách sản phẩm', files: ['src'], ...extra });

/** Dự án thử có khai `preview` (máy chủ giả và trình duyệt giả) để kiểm tra bước chụp ảnh. */
async function boot({ preview = true, env = {} } = {}) {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  if (preview) {
    const file = path.join(local, 'project.md');
    const text = fs.readFileSync(file, 'utf8').replace(
      'conventions:',
      `preview:\n  command: node ${JSON.stringify(path.join(FIXTURES, 'preview-server.mjs')).replaceAll('\\\\', '/')} {port}\n  url: http://127.0.0.1:{port}\n  pages: [/, /gio-hang]\n  wait_seconds: 20\nconventions:`,
    );
    fs.writeFileSync(file, text);
  }
  const cfg = testConfig(root, project, local, { shotBrowser: [process.execPath, path.join(FIXTURES, 'fake-browser.mjs')] });
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

const newContest = (ctx, over = {}) => ctx.runner.jobs.create({ team: 'backend', title: 'Làm trang chủ', prompt: 'Làm trang chủ', contest: SETS, ...over });
const status = (ctx, id, ...wanted) => waitFor(() => wanted.includes(ctx.store.getJob(id).status) && ctx.store.getJob(id), { timeout: 40000, label: `việc lớn #${id} sang ${wanted.join('/')}` });
// Gói skill bị dọn khi xong việc, nên đọc danh sách mà fake-claude ghi lại lúc đang chạy.
const skillsIn = (call) => call.pluginSkills;

test('validateSets: chặn bộ trống, skill chưa duyệt, tên lạ, hai bộ giống nhau; nhận đúng cả khóa a/b', () => {
  assert.deepEqual(validateSets(SETS, LOCK), { A: SETS.a, B: SETS.b });
  assert.throws(() => validateSets({ a: [], b: ['impeccable'] }, LOCK), /Bộ skill A đang trống/);
  assert.throws(() => validateSets({ a: ['impeccable'], b: ['khong-co-skill'] }, LOCK), /chưa được duyệt/);
  assert.throws(() => validateSets({ a: ['impeccable'], b: ['../impeccable'] }, LOCK), /không hợp lệ/);
  assert.throws(() => validateSets({ a: ['impeccable', 'ponytail'], b: ['ponytail', 'impeccable'] }, LOCK), /giống hệt/);
  assert.throws(() => validateSets({ a: ['a1', 'a2', 'a3', 'a4', 'a5'], b: ['impeccable'] }, LOCK), /quá 4 skill/);
});

test('composeSkillPack: bộ skill của việc thay phần đem ra so sánh, giữ nguyên phần chung và skill theo công nghệ', () => {
  const dir = tmpDir();
  try {
    const role = { id: 'frontend-dev', skills: ['ponytail', 'impeccable'], stack_skills: { react: ['react-best-practices'] } };
    const libraryDir = path.join(REPO, 'skills', 'library');
    const exclude = [...SETS.a, ...SETS.b];
    const pack = (skillSet) => composeSkillPack({ libraryDir, lockFile: LOCK, role, project: { stack: ['React'] }, outDir: path.join(dir, String(skillSet?.[0])), skillSet, excludeSkills: exclude });
    const a = pack(SETS.a);
    const b = pack(SETS.b);
    assert.deepEqual([...a.loaded].sort(), ['impeccable', 'ponytail', 'react-best-practices', 'ui-ux-pro-max']);
    assert.deepEqual([...b.loaded].sort(), ['design-taste-frontend', 'ponytail', 'react-best-practices', 'ui-ux-pro-max']);
    assert.deepEqual(a.skipped.concat(b.skipped), []);
    // Việc thường (không có bộ riêng) giữ nguyên hành vi cũ.
    const plain = composeSkillPack({ libraryDir, lockFile: LOCK, role, project: { stack: ['React'] }, outDir: path.join(dir, 'plain') });
    assert.deepEqual([...plain.loaded].sort(), ['impeccable', 'ponytail', 'react-best-practices']);
    // Skill của bộ nhưng chưa duyệt vẫn bị bỏ qua, không nạp lén.
    const bad = pack(['impeccable', 'skill-chua-duyet']);
    assert.ok(bad.skipped.some((s) => s.name === 'skill-chua-duyet'));
  } finally {
    removeDir(dir);
  }
});

test('thi đấu đầy đủ: Trưởng nhóm giao cùng một việc cho hai người (được trùng phạm vi), chụp ảnh ẩn danh, chủ chọn, chỉ nhánh thắng được gộp', async () => {
  const ctx = await boot({ env: { FAKE_CONTEST: CONTEST() } });
  try {
    const job = await newContest(ctx);
    assert.equal(job.status, 'planning');
    assert.deepEqual(JSON.parse(job.contest).sets, { A: SETS.a, B: SETS.b });

    const ready = await status(ctx, job.id, 'awaiting_choice', 'failed');
    assert.equal(ready.status, 'awaiting_choice', ready.error ?? '');

    // Hai việc con giống nhau, cùng phạm vi (được miễn luật chồng lấn), khác người, mỗi việc một bộ skill; không có lượt duyệt bài riêng.
    const tasks = ctx.store.jobTasks(job.id);
    const work = tasks.filter((t) => t.kind === 'work');
    assert.equal(work.length, 2);
    assert.deepEqual(work.map((t) => t.member).sort(), ['An', 'Bình']);
    assert.equal(work[0].prompt, work[1].prompt);
    assert.deepEqual(work.map((t) => t.files), [JSON.stringify(['src']), JSON.stringify(['src'])]);
    assert.deepEqual(work.map((t) => t.level), ['normal', 'normal'], 'cố định mức độ khó cho công bằng');
    assert.deepEqual(work.map((t) => t.status), ['submitted', 'submitted']);
    assert.equal(tasks.filter((t) => t.kind === 'review').length, 0);
    assert.deepEqual(work.map((t) => JSON.parse(t.skill_set)).sort(), [SETS.a, SETS.b].sort());
    assert.equal(work[0].base_commit, work[1].base_commit, 'cùng một mã gốc');
    assert.notEqual(work[0].branch, work[1].branch);

    // Mỗi người chỉ được nạp bộ skill của mình.
    const calls = ctx.calls().filter((c) => c.args.includes('--plugin-dir'));
    const byTask = new Map(work.map((t) => [t.id, JSON.parse(t.skill_set)]));
    assert.equal(calls.length, 2);
    for (const call of calls) {
      const loaded = skillsIn(call);
      const mine = [...byTask.values()].find((set) => set.every((n) => loaded.includes(n)));
      const other = [...byTask.values()].find((set) => set !== mine);
      assert.ok(mine, `phải nạp trọn một bộ: ${loaded}`);
      assert.ok(other.filter((n) => !mine.includes(n)).every((n) => !loaded.includes(n)), 'không nạp skill riêng của bên kia');
    }

    // Chủ đang được chờ (đèn "Chờ bạn quyết" trên Trưởng nhóm) và có ảnh cho cả hai phương án, chưa lộ danh tính.
    const waiting = ownerRequests([], ctx.store.listJobs(), tasks);
    assert.deepEqual(waiting.map((r) => [r.kind, r.status, r.who]), [['job', 'awaiting_choice', ready.lead]]);
    const before = ctx.runner.jobs.contests.view(job.id);
    assert.equal(before.status, 'ready');
    assert.equal(before.options.length, 2);
    for (const o of before.options) {
      assert.equal(o.images.length, 2, 'hai trang: / và /gio-hang');
      assert.match(o.images[0].src, /^data:image\/png;base64,/);
      assert.equal(o.member, undefined);
      assert.equal(o.skills, undefined);
      assert.equal(o.label, undefined);
    }
    assert.equal(before.sets, undefined);
    assert.doesNotMatch(JSON.stringify(before), /An|Bình|impeccable|design-taste/);
    // Hai ảnh khác nhau vì chụp từ hai nhánh khác nhau.
    assert.notEqual(before.options[0].images[0].src, before.options[1].images[0].src);

    // Chọn phương án 2 qua HTTP.
    const host = { host: `localhost:${ctx.app.port}`, 'content-type': 'application/json' };
    const base = `http://127.0.0.1:${ctx.app.port}`;
    const viewHttp = await (await fetch(`${base}/api/jobs/${job.id}/contest`, { headers: { host: host.host } })).json();
    assert.equal(viewHttp.contest.options.length, 2);
    const bad = await fetch(`${base}/api/jobs/${job.id}/contest/choose`, { method: 'POST', headers: host, body: JSON.stringify({ option: 3 }) });
    assert.equal(bad.status, 400);
    const chosen = await fetch(`${base}/api/jobs/${job.id}/contest/choose`, { method: 'POST', headers: host, body: JSON.stringify({ option: 2 }) });
    assert.equal(chosen.status, 200);
    const after = (await chosen.json()).contest;
    assert.equal(after.status, 'chosen');
    const win = after.options.find((o) => o.winner);
    const lose = after.options.find((o) => !o.winner);
    assert.equal(win.option, 2);
    assert.deepEqual(after.winnerSkills, win.skills);

    const done = ctx.store.getJob(job.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(done.merge_branch, `company/job${job.id}`);
    const winnerTask = work.find((t) => t.member === win.member);
    const loserTask = work.find((t) => t.member === lose.member);
    assert.equal(ctx.store.getTask(winnerTask.id).verdict, 'contest_win');
    assert.equal(ctx.store.getTask(loserTask.id).verdict, 'contest_lost');
    assert.deepEqual([winnerTask, loserTask].map((t) => ctx.store.getTask(t.id).status), ['done', 'done']);
    // Chỉ file của nhánh thắng nằm trong nhánh gộp; nhánh thua vẫn còn nguyên.
    const merged = git(ctx.project, 'ls-tree', '-r', '--name-only', done.merge_branch).split('\n');
    assert.ok(merged.includes(`out-${path.basename(winnerTask.worktree)}.txt`));
    assert.ok(!merged.includes(`out-${path.basename(loserTask.worktree)}.txt`));
    assert.ok(git(ctx.project, 'branch', '--list', loserTask.branch).includes(loserTask.branch));
    assert.equal(git(ctx.project, 'rev-parse', 'main'), done.base_commit, 'nhánh chính không bị đụng');

    // Chọn lần hai bị từ chối; bộ skill thắng chỉ lộ sau khi chọn.
    const again = await fetch(`${base}/api/jobs/${job.id}/contest/choose`, { method: 'POST', headers: host, body: JSON.stringify({ option: 1 }) });
    assert.equal(again.status, 400);
    assert.equal(ownerRequests([], ctx.store.listJobs(), ctx.store.jobTasks(job.id)).length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('thi đấu: hồ sơ chưa khai preview hoặc trình duyệt lỗi thì không có ảnh nhưng vẫn chọn được và nói rõ lý do', async () => {
  for (const scenario of [{ preview: false, expect: /chưa khai mục "preview"/ }, { preview: true, env: { FAKE_BROWSER_FAIL: '1' }, expect: /không chụp ra ảnh nào/ }]) {
    const ctx = await boot({ preview: scenario.preview, env: { FAKE_CONTEST: CONTEST(), ...scenario.env } });
    try {
      const job = await newContest(ctx);
      assert.equal((await status(ctx, job.id, 'awaiting_choice', 'failed')).status, 'awaiting_choice');
      const view = ctx.runner.jobs.contests.view(job.id);
      assert.equal(view.hasPreview, scenario.preview);
      for (const o of view.options) {
        assert.deepEqual(o.images, []);
        assert.match(o.shotError, scenario.expect);
      }
      await ctx.runner.jobs.contests.choose(job.id, 1);
      assert.equal(ctx.store.getJob(job.id).status, 'done');
    } finally {
      await ctx.cleanup();
    }
  }
});

test('thi đấu: assign_to_member bị từ chối ở việc thi đấu, assign_contest bị từ chối ở việc thường', async () => {
  // Việc thi đấu mà Trưởng nhóm dùng nhầm assign_to_member: bị từ chối nên không có việc con.
  let ctx = await boot({ env: { FAKE_PLAN: JSON.stringify([{ member: 'An', title: 'x', description: 'y', files: ['src'] }]) } });
  try {
    const job = await newContest(ctx);
    const failed = await status(ctx, job.id, 'failed');
    assert.match(failed.error, /không gọi assign_contest/);
    assert.ok(ctx.store.listEvents(job.plan_task_id).some((e) => e.kind === 'tool_error' && /assign_contest/.test(e.summary)));
  } finally {
    await ctx.cleanup();
  }
  // Việc thường mà gọi assign_contest.
  ctx = await boot({ env: { FAKE_CONTEST: CONTEST() } });
  try {
    const job = await ctx.runner.jobs.create({ team: 'backend', title: 'Việc thường', prompt: 'x' });
    const failed = await status(ctx, job.id, 'failed');
    assert.equal(ctx.store.jobTasks(job.id).filter((t) => t.kind === 'work').length, 0);
    assert.ok(ctx.store.listEvents(job.plan_task_id).some((e) => e.kind === 'tool_error' && /không phải thi đấu skill/.test(e.summary)), failed.error ?? '');
  } finally {
    await ctx.cleanup();
  }
});

test('thi đấu: kiểm tra đầu vào khi giao việc (bộ skill, số người) và khi Trưởng nhóm chọn người', async () => {
  const ctx = await boot({ env: { FAKE_CONTEST: CONTEST({ members: ['An', 'An'] }) } });
  try {
    await assert.rejects(ctx.runner.jobs.create({ team: 'backend', title: 't', prompt: 'p', contest: { a: ['impeccable'], b: ['khong-co'] } }), /chưa được duyệt/);
    await assert.rejects(ctx.runner.jobs.create({ team: 'backend', title: 't', prompt: 'p', contest: { a: ['impeccable'], b: ['impeccable'] } }), /giống hệt/);
    assert.equal(ctx.store.listJobs().length, 0, 'bộ skill sai thì không tạo việc lớn');
    const host = { host: `localhost:${ctx.app.port}`, 'content-type': 'application/json' };
    const http = await fetch(`http://127.0.0.1:${ctx.app.port}/api/jobs`, { method: 'POST', headers: host, body: JSON.stringify({ team: 'backend', title: 't', prompt: 'p', contest: { a: [], b: ['impeccable'] } }) });
    assert.equal(http.status, 400);

    // Trưởng nhóm chọn cùng một người hai lần: bị từ chối.
    const job = await newContest(ctx);
    await status(ctx, job.id, 'failed');
    assert.ok(ctx.store.listEvents(job.plan_task_id).some((e) => e.kind === 'tool_error' && /HAI nhân viên khác nhau/.test(e.summary)));
  } finally {
    await ctx.cleanup();
  }
});

test('thi đấu: chọn bản không còn ở trạng thái đã nộp hoặc phương án không có thì bị từ chối và cuộc thi vẫn nguyên', async () => {
  const ctx = await boot({ env: { FAKE_CONTEST: CONTEST() } });
  try {
    const job = await newContest(ctx);
    await status(ctx, job.id, 'awaiting_choice');
    await assert.rejects(ctx.runner.jobs.contests.choose(job.id, 5), /không hợp lệ/);
    // Một bài bị dừng sau khi nộp: chọn đúng bản đó bị từ chối.
    const contest = JSON.parse(ctx.store.getJob(job.id).contest);
    const entry = contest.entries[0];
    ctx.store.updateTask(entry.task_id, { status: 'stopped' });
    await assert.rejects(ctx.runner.jobs.contests.choose(job.id, contest.order.indexOf(entry.label) + 1), /không còn ở trạng thái đã nộp/);
    assert.equal(ctx.store.getJob(job.id).status, 'awaiting_choice');
    assert.equal(JSON.parse(ctx.store.getJob(job.id).contest).status, 'ready');
    // Bản còn lại vẫn chọn được.
    const other = contest.entries[1];
    await ctx.runner.jobs.contests.choose(job.id, contest.order.indexOf(other.label) + 1);
    assert.equal(ctx.store.getJob(job.id).status, 'done');
  } finally {
    await ctx.cleanup();
  }
});
