import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { openDb } from '../server/db.mjs';
import { ensureDirs } from '../server/config.mjs';
import { loadProject } from '../server/project.mjs';
import { buildAllowedTools, buildClaudeArgs, buildSystemPrompt, claimedChangedFiles, guardEnv, Runner, UserError } from '../server/runner.mjs';
import { loadTeams, findMember } from '../server/teams.mjs';
import { nextTier, parseTriage } from '../server/triage.mjs';
import { commitWorktree, createWorktree, parsePorcelainZ, safeName } from '../server/worktree.mjs';
import { git, makeProject, removeDir, testConfig, tmpDir, waitFor, REPO } from './helpers.mjs';

async function setup(overrides = {}, env = {}) {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg = testConfig(root, project, local, overrides);
  ensureDirs(cfg);
  const logFile = path.join(root, 'fake.log');
  Object.assign(process.env, { FAKE_CLAUDE_LOG: logFile, ...env });
  const store = openDb(path.join(cfg.dataDir, 'company.db'));
  const teams = loadTeams({ teamsDir: path.join(REPO, 'teams') });
  const runner = new Runner({ cfg, store, getTeams: () => teams, getProject: () => loadProject(local) });
  runner.start();
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const cleanup = async () => {
    await runner.shutdown();
    store.close();
    for (const key of ['FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_SCENARIO', 'FAKE_CLAUDE_RESET_IN', 'FAKE_CLAUDE_TRIAGE', 'ANTHROPIC_API_KEY', 'CLAUDECODE']) delete process.env[key];
    removeDir(root);
  };
  return { root, project, cfg, store, runner, calls, cleanup };
}

// Các bài kiểm thử cũ chọn tay mức Bình thường để không phải qua bước tự đánh giá.
const job = { title: 'Tạo hello', prompt: 'Tạo file hello.txt', member: 'An', level: 'normal' };

test('việc thành công: có nhánh riêng, commit, kết quả, mức dùng, và gỡ khóa API khỏi môi trường con', async () => {
  const ctx = await setup({}, { ANTHROPIC_API_KEY: 'sk-ant-zzzzzzzzzzzz', CLAUDECODE: '1' });
  try {
    const submitted = await ctx.runner.submit(job);
    const task = await waitFor(() => ctx.store.getTask(submitted.id).status === 'done' && ctx.store.getTask(submitted.id), { label: 'việc xong' });

    assert.equal(task.member, 'An');
    assert.equal(task.branch, `company/an-task${task.id}`);
    assert.match(task.result, /hello\.txt/);
    assert.deepEqual(JSON.parse(task.changed_files), ['hello.txt']);
    assert.equal(task.session_id, 'fake-session-1234');
    assert.equal(task.input_tokens, 10);
    assert.equal(task.output_tokens, 20);
    assert.equal(task.cache_read_tokens, 300);
    assert.equal(task.cache_creation_tokens, 400);
    assert.equal(task.est_cost_usd, 0.05);
    assert.equal(task.turns, 3);

    // Nhánh có commit chứa file mới và nhánh chính của dự án không bị đụng.
    assert.equal(git(ctx.project, 'show', `${task.branch}:hello.txt`), 'xin chào');
    assert.equal(git(ctx.project, 'rev-parse', 'main'), task.base_commit);
    assert.ok(fs.existsSync(task.worktree));

    const [call] = ctx.calls();
    assert.equal(call.hasApiKey, false, 'khóa API không được lọt vào tiến trình con');
    assert.equal(call.hasNestedVar, false);
    assert.equal(call.cwd, fs.realpathSync(task.worktree));
    assert.match(call.prompt, /Tạo file hello\.txt/);
    const flag = (name) => call.args[call.args.indexOf(name) + 1];
    assert.equal(flag('--setting-sources'), 'project,local');
    assert.equal(flag('--model'), 'sonnet');
    assert.equal(flag('--permission-mode'), 'default', 'acceptEdits cho phép Bash ghi file và lách hook chặn thư mục');
    assert.ok(call.args.includes('--strict-mcp-config'));
    assert.ok(!call.args.includes('--bare'));
    assert.match(flag('--allowedTools'), /Bash\(npm test\)/);
    assert.match(flag('--disallowedTools'), /git push/);

    // Gói skill thật của vai trò Backend được ghép cho dự án "Node": không có skill theo công nghệ Supabase.
    const pluginDir = flag('--plugin-dir');
    assert.equal(flag('--tools').split(',').at(-1), 'Skill');
    // Thư mục plugin chỉ cần lúc tiến trình chạy: xong việc là bị dọn (không để mỗi run một bản chép của cả gói skill).
    const loadedEvent = ctx.store.listEvents(task.id).find((e) => e.kind === 'system' && /^Skill nạp: /.test(e.summary));
    assert.deepEqual(loadedEvent.summary.replace('Skill nạp: ', '').split(', ').sort(), ['ponytail', 'sharp-edges', 'systematic-debugging', 'test-driven-development', 'verification-before-completion']);
    assert.equal(path.basename(pluginDir), 'plugin');
    await waitFor(() => !fs.existsSync(pluginDir), { label: 'dọn thư mục plugin của run' });
    assert.ok(fs.existsSync(path.join(path.dirname(pluginDir), 'system.md')), 'chỉ xóa plugin, các file khác của run còn nguyên');

    const events = ctx.store.listEvents(task.id);
    assert.ok(events.some((e) => e.kind === 'tool' && /Write: hello\.txt/.test(e.summary)));
    const said = events.filter((e) => e.kind === 'say').map((e) => e.summary).join('\n');
    assert.doesNotMatch(said, /sk-ant-abcdefghijklmnop/, 'secret trong lời nói của agent phải được che');
    assert.equal(ctx.store.getState('rate_limit').windows.five_hour.utilization, 0.4);
  } finally {
    await ctx.cleanup();
  }
});

test('thư mục nối và file chép: hook cho đọc node_modules, Claude Code được khai --add-dir, AGENTS.md bị gitignore vẫn có trong worktree mà không bị commit', async () => {
  const ctx = await setup();
  try {
    // Dự án như web96: AGENTS.md nằm trong .gitignore (worktree tạo từ commit nên không có), node_modules có thật ở gốc.
    fs.writeFileSync(path.join(ctx.project, '.gitignore'), '/AGENTS.md\n/node_modules\n');
    git(ctx.project, 'add', '-A');
    git(ctx.project, 'commit', '-q', '-m', 'ignore');
    fs.writeFileSync(path.join(ctx.project, 'AGENTS.md'), '# Quy ước\n');
    fs.mkdirSync(path.join(ctx.project, 'node_modules', 'goi'), { recursive: true });
    fs.writeFileSync(path.join(ctx.project, 'node_modules', 'goi', 'index.js'), '1\n');
    fs.writeFileSync(
      path.join(ctx.root, 'local', 'project.md'),
      ['---', 'name: proj', 'folders:', '  backend: [src]', 'allowed_commands: [npm test]', 'worktree_copies: [AGENTS.md, .env, khong-co.md]', '---', ''].join('\n'),
    );

    const { id } = await ctx.runner.submit(job);
    const task = await waitFor(() => ctx.store.getTask(id).status === 'done' && ctx.store.getTask(id), { label: 'việc xong' });
    const [call] = ctx.calls();
    const realDeps = fs.realpathSync.native(path.join(ctx.project, 'node_modules'));
    assert.deepEqual(call.args.filter((_, i) => call.args[i - 1] === '--add-dir'), [realDeps]);
    assert.equal(call.guard.links, '["node_modules"]');
    assert.equal(fs.readFileSync(path.join(task.worktree, 'AGENTS.md'), 'utf8'), '# Quy ước\n', 'file gitignore được chép vào worktree');
    assert.ok(!fs.existsSync(path.join(task.worktree, '.env')), 'không bao giờ chép .env');
    assert.deepEqual(JSON.parse(task.changed_files), ['hello.txt'], 'AGENTS.md và node_modules không tính là file đã đổi');
    assert.throws(() => git(ctx.project, 'show', `${task.branch}:AGENTS.md`), 'không commit file đã chép');
    const created = ctx.store.listEvents(id).find((e) => e.kind === 'system' && /Tạo nhánh riêng/.test(e.summary));
    assert.match(created.summary, /nối node_modules; chép AGENTS\.md từ dự án/);
  } finally {
    await ctx.cleanup();
  }
});

test('hết hạn mức: cả công ty tạm dừng rồi tự làm tiếp bằng --resume', async () => {
  const ctx = await setup({}, { FAKE_CLAUDE_SCENARIO: 'quota', FAKE_CLAUDE_RESET_IN: '2' });
  try {
    const { id } = await ctx.runner.submit(job);
    const paused = await waitFor(() => ctx.store.getTask(id).status === 'paused_quota' && ctx.store.getTask(id), { label: 'tạm dừng vì hạn mức' });
    assert.ok(paused.resume_at > Date.now() - 1000);
    assert.equal(paused.session_id, 'fake-session-1234');
    assert.ok(ctx.runner.snapshot().pausedUntil > 0, 'công ty ở trạng thái nghỉ');
    assert.equal(ctx.runner.snapshot().pauseReason, 'quota');

    // Việc khác giao lúc đang nghỉ thì phải chờ, không được chạy.
    const other = await ctx.runner.submit({ ...job, title: 'Việc khác', member: 'Bình' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ctx.store.getTask(other.id).status, 'queued');
    assert.equal(ctx.calls().length, 1);

    const done = await waitFor(() => ctx.store.getTask(id).status === 'done' && ctx.store.getTask(id), { timeout: 20000, label: 'làm tiếp sau khi hạn mức hồi' });
    assert.equal(done.attempts, 2);
    assert.match(done.result, /làm tiếp/);
    const resumedCall = ctx.calls().find((c) => c.resumed);
    assert.ok(resumedCall, 'lần chạy lại phải dùng --resume');
    assert.equal(resumedCall.args[resumedCall.args.indexOf('--resume') + 1], 'fake-session-1234');
    assert.ok(ctx.store.listEvents(id).some((e) => e.kind === 'quota' && /Hết hạn mức Pro/.test(e.summary)));
  } finally {
    await ctx.cleanup();
  }
});

test('việc quá số lượt hoặc tiến trình lỗi: báo lỗi và giữ lại phần đã làm', async () => {
  const ctx = await setup({}, { FAKE_CLAUDE_SCENARIO: 'maxturns' });
  try {
    const { id } = await ctx.runner.submit(job);
    const task = await waitFor(() => ctx.store.getTask(id).status === 'failed' && ctx.store.getTask(id), { timeout: 30000, label: 'việc lỗi' });
    assert.match(task.error, /error_max_turns/);
    assert.deepEqual(JSON.parse(task.changed_files), ['hello.txt']);
    assert.equal(git(ctx.project, 'show', `${task.branch}:hello.txt`), 'xin chào');
    // Hết lượt: nâng bậc nếu còn bậc, rồi hệ thống tự cho làm tiếp một lần, rồi mới chịu thua (việc lẻ không có Trưởng nhóm để nộp phần dở).
    assert.equal(task.auto_continues, 1);
    assert.equal(task.attempts, 2 + task.escalations, 'nâng bậc (nếu còn bậc) + tự làm tiếp một lần + lần cuối chịu thua');
  } finally {
    await ctx.cleanup();
  }

  const crash = await setup({}, { FAKE_CLAUDE_SCENARIO: 'crash' });
  try {
    const { id } = await crash.runner.submit(job);
    const task = await waitFor(() => crash.store.getTask(id).status === 'failed' && crash.store.getTask(id), { label: 'việc lỗi do crash' });
    assert.match(task.error, /thoát bất thường/);
    assert.match(task.error, /lỗi giả lập/);
  } finally {
    await crash.cleanup();
  }
});

test('nút dừng: dừng được việc đang chạy và việc đang chờ', async () => {
  const ctx = await setup({ maxConcurrent: 1 }, { FAKE_CLAUDE_SCENARIO: 'hang' });
  try {
    const first = await ctx.runner.submit(job);
    await waitFor(() => ctx.store.getTask(first.id).session_id, { label: 'agent đã khởi động' });
    const second = await ctx.runner.submit({ ...job, title: 'Việc hai', member: 'Bình' });
    assert.equal(ctx.store.getTask(second.id).status, 'queued', 'trần chạy đồng thời = 1');

    assert.equal(ctx.runner.stop(second.id), true);
    assert.equal(ctx.store.getTask(second.id).status, 'stopped');

    assert.equal(ctx.runner.stop(first.id), true);
    const stopped = await waitFor(() => ctx.store.getTask(first.id).status === 'stopped' && ctx.store.getTask(first.id), { label: 'việc đã dừng' });
    assert.match(stopped.error, /dừng/);
    assert.equal(ctx.runner.snapshot().running.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('mỗi nhân viên chỉ làm một việc một lúc; hai người khác nhau chạy song song', async () => {
  const ctx = await setup({ maxConcurrent: 2 }, { FAKE_CLAUDE_SCENARIO: 'hang' });
  try {
    const a1 = await ctx.runner.submit(job);
    const a2 = await ctx.runner.submit({ ...job, title: 'Việc hai của An' });
    const b1 = await ctx.runner.submit({ ...job, title: 'Việc của Bình', member: 'Bình' });
    await waitFor(() => ctx.store.getTask(a1.id).session_id && ctx.store.getTask(b1.id).session_id, { label: 'hai agent chạy' });
    assert.equal(ctx.store.getTask(a1.id).status, 'running');
    assert.equal(ctx.store.getTask(b1.id).status, 'running');
    assert.equal(ctx.store.getTask(a2.id).status, 'queued', 'An đang bận');
  } finally {
    await ctx.cleanup();
  }
});

test('tạm dừng thủ công không cho việc mới bắt đầu cho đến khi bỏ tạm dừng', async () => {
  const ctx = await setup();
  try {
    ctx.runner.setManualPause(true);
    const { id } = await ctx.runner.submit(job);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ctx.store.getTask(id).status, 'queued');
    ctx.runner.setManualPause(false);
    await waitFor(() => ctx.store.getTask(id).status === 'done', { label: 'việc chạy sau khi bỏ tạm dừng' });
  } finally {
    await ctx.cleanup();
  }
});

test('độ khó chọn model: easy dùng haiku, hard dùng opus, normal theo vai trò', async () => {
  const ctx = await setup();
  try {
    const easy = await ctx.runner.submit({ ...job, title: 'Dễ', level: 'easy' });
    const done1 = await waitFor(() => ctx.store.getTask(easy.id).status === 'done' && ctx.store.getTask(easy.id), { label: 'việc dễ xong' });
    assert.deepEqual([done1.model, done1.effort], ['haiku', 'low']);

    const hard = await ctx.runner.submit({ ...job, title: 'Khó', level: 'hard' });
    const done2 = await waitFor(() => ctx.store.getTask(hard.id).status === 'done' && ctx.store.getTask(hard.id), { label: 'việc khó xong' });
    assert.deepEqual([done2.model, done2.effort], ['opus', 'high']);

    const normal = await ctx.runner.submit({ ...job, title: 'Thường' });
    const done3 = await waitFor(() => ctx.store.getTask(normal.id).status === 'done' && ctx.store.getTask(normal.id), { label: 'việc thường xong' });
    assert.deepEqual([done3.model, done3.effort], ['sonnet', 'medium']);

    const flags = ctx.calls().map((c) => [c.args[c.args.indexOf('--model') + 1], c.args[c.args.indexOf('--effort') + 1]]);
    assert.deepEqual(flags, [['haiku', 'low'], ['opus', 'high'], ['sonnet', 'medium']]);

    await assert.rejects(ctx.runner.submit({ ...job, level: 'fable' }), (e) => e instanceof UserError && /không hợp lệ/.test(e.message));
  } finally {
    await ctx.cleanup();
  }
});

test('tự đánh giá độ khó: việc khó dùng opus, việc dễ dùng haiku, kèm lý do', async () => {
  for (const [verdict, model, effort, label] of [['hard', 'opus', 'high', 'Khó'], ['easy', 'haiku', 'low', 'Đơn giản']]) {
    const ctx = await setup({}, { FAKE_CLAUDE_TRIAGE: verdict, ANTHROPIC_API_KEY: 'sk-ant-zzzzzzzzzzzz' });
    try {
      const { id } = await ctx.runner.submit({ title: 'Việc cần đánh giá', prompt: 'Làm gì đó', member: 'An' });
      const task = await waitFor(() => ctx.store.getTask(id).status === 'done' && ctx.store.getTask(id), { label: 'việc xong' });
      assert.equal(task.level, verdict);
      assert.equal(task.level_source, 'auto');
      assert.match(task.level_reason, new RegExp(`mức ${verdict}`));
      assert.deepEqual([task.model, task.effort], [model, effort]);
      assert.ok(task.input_tokens >= 10, 'token của bước đánh giá được cộng vào việc');
      const triageEvent = ctx.store.listEvents(id).find((e) => e.kind === 'triage');
      assert.match(triageEvent.summary, new RegExp(`${label} → ${model}`));

      const [triageCall, mainCall] = ctx.calls();
      assert.equal(triageCall.isTriage, true);
      const flag = (call, name) => call.args[call.args.indexOf(name) + 1];
      assert.equal(flag(triageCall, '--model'), 'haiku', 'bước đánh giá luôn dùng model thấp nhất');
      assert.equal(flag(triageCall, '--tools'), '', 'bước đánh giá không có công cụ nào');
      assert.equal(flag(triageCall, '--max-turns'), '1');
      assert.equal(triageCall.hasApiKey, false, 'bước đánh giá cũng không được lộ khóa API');
      assert.equal(mainCall.isTriage, false);
      assert.deepEqual([flag(mainCall, '--model'), flag(mainCall, '--effort')], [model, effort]);
    } finally {
      await ctx.cleanup();
    }
  }
  delete process.env.FAKE_CLAUDE_TRIAGE;
});

test('đánh giá độ khó lỗi hoặc trả về rác: quay về Bình thường và việc vẫn chạy', async () => {
  for (const mode of ['garbage', 'crash']) {
    const ctx = await setup({}, { FAKE_CLAUDE_TRIAGE: mode });
    try {
      const { id } = await ctx.runner.submit({ title: 'Việc', prompt: 'Làm gì đó', member: 'An' });
      const task = await waitFor(() => ctx.store.getTask(id).status === 'done' && ctx.store.getTask(id), { label: `việc xong (${mode})` });
      assert.equal(task.level, 'normal');
      assert.deepEqual([task.model, task.effort], ['sonnet', 'medium']);
      assert.match(task.level_reason, /Không đánh giá được/);
    } finally {
      await ctx.cleanup();
    }
  }
  delete process.env.FAKE_CLAUDE_TRIAGE;
});

test('nâng bậc model: việc tự đánh giá hết số lượt thì nâng một bậc và làm tiếp; việc người dùng tự chọn thì không', async () => {
  const ctx = await setup({}, { FAKE_CLAUDE_TRIAGE: 'easy', FAKE_CLAUDE_SCENARIO: 'maxturns_once' });
  try {
    const { id } = await ctx.runner.submit({ title: 'Việc tưởng dễ', prompt: 'Làm gì đó', member: 'An' });
    const task = await waitFor(() => ctx.store.getTask(id).status === 'done' && ctx.store.getTask(id), { timeout: 20000, label: 'việc xong sau khi nâng bậc' });
    assert.equal(task.level, 'easy');
    assert.equal(task.escalations, 1);
    assert.deepEqual([task.model, task.effort], ['sonnet', 'medium'], 'haiku được nâng lên sonnet');
    assert.equal(task.attempts, 2);
    const flag = (call, name) => call.args[call.args.indexOf(name) + 1];
    const main = ctx.calls().filter((c) => !c.isTriage);
    assert.deepEqual(main.map((c) => flag(c, '--model')), ['haiku', 'sonnet']);
    assert.equal(main[1].resumed, true, 'làm tiếp đúng phiên cũ');
    assert.ok(Number(flag(main[1], '--max-turns')) > Number(flag(main[0], '--max-turns')), 'được thêm số lượt');
    assert.ok(ctx.store.listEvents(id).some((e) => e.kind === 'escalate' && /Nâng lên sonnet/.test(e.summary)));
  } finally {
    await ctx.cleanup();
  }

  const manual = await setup({}, { FAKE_CLAUDE_SCENARIO: 'maxturns_once' });
  try {
    const { id } = await manual.runner.submit({ ...job, level: 'easy' });
    // Không nâng bậc, nhưng hết lượt thì vẫn được hệ thống tự cho làm tiếp một lần (cùng model, cùng phiên) và xong.
    const task = await waitFor(() => ['failed', 'done'].includes(manual.store.getTask(id).status) && manual.store.getTask(id), { label: 'việc kết thúc (người dùng tự chọn nên không nâng bậc)' });
    assert.equal(task.status, 'done');
    assert.equal(task.escalations, 0);
    assert.equal(task.auto_continues, 1);
    assert.equal(task.model, 'haiku');
    const main = manual.calls().filter((c) => !c.isTriage);
    assert.equal(main.length, 2);
    assert.equal(main[1].resumed, true, 'làm tiếp đúng phiên cũ');
    assert.match(main[1].prompt, /ưu tiên HOÀN THÀNH và NỘP BÀI/);
    assert.ok(manual.store.listEvents(id).some((e) => e.kind === 'warn' && /Tự cho làm tiếp một lần/.test(e.summary)));
  } finally {
    await manual.cleanup();
  }
  delete process.env.FAKE_CLAUDE_TRIAGE;
});

test('nextTier đi haiku, sonnet, opus và dừng ở opus', () => {
  assert.equal(nextTier('haiku').model, 'sonnet');
  assert.equal(nextTier('claude-sonnet-5-5').model, 'opus');
  assert.equal(nextTier('opus'), null);
  assert.equal(nextTier('khong-biet'), null);
  assert.deepEqual(parseTriage('xin chào {"level":"HARD","reason":"cần thiết kế"} hết'), { level: 'hard', reason: 'cần thiết kế' });
  assert.equal(parseTriage('{"level":"fable"}'), null);
  assert.equal(parseTriage('không phải json'), null);
});

test('submit từ chối dữ liệu sai bằng thông báo dễ hiểu', async () => {
  const ctx = await setup();
  try {
    await assert.rejects(ctx.runner.submit({ ...job, member: 'Ma' }), (e) => e instanceof UserError && /Ma/.test(e.message));
    await assert.rejects(ctx.runner.submit({ ...job, title: '  ' }), /tiêu đề/);
    await assert.rejects(ctx.runner.submit({ ...job, prompt: '' }), /mô tả/);
  } finally {
    await ctx.cleanup();
  }
});

test('submit báo lỗi khi dự án không phải git repo', async () => {
  const ctx = await setup();
  try {
    const bare = tmpDir();
    const runner = new Runner({ cfg: { ...ctx.cfg, projectRoot: bare }, store: ctx.store, getTeams: () => loadTeams({ teamsDir: path.join(REPO, 'teams') }), getProject: () => null });
    await assert.rejects(runner.submit(job), /không phải là git repo/);
    removeDir(bare);
  } finally {
    await ctx.cleanup();
  }
});

test('commitWorktree liệt kê đúng file đã sửa, file mới, tên có dấu cách và file đổi tên', async () => {
  const root = tmpDir();
  try {
    const { project } = makeProject(root);
    fs.mkdirSync(path.join(project, 'src'));
    fs.writeFileSync(path.join(project, 'src', 'math.mjs'), 'a\n');
    fs.writeFileSync(path.join(project, 'cu.txt'), 'x\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'thêm file');

    // Dòng đầu của `git status` có khoảng trắng đầu (" M ..."): lỗi cũ làm mất ký tự đầu của đường dẫn.
    fs.writeFileSync(path.join(project, 'src', 'math.mjs'), 'b\n');
    fs.writeFileSync(path.join(project, 'file moi co dau cach.txt'), 'y\n');
    fs.mkdirSync(path.join(project, 'sub'));
    fs.writeFileSync(path.join(project, 'sub', 'a.txt'), 'z\n');
    git(project, 'mv', 'cu.txt', 'moi.txt');

    const { changedFiles, commit } = await commitWorktree({ dir: project, message: 'thử' });
    assert.deepEqual([...changedFiles].sort(), ['file moi co dau cach.txt', 'moi.txt', 'src/math.mjs', 'sub/a.txt']);
    assert.ok(commit);
    assert.deepEqual(await commitWorktree({ dir: project, message: 'trống' }), { changedFiles: [], commit: null, skipped: [] });
    assert.deepEqual(parsePorcelainZ(' M a b.txt\0?? c.txt\0R  moi\0cu\0'), ['a b.txt', 'c.txt', 'moi']);
  } finally {
    removeDir(root);
  }
});

test('safeName bỏ dấu tiếng Việt khi đặt tên nhánh', () => {
  assert.equal(safeName('Bình'), 'binh');
  assert.equal(safeName('Đặng Thị Hạnh'), 'dang-thi-hanh');
  assert.equal(safeName('  ../Ａ b!! '), 'a-b');
  assert.equal(safeName('???'), 'x');
});

test('buildClaudeArgs, buildAllowedTools và buildSystemPrompt', () => {
  const teams = loadTeams({ teamsDir: path.join(REPO, 'teams') });
  const { team, member, role } = findMember(teams, 'An');
  const project = { name: 'p', stack: ['Next.js'], folders: { backend: ['src/server'], frontend: ['src/app'] }, commands: { test: 'npm test' }, allowedCommands: ['npm test'], conventions: 'ESM' };

  const allowed = buildAllowedTools(role, project);
  assert.deepEqual(allowed.filter((t) => !t.startsWith('Bash')), ['Read', 'Grep', 'Glob', 'Edit', 'Write']);
  assert.ok(allowed.includes('Bash(npm test)') && allowed.includes('Bash(npm test *)'));
  assert.deepEqual(buildAllowedTools({ ...role, tools: ['Read'] }, project), ['Read'], 'không có Bash thì không cấp lệnh nào');
  assert.ok(!buildAllowedTools(role, null).some((t) => t.startsWith('Bash')), 'chưa có hồ sơ thì không cấp lệnh Bash');

  const args = buildClaudeArgs({ task: { session_id: 's1' }, role, project, systemFile: 'sys.md', pluginDir: 'plug', resume: true });
  assert.ok(args.includes('--plugin-dir') && args.includes('--resume'));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob,Edit,Write,Bash,Skill', 'có gói skill thì cần công cụ Skill');
  assert.match(args[args.indexOf('--allowedTools') + 1], /(^|,)Skill(,|$)/);
  const noPack = buildClaudeArgs({ task: {}, role, project, systemFile: 's', pluginDir: null, resume: false });
  assert.ok(!noPack.includes('--plugin-dir'));
  assert.equal(noPack[noPack.indexOf('--tools') + 1], 'Read,Grep,Glob,Edit,Write,Bash');
  assert.doesNotMatch(noPack[noPack.indexOf('--allowedTools') + 1], /Skill/);
  assert.ok(!noPack.includes('--add-dir'), 'không có thư mục nối thì không khai --add-dir');
  // Đích thật của thư mục nối (node_modules của dự án) phải khai --add-dir, vì Claude Code tự chặn đọc/ls ngoài thư mục làm việc.
  const withDirs = buildClaudeArgs({ task: {}, role, project, systemFile: 's', pluginDir: null, resume: false, addDirs: ['D:\\du-an\\node_modules', 'D:\\du-an\\vendor'] });
  assert.deepEqual(withDirs.filter((_, i) => withDirs[i - 1] === '--add-dir'), ['D:\\du-an\\node_modules', 'D:\\du-an\\vendor']);
  assert.equal(guardEnv({ root: 'r', allow: ['src'], mode: 'worker', links: ['node_modules'] }).COMPANY_GUARD_LINKS, '["node_modules"]');
  assert.equal(guardEnv({ root: 'r', allow: [], mode: 'worker' }).COMPANY_GUARD_LINKS, '[]');
  assert.equal(guardEnv({ root: 'r', allow: [], mode: 'worker', commands: ['npm test'] }).COMPANY_GUARD_COMMANDS, '["npm test"]');
  assert.equal(guardEnv({ root: 'r', allow: [], mode: 'worker' }).COMPANY_GUARD_COMMANDS, '[]');

  const system = buildSystemPrompt({ member, team, role, project });
  assert.doesNotMatch(system, /Quy tắc riêng của công ty cho công nghệ/, 'dự án Next.js không có ghi chú Supabase');
  assert.match(system, /Không có người trực tiếp để hỏi/);
  const supabaseSystem = buildSystemPrompt({ member, team, role, project: { ...project, stack: ['Next.js', 'Supabase'] } });
  assert.match(supabaseSystem, /Quy tắc riêng của công ty cho công nghệ[\s\S]*không đụng dự án Supabase chạy thật/);
  assert.match(supabaseSystem, /service_role/);
  assert.match(system, /An, Lập trình viên Backend của Team Backend/);
  assert.match(system, /chỉ sửa trong đây\): src\/server/);
  assert.match(system, /của frontend \(không tự ý sửa\): src\/app/);
  assert.match(system, /Không push/);
  assert.doesNotMatch(system, /Skill của bạn/, 'không có skill nạp thì không có đoạn dặn dùng skill');
  const withSkills = buildSystemPrompt({ member, team, role, project, skills: ['ponytail', 'verification-before-completion'] });
  assert.match(withSkills, /## Skill của bạn[\s\S]*- company-skills:ponytail\n- company-skills:verification-before-completion[\s\S]*công cụ Skill/);
  assert.ok(withSkills.indexOf('## Skill của bạn') < withSkills.indexOf('## Quy tắc bắt buộc'));
});

test('báo có file thay đổi mà nhánh trống: việc bị đánh lỗi no_changes, không coi là xong', async () => {
  const ctx = await setup({}, { FAKE_CLAUDE_SCENARIO: 'claim_only' });
  try {
    const { id } = await ctx.runner.submit(job);
    const task = await waitFor(() => ['done', 'failed'].includes(ctx.store.getTask(id).status) && ctx.store.getTask(id), { label: 'việc kết thúc' });
    assert.equal(task.status, 'failed');
    assert.equal(task.failure_code, 'no_changes');
    assert.match(task.error, /báo đã sửa 2 file \(hello\.txt, src\/lib\/moi\.ts\) nhưng nhánh không ghi nhận thay đổi nào/);
    assert.deepEqual(JSON.parse(task.changed_files), []);
    assert.match(task.result, /File thay đổi: hello\.txt/, 'báo cáo vẫn được giữ để xem');
    assert.ok(ctx.store.listEvents(id).some((e) => e.kind === 'error' && /nhánh không ghi nhận/.test(e.summary)));
  } finally {
    await ctx.cleanup();
  }
});

test('claimedChangedFiles đọc đúng mục "File thay đổi" của báo cáo', () => {
  assert.deepEqual(claimedChangedFiles('Đã làm: x\nFile thay đổi: hello.txt, src/lib/moi.ts và e.g. bản v1.2\nCách kiểm tra: mở src/khac.ts'), ['hello.txt', 'src/lib/moi.ts']);
  assert.deepEqual(claimedChangedFiles('## Đã làm\nx\n## File thay đổi\n- `src/app/page.tsx`\n- docs\\huong-dan.md (mới)\n## Cách kiểm tra\nchạy test/a.test.ts'), ['src/app/page.tsx', 'docs/huong-dan.md']);
  assert.deepEqual(claimedChangedFiles('2. File thay đổi: không có file nào.\n3. Cách kiểm tra: không'), []);
  assert.deepEqual(claimedChangedFiles('Đã làm: tạo hello.txt'), [], 'không có mục File thay đổi thì không đoán');
  assert.deepEqual(claimedChangedFiles(null), []);
});

test('thư mục nháp .company-tmp: tạo sẵn trong worktree, ghi gì cũng không bị commit', async () => {
  const root = tmpDir();
  try {
    const { project } = makeProject(root);
    const wt = await createWorktree({ projectRoot: project, worktreesDir: path.join(root, 'wt'), member: 'An', taskId: 1 });
    assert.equal(fs.readFileSync(path.join(wt.dir, '.company-tmp', '.gitignore'), 'utf8'), '*\n');
    fs.writeFileSync(path.join(wt.dir, '.company-tmp', 'thu.mjs'), 'console.log(1)\n');
    fs.writeFileSync(path.join(wt.dir, '.company-tmp', 'ket-qua.txt'), 'ok\n');
    fs.writeFileSync(path.join(wt.dir, 'hello.txt'), 'xin chào\n');
    const { changedFiles } = await commitWorktree({ dir: wt.dir, message: 'thử' });
    assert.deepEqual(changedFiles, ['hello.txt']);
    assert.equal(git(wt.dir, 'status', '--porcelain', '--ignored=no'), '', 'git không thấy gì trong thư mục nháp');
    assert.ok(!git(project, 'ls-tree', '-r', '--name-only', wt.branch).includes('.company-tmp'));
  } finally {
    removeDir(root);
  }
});
