import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { decideAgy, collectPaths } from '../server/agy-guard.mjs';
import { runDoctor } from '../server/doctor.mjs';
import { ensureDirs } from '../server/config.mjs';
import { openDb } from '../server/db.mjs';
import {
  AGENTS_BEGIN, AGENTS_END, agyEngine, buildAllowRules, detectAgyQuota, parseAgyLine, parseModelList, prepareAgyRun, resolveModel, stripAgentsBlock,
} from '../server/engines/agy.mjs';
import { getEngine } from '../server/engines/index.mjs';
import { loadProject } from '../server/project.mjs';
import { Runner } from '../server/runner.mjs';
import { findMember, loadTeams } from '../server/teams.mjs';
import { git, makeProject, removeDir, REPO, testConfig, tmpDir, waitFor } from './helpers.mjs';

const FAKE_AGY = path.join(REPO, 'tests', 'fixtures', 'fake-agy.mjs');

// ---- Đọc sự kiện (mẫu lấy từ lần chạy agy thật) ----

const step = (obj) => JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c1', ...obj } });

test('parseAgyLine: init trở thành system/init với mã phiên là conversation_id', () => {
  const [msg] = parseAgyLine(JSON.stringify({ event: 'init', conversation_id: 'abc', init: { cwd: '/x', tools: [] } }), {});
  assert.deepEqual(msg, { type: 'system', subtype: 'init', session_id: 'abc', model: undefined, skills: undefined });
});

test('parseAgyLine: các mảnh text_delta được ghép thành một tin nhắn khi bước kết thúc, và cộng usage', () => {
  const scratch = {};
  assert.deepEqual(parseAgyLine(step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Xin ' }), scratch), []);
  assert.deepEqual(parseAgyLine(step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'chào' }), scratch), []);
  const [msg] = parseAgyLine(step({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '\n', usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 3, cache_read_tokens: 4 } }), scratch);
  assert.deepEqual(msg, { type: 'assistant', message: { content: [{ type: 'text', text: 'Xin chào' }] } });
  assert.equal(scratch.turns, 1);
  assert.deepEqual(scratch.usage, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 });
});

test('parseAgyLine: bước chỉ có suy nghĩ (không chữ) không tính là một lượt', () => {
  const scratch = {};
  assert.deepEqual(parseAgyLine(step({ step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 5 } }), scratch), []);
  assert.equal(scratch.turns, 0);
  assert.equal(scratch.usage.input_tokens, 5);
});

test('parseAgyLine: công cụ chỉ phát tool_use một lần dù ACTIVE rồi DONE, rồi tool_result; tham số Path/CommandLine thành file_path/command', () => {
  const scratch = {};
  const active = parseAgyLine(step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: 'C:/a/b.txt' } } }), scratch);
  assert.equal(active.length, 1);
  assert.equal(active[0].message.content[0].type, 'tool_use');
  assert.equal(active[0].message.content[0].name, 'read_file');
  assert.equal(active[0].message.content[0].input.file_path, 'C:/a/b.txt');
  const done = parseAgyLine(step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: 'C:/a/b.txt' }, output: '1 lines, 12 bytes' } }), scratch);
  assert.equal(done.length, 1);
  assert.deepEqual(done[0].message.content[0], { type: 'tool_result', tool_use_id: 'step-2', is_error: false, content: '1 lines, 12 bytes' });
  assert.equal(scratch.turns, 1);

  const cmd = parseAgyLine(step({ step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'npm test' } } }), scratch);
  assert.equal(cmd[0].message.content[0].input.command, 'npm test');
});

test('parseAgyLine: bước công cụ ERROR thành tool_result lỗi mang thông điệp của agy', () => {
  const scratch = {};
  const out = parseAgyLine(step({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: 'x' }, error: { type: 'TOOL_ERROR', message: 'file does not exist' } } }), scratch);
  assert.equal(out.length, 2, 'tool_use (chưa thấy ACTIVE) và tool_result');
  assert.deepEqual(out[1].message.content[0], { type: 'tool_result', tool_use_id: 'step-2', is_error: true, content: 'file does not exist' });
});

test('parseAgyLine: result thành công đổi sang dạng Claude, usage gộp thinking vào output, chi phí 0, lượt tính theo scratch', () => {
  const scratch = { turns: 4 };
  const out = parseAgyLine(JSON.stringify({
    event: 'result',
    result: { conversation_id: 'c1', status: 'SUCCESS', response: 'Xong', duration_seconds: 2.5, num_turns: 1, usage: { input_tokens: 200, output_tokens: 20, thinking_tokens: 10, cache_read_tokens: 30 } },
  }), scratch);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    type: 'result', subtype: 'success', is_error: false, result: 'Xong', num_turns: 4, duration_ms: 2500,
    usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 30, cache_creation_input_tokens: 0 },
    total_cost_usd: 0, terminal_reason: undefined,
  });
});

test('parseAgyLine: result ERROR (ví dụ model sai) thành kết quả lỗi mang chữ lỗi', () => {
  const [res] = parseAgyLine(JSON.stringify({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'invalid model selection', finished_reason: 'error', usage: {} } }), {});
  assert.equal(res.type, 'result');
  assert.equal(res.is_error, true);
  assert.equal(res.subtype, 'error_during_execution');
  assert.equal(res.result, 'invalid model selection');
});

test('parseAgyLine: lệnh bị từ chối ghi cảnh báo, và kết quả trống có ghi chú để báo cáo không trống rỗng', () => {
  const out = parseAgyLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '', usage: {}, denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } }), {});
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'system');
  assert.match(out[0].message, /từ chối RunCommand/);
  assert.match(out[1].result, /bị từ chối/);
  assert.equal(out[1].subtype, 'success');
});

test('parseAgyLine: dòng không phải JSON hoặc không phải object trả null; sự kiện lạ bị bỏ qua (mảng rỗng)', () => {
  for (const line of ['jetski: no output produced', '{hỏng', 'null', '42']) assert.equal(parseAgyLine(line, {}), null, line);
  assert.deepEqual(parseAgyLine('{"event":"nhac_nho"}', {}), []);
  assert.deepEqual(parseAgyLine(step({ step_index: 0, state: 'DONE', step_type: 'user_input' }), {}), []);
});

// ---- Model, tham số, luật lệnh ----

test('resolveModel: bậc công ty thành model agy theo danh sách đang có; id cụ thể giữ nguyên; không có thì để agy tự chọn', () => {
  assert.equal(resolveModel('haiku', null), 'gemini-3.8-flash-low');
  assert.equal(resolveModel('sonnet', null), 'gemini-3.8-flash-high');
  assert.equal(resolveModel('opus', null), 'claude-opus-4-6-thinking');
  assert.equal(resolveModel('opus', ['gemini-3.8-flash-high', 'claude-sonnet-4-6']), 'claude-sonnet-4-6', 'opus không có thì lùi xuống phương án kế');
  assert.equal(resolveModel('sonnet', ['gpt-oss-120b-medium']), undefined, 'không model nào hợp thì không ép --model');
  assert.equal(resolveModel('gemini-3.8-flash-medium', ['x']), 'gemini-3.8-flash-medium');
  assert.equal(resolveModel('', null), undefined);
});

test('parseModelList đọc đầu ra `agy models` và bỏ dòng "Fetching..."', () => {
  const text = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n\n';
  assert.deepEqual(parseModelList(text), [
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  ]);
  assert.deepEqual(parseModelList(''), []);
});

test('taskArgs agy: model, effort (chỉ khi model không có mức trong tên), luật lệnh, --conversation khi làm tiếp, không -p và không cờ của Claude', () => {
  const role = { model: 'opus', effort: 'high', tools: ['Read', 'Bash'], max_turns: 30 };
  const project = { allowedCommands: ['npm test', 'git status'] };
  const args = agyEngine.taskArgs({ task: { session_id: 'conv-9' }, role, project, resume: true });
  const flag = (n) => args[args.indexOf(n) + 1];
  assert.equal(flag('--output-format'), 'stream-json');
  assert.equal(flag('--model'), 'claude-opus-4-6-thinking');
  assert.equal(flag('--effort'), 'high');
  assert.equal(flag('--conversation'), 'conv-9');
  assert.deepEqual(JSON.parse(flag('--settings')), { permissions: { allow: ['command(npm test)', 'command(git status)'] } });
  for (const bad of ['-p', '--max-turns', '--tools', '--setting-sources', '--append-system-prompt-file', '--plugin-dir', '--mcp-config']) assert.ok(!args.includes(bad), bad);

  const flash = agyEngine.taskArgs({ task: {}, role: { ...role, model: 'haiku' }, project, resume: false });
  assert.equal(flash[flash.indexOf('--model') + 1], 'gemini-3.8-flash-low');
  assert.ok(!flash.includes('--effort'), 'agy từ chối --effort đi cùng model đã có mức trong tên');
  assert.ok(!flash.includes('--conversation'));
});

test('buildAllowRules: chỉ khi vai trò có Bash, chỉ đúng các lệnh đã khai (khớp nguyên văn, không có "*")', () => {
  assert.deepEqual(buildAllowRules({ tools: ['Read', 'Bash'] }, { allowedCommands: ['npm test', 'npm test'] }), ['command(npm test)']);
  assert.deepEqual(buildAllowRules({ tools: ['Read'] }, { allowedCommands: ['npm test'] }), []);
  assert.deepEqual(buildAllowRules({ tools: ['Bash'] }, null), []);
});

test('answerArgs agy: không luật lệnh nào; leadArgs từ chối rõ ràng', () => {
  const args = agyEngine.answerArgs({ model: 'sonnet', effort: 'medium', session: 'conv-1' });
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { permissions: { allow: [] } });
  assert.equal(args[args.indexOf('--conversation') + 1], 'conv-1');
  assert.throws(() => agyEngine.leadArgs(), /chưa chạy được lượt của Trưởng nhóm/);
});

test('agy.env gỡ khóa API của Google và của Claude khỏi môi trường con', () => {
  const env = agyEngine.env({ PATH: 'p', GEMINI_API_KEY: 'k', google_api_key: 'k', ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1', KEEP: 'ok' });
  assert.deepEqual(env, { PATH: 'p', KEEP: 'ok' });
});

// ---- Nhận ra hết hạn mức ----

test('detectAgyQuota: nhận ra chữ hết hạn mức trong lỗi hoặc stderr, đọc giờ hồi ISO; không nhầm lỗi khác', () => {
  const byResult = detectAgyQuota({ res: { is_error: true, result: 'RESOURCE_EXHAUSTED: Quota exceeded. Your quota will reset at 2099-01-01T00:00:00Z' } });
  assert.equal(byResult.blocked, true);
  assert.equal(byResult.resetsAt, Date.parse('2099-01-01T00:00:00Z'));
  const byStderr = detectAgyQuota({ res: null, stderrTail: 'AGY_ERROR: {"code":429,"message":"Too many requests"}' });
  assert.equal(byStderr.blocked, true);
  assert.equal(byStderr.resetsAt, null);
  assert.equal(detectAgyQuota({ res: { is_error: true, result: 'invalid model selection' }, stderrTail: 'error: invalid model' }), null);
  assert.equal(detectAgyQuota({ res: { is_error: true, result: 'Model unavailable (attempt 2/10), retrying' } }), null);
  assert.equal(detectAgyQuota({ res: { is_error: false, result: 'Tôi đã giải thích về quota cho bạn' } }), null, 'kết quả thành công không bao giờ bị coi là hết hạn mức');
  assert.equal(detectAgyQuota({}), null);
});

// ---- Chuẩn bị thư mục làm việc ----

function skillPack(root) {
  const dir = path.join(root, 'pack');
  fs.mkdirSync(path.join(dir, 'skills', 'ponytail', 'refs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'ponytail', 'SKILL.md'), '---\nname: ponytail\ndescription: d\n---\nNội dung\n');
  fs.writeFileSync(path.join(dir, 'skills', 'ponytail', 'refs', 'a.md'), 'phụ\n');
  return dir;
}

test('prepareAgyRun (worker): đặt hook, guard + config, skill và AGENTS.md vào worktree; -p là tham số cuối', () => {
  const root = tmpDir();
  try {
    const wt = path.join(root, 'wt');
    fs.mkdirSync(wt);
    const run = prepareAgyRun({ cwd: wt, runDir: path.join(root, 'run'), readonly: false, root: wt, allow: ['src'], commands: ['npm test', 'git status'], systemText: 'Bạn là An.', skillsDir: skillPack(root), prompt: 'Làm việc X' });
    assert.equal(run.cwd, wt);
    assert.deepEqual(run.args, ['-p', 'Làm việc X']);

    const hooks = JSON.parse(fs.readFileSync(path.join(wt, '.agents', 'hooks.json'), 'utf8'));
    assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, 'node company-guard/agy-guard.mjs', 'không dấu ngoặc kép (agy làm hỏng chúng trên Windows)');
    const config = JSON.parse(fs.readFileSync(path.join(wt, '.agents', 'company-guard', 'config.json'), 'utf8'));
    assert.deepEqual(config, { root: wt, allow: ['src'], mode: 'worker' });
    assert.ok(fs.existsSync(path.join(wt, '.agents', 'company-guard', 'agy-guard.mjs')));
    assert.ok(fs.existsSync(path.join(wt, '.agents', 'company-guard', 'path-guard.mjs')));
    assert.ok(fs.existsSync(path.join(wt, '.agents', 'skills', 'ponytail', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(wt, '.agents', 'skills', 'ponytail', 'refs', 'a.md')));
    const agents = fs.readFileSync(path.join(wt, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Bạn là An\./);
    assert.match(agents, /đúng nguyên văn một trong các lệnh sau: `npm test`, `git status`/);
    assert.match(agents, /làm phiên dừng ngay/);
    for (const file of ['hooks.json', 'company-guard/config.json']) {
      const bytes = fs.readFileSync(path.join(wt, '.agents', file));
      assert.notEqual(bytes[0], 0xef, `${file} không được có BOM (agy từ chối file JSON có BOM)`);
    }
  } finally {
    removeDir(root);
  }
});

test('prepareAgyRun: AGENTS.md có sẵn của dự án được giữ, làm lại không chồng khối công ty, hooks.json có sẵn được gộp', () => {
  const root = tmpDir();
  try {
    const wt = path.join(root, 'wt');
    fs.mkdirSync(path.join(wt, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'AGENTS.md'), '# Quy ước của dự án\nDùng tab.\n');
    const own = { matcher: 'run_command', hooks: [{ type: 'command', command: 'node mine.mjs' }] };
    fs.writeFileSync(path.join(wt, '.agents', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [own] }, extra: 1 }));
    const params = { cwd: wt, runDir: path.join(root, 'run'), readonly: false, root: wt, systemText: 'Lần một', prompt: 'p' };
    prepareAgyRun(params);
    prepareAgyRun({ ...params, systemText: 'Lần hai' });
    const agents = fs.readFileSync(path.join(wt, 'AGENTS.md'), 'utf8');
    assert.equal(agents.split(AGENTS_BEGIN).length - 1, 1, 'chỉ một khối công ty');
    assert.match(agents, /Lần hai/);
    assert.doesNotMatch(agents, /Lần một/);
    assert.match(agents, /# Quy ước của dự án\nDùng tab\./);
    const hooks = JSON.parse(fs.readFileSync(path.join(wt, '.agents', 'hooks.json'), 'utf8'));
    assert.equal(hooks.extra, 1);
    assert.equal(hooks.hooks.PreToolUse.length, 2, 'hook của dự án + một hook của công ty (không nhân đôi)');
    assert.deepEqual(hooks.hooks.PreToolUse[0], own);
    assert.equal(stripAgentsBlock(agents).trim(), '# Quy ước của dự án\nDùng tab.');
    assert.ok(agents.includes(AGENTS_END));
  } finally {
    removeDir(root);
  }
});

test('prepareAgyRun (chỉ đọc): chạy từ thư mục riêng của lượt với --add-dir, không ghi gì vào thư mục dự án thật', () => {
  const root = tmpDir();
  try {
    const real = path.join(root, 'real');
    const runDir = path.join(root, 'run');
    fs.mkdirSync(real);
    fs.mkdirSync(runDir);
    const run = prepareAgyRun({ cwd: real, runDir, readonly: true, root: real, systemText: 'Trả lời ngắn.', prompt: 'Câu hỏi?' });
    assert.equal(run.cwd, runDir);
    assert.deepEqual(run.args, ['--add-dir', real, '-p', 'Câu hỏi?']);
    assert.deepEqual(fs.readdirSync(real), [], 'thư mục dự án thật không bị đụng');
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, '.agents', 'company-guard', 'config.json'), 'utf8')).mode, 'readonly');
    assert.match(fs.readFileSync(path.join(runDir, 'AGENTS.md'), 'utf8'), /không được chạy lệnh shell nào/);
    assert.match(fs.readFileSync(path.join(runDir, 'AGENTS.md'), 'utf8'), new RegExp(real.replace(/[\\]/g, '\\\\').replace(/[.*+?^${}()|[\]]/g, '\\$&')));
  } finally {
    removeDir(root);
  }
});

test('prepareAgyRun: lời nhắc quá dài được đưa vào file để không vượt giới hạn dòng lệnh', () => {
  const root = tmpDir();
  try {
    const wt = path.join(root, 'wt');
    fs.mkdirSync(wt);
    const long = 'x'.repeat(13_000);
    const run = prepareAgyRun({ cwd: wt, runDir: root, readonly: false, root: wt, systemText: 's', prompt: long });
    assert.equal(fs.readFileSync(path.join(wt, '.agents', 'task-prompt.md'), 'utf8'), long);
    assert.ok(run.args.at(-1).length < 400);
    assert.match(run.args.at(-1), /task-prompt\.md/);
  } finally {
    removeDir(root);
  }
});

// ---- Hook chặn file ----

const WT = path.resolve('/tmp/agy-guard-root');
const cfg = (over = {}) => ({ root: WT, allow: [], mode: 'worker', ...over });

test('decideAgy: đọc/ghi trong thư mục làm việc được; ra ngoài thì bị chặn, kể cả đường dẫn tương đối và file://', () => {
  const ok = (name, args, c) => assert.equal(decideAgy({ toolName: name, args, config: c ?? cfg() }).allowed, true, `${name} ${JSON.stringify(args)}`);
  const no = (name, args, c) => assert.equal(decideAgy({ toolName: name, args, config: c ?? cfg() }).allowed, false, `${name} ${JSON.stringify(args)}`);
  ok('read_file', { Path: path.join(WT, 'a.txt') });
  ok('write_to_file', { TargetFile: path.join(WT, 'src', 'a.ts'), CodeContent: 'x' });
  ok('run_command', { CommandLine: 'npm test', Cwd: WT });
  no('read_file', { Path: path.join(WT, '..', 'x.txt') });
  no('write_to_file', { TargetFile: path.resolve(WT, '..', 'x.txt') });
  no('list_dir', { DirectoryPath: path.resolve(WT, '..') });
  no('grep_search', { SearchPath: path.resolve(WT, '..'), Query: 'a' });
  no('run_command', { CommandLine: 'npm test', Cwd: path.resolve(WT, '..') });
  no('read_file', { Path: `file:///${path.resolve(WT, '..', 'x.txt').replace(/\\/g, '/')}` });
  no('read_file', { Path: path.join(WT, '.env') });
  no('write_to_file', { TargetFile: path.join(WT, '.git', 'config') });
  // Công cụ lạ nhưng có tham số đường dẫn ra ngoài vẫn bị chặn (không tin vào danh sách cố định).
  no('tool_chua_biet', { AnyPath: path.resolve(WT, '..', 'x') });
  ok('tool_chua_biet', { Path: path.join(WT, 'x') });
  ok('multi_replace_file_content', { TargetFile: path.join(WT, 'a.ts'), TargetContent: '../../etc/passwd', ReplacementContent: 'C:\\Windows\\x' }, cfg());
  ok('finish', {});
});

test('decideAgy: ghi ngoài thư mục được phép của team bị chặn nhưng đọc thì được; chế độ chỉ đọc chặn mọi ghi và run_command', () => {
  const c = cfg({ allow: ['src'] });
  assert.equal(decideAgy({ toolName: 'write_to_file', args: { TargetFile: path.join(WT, 'src', 'a.ts') }, config: c }).allowed, true);
  assert.equal(decideAgy({ toolName: 'write_to_file', args: { TargetFile: path.join(WT, 'docs', 'a.md') }, config: c }).allowed, false);
  assert.equal(decideAgy({ toolName: 'read_file', args: { Path: path.join(WT, 'docs', 'a.md') }, config: c }).allowed, true);
  const ro = cfg({ mode: 'readonly' });
  assert.equal(decideAgy({ toolName: 'read_file', args: { Path: path.join(WT, 'a') }, config: ro }).allowed, true);
  assert.equal(decideAgy({ toolName: 'replace_file_content', args: { TargetFile: path.join(WT, 'a') }, config: ro }).allowed, false);
  assert.equal(decideAgy({ toolName: 'run_command', args: { CommandLine: 'git status' }, config: ro }).allowed, false);
});

test('decideAgy: không cho sửa .agents hay AGENTS.md; trình duyệt, subagent, MCP, tìm web bị chặn hẳn', () => {
  for (const file of ['.agents/hooks.json', '.agents/company-guard/config.json', 'AGENTS.md']) {
    const verdict = decideAgy({ toolName: 'write_to_file', args: { TargetFile: path.join(WT, file) }, config: cfg() });
    assert.equal(verdict.allowed, false, file);
    assert.match(verdict.reason, /\.agents|AGENTS/);
  }
  assert.equal(decideAgy({ toolName: 'read_file', args: { Path: path.join(WT, 'AGENTS.md') }, config: cfg() }).allowed, true, 'đọc thì được');
  for (const name of ['browser_subagent', 'open_browser_url', 'invoke_subagent', 'call_mcp_tool', 'search_web', 'read_url_content', 'manage_task', 'schedule', 'generate_image']) {
    assert.equal(decideAgy({ toolName: name, args: {}, config: cfg() }).allowed, false, name);
  }
  assert.equal(decideAgy({ toolName: '', args: {}, config: cfg() }).allowed, false);
});

test('collectPaths: lấy tham số kiểu đường dẫn (cả mảng), bỏ tham số nội dung', () => {
  assert.deepEqual(collectPaths({ TargetFile: 'a', CodeContent: 'b', TargetContent: 'c', Query: 'd', Cwd: 'e', Files: ['f', 'g'], IsFile: true }).sort(), ['a', 'e', 'f', 'g']);
  assert.deepEqual(collectPaths(undefined), []);
});

// ---- Chạy thật qua Runner với fake-agy ----

async function setup(overrides = {}, env = {}) {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg2 = testConfig(root, project, local, { engine: 'agy', agyBin: process.execPath, agyArgsPrefix: [FAKE_AGY], ...overrides });
  ensureDirs(cfg2);
  const logFile = path.join(root, 'fake-agy.log');
  Object.assign(process.env, { FAKE_AGY_LOG: logFile, ...env });
  const store = openDb(path.join(cfg2.dataDir, 'company.db'));
  const teams = loadTeams({ teamsDir: path.join(REPO, 'teams') });
  const runner = new Runner({ cfg: cfg2, store, getTeams: () => teams, getProject: () => loadProject(local) });
  runner.start();
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const cleanup = async () => {
    await runner.shutdown();
    store.close();
    for (const key of ['FAKE_AGY_LOG', 'FAKE_AGY_SCENARIO', 'FAKE_AGY_FILE', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY']) delete process.env[key];
    removeDir(root);
  };
  return { root, project, cfg: cfg2, store, runner, teams, calls, cleanup };
}

const job = { title: 'Tạo hello', prompt: 'Tạo file hello.txt', member: 'An', level: 'normal' };

test('Runner + agy: việc thành công có nhánh, commit CHỈ file của nhân viên (không .agents, AGENTS.md), usage, mã phiên, và gỡ khóa API', async () => {
  const ctx = await setup({}, { GEMINI_API_KEY: 'AIza-secret-key-zzzzzz', ANTHROPIC_API_KEY: 'sk-ant-zzzzzzzzzzzz' });
  try {
    const { id } = await ctx.runner.submit(job);
    const task = await waitFor(() => ctx.store.getTask(id).status === 'done' && ctx.store.getTask(id), { label: 'việc xong' });
    assert.deepEqual(JSON.parse(task.changed_files), ['src/hello.txt'], 'file công ty đặt vào worktree không được lọt vào commit');
    assert.equal(git(ctx.project, 'show', `${task.branch}:src/hello.txt`), 'xin chào');
    const tracked = git(ctx.project, 'ls-tree', '-r', '--name-only', task.branch).split('\n');
    assert.ok(!tracked.some((f) => f.startsWith('.agents') || f === 'AGENTS.md'), tracked.join(','));
    assert.equal(task.session_id, 'fake-agy-conversation-1');
    assert.equal(task.input_tokens, 200);
    assert.equal(task.output_tokens, 30);
    assert.equal(task.cache_read_tokens, 30);
    assert.equal(task.est_cost_usd, 0, 'trả bằng gói đăng ký, không có chi phí API');
    assert.ok(task.turns >= 3, `lượt đếm theo bước thật, không phải num_turns=1 của agy (được ${task.turns})`);
    assert.match(task.result, /hello\.txt/);

    const [call] = ctx.calls();
    assert.equal(call.cwd, fs.realpathSync(task.worktree));
    assert.equal(call.args.at(-2), '-p');
    assert.match(call.prompt, /Tạo file hello\.txt/);
    assert.equal(call.hasGeminiKey, false);
    assert.equal(call.hasApiKey, false);
    const flag = (n) => call.args[call.args.indexOf(n) + 1];
    assert.equal(flag('--model'), 'gemini-3.8-flash-high', 'bậc sonnet của vai trò thành model Gemini');
    assert.ok(!call.args.includes('--effort'), 'model Gemini đã có mức trong tên nên không truyền --effort');
    assert.ok(call.hooks.includes('company-guard/agy-guard.mjs'));
    assert.deepEqual(JSON.parse(call.guardConfig), { root: task.worktree, allow: ['src'], mode: 'worker' });
    assert.ok(call.skills.includes('ponytail'), `skill đã duyệt phải được chép vào .agents/skills (được ${call.skills})`);
    assert.match(call.agentsMd, /Bạn là An/);
    assert.match(call.agentsMd, /## Skill của bạn/);
    assert.doesNotMatch(call.agentsMd, /company-skills:/, 'agy không có công cụ Skill để gọi theo tên');
    assert.doesNotMatch(call.agentsMd, /ask_lead/, 'agy chưa có công cụ hỏi của công ty nên không được dặn dùng');
    assert.deepEqual(JSON.parse(flag('--settings')), { permissions: { allow: ['command(npm test)', 'command(git status)'] } });

    const events = ctx.store.listEvents(task.id);
    assert.ok(events.some((e) => e.kind === 'tool' && /write_to_file: .*hello\.txt/.test(e.summary)));
    const said = events.filter((e) => e.kind === 'say').map((e) => e.summary).join('\n');
    assert.doesNotMatch(said, /sk-ant-abcdefghijklmnop/, 'secret trong lời nói của agent phải được che');
  } finally {
    await ctx.cleanup();
  }
});

test('Runner + agy: hook chặn ghi ra ngoài worktree, chặn sửa AGENTS.md, chặn đọc ngoài; việc vẫn tiếp tục làm phần đúng', async () => {
  const ctx = await setup({}, { FAKE_AGY_SCENARIO: 'escape' });
  try {
    const { id } = await ctx.runner.submit(job);
    const task = await waitFor(() => ctx.store.getTask(id).status === 'done' && ctx.store.getTask(id), { label: 'việc xong' });
    assert.ok(!fs.existsSync(path.join(path.dirname(task.worktree), 'escaped.txt')), 'file ngoài worktree không được tạo');
    assert.deepEqual(JSON.parse(task.changed_files), ['src/hello.txt'], 'AGENTS.md bị chặn sửa nên cũng không có trong commit');
    const errors = ctx.store.listEvents(id).filter((e) => e.kind === 'tool_error').map((e) => e.summary);
    assert.equal(errors.length, 3, errors.join(' | '));
    assert.match(errors[0], /ngoài thư mục làm việc/);
    assert.match(errors[1], /\.agents hay AGENTS\.md/);
    assert.match(errors[2], /ngoài thư mục làm việc/);
  } finally {
    await ctx.cleanup();
  }
});

test('Runner + agy: lệnh bị agy từ chối làm lượt dừng sớm nhưng không coi là lỗi; có cảnh báo và báo cáo không trống', async () => {
  const ctx = await setup({}, { FAKE_AGY_SCENARIO: 'denied' });
  try {
    const { id } = await ctx.runner.submit(job);
    const task = await waitFor(() => ctx.store.getTask(id).status === 'done' && ctx.store.getTask(id), { label: 'việc xong' });
    assert.match(task.result, /bị từ chối/);
    assert.ok(ctx.store.listEvents(id).some((e) => e.kind === 'warn' && /từ chối RunCommand/.test(e.summary)));
  } finally {
    await ctx.cleanup();
  }
});

test('Runner + agy: hết hạn mức (lỗi RESOURCE_EXHAUSTED, mã thoát 3) tạm dừng cả công ty và giữ mã phiên để làm tiếp', async () => {
  const ctx = await setup({}, { FAKE_AGY_SCENARIO: 'quota_once' });
  try {
    const { id } = await ctx.runner.submit(job);
    const paused = await waitFor(() => ctx.store.getTask(id).status === 'paused_quota' && ctx.store.getTask(id), { label: 'tạm dừng vì hạn mức' });
    assert.equal(paused.session_id, 'fake-agy-conversation-1');
    assert.equal(ctx.runner.snapshot().pauseReason, 'quota');
    assert.ok(ctx.store.listEvents(id).some((e) => e.kind === 'quota' && /Hết hạn mức/.test(e.summary)));
  } finally {
    await ctx.cleanup();
  }
});

test('Runner + agy: giờ hồi trong lỗi (2099) được dùng làm giờ làm tiếp', async () => {
  const ctx = await setup({}, { FAKE_AGY_SCENARIO: 'quota' });
  try {
    const { id } = await ctx.runner.submit(job);
    const paused = await waitFor(() => ctx.store.getTask(id).status === 'paused_quota' && ctx.store.getTask(id), { label: 'tạm dừng vì hạn mức' });
    assert.equal(paused.resume_at, Date.parse('2099-01-01T00:00:00Z'));
  } finally {
    await ctx.cleanup();
  }
});

test('Runner + agy: model sai là lỗi thường (không phải hết hạn mức), việc thất bại có mã error_result và chữ lỗi của agy', async () => {
  const ctx = await setup({}, { FAKE_AGY_SCENARIO: 'bad_model' });
  try {
    const { id } = await ctx.runner.submit(job);
    const task = await waitFor(() => ctx.store.getTask(id).status === 'failed' && ctx.store.getTask(id), { label: 'việc lỗi' });
    assert.equal(task.failure_code, 'error_result');
    assert.match(task.error, /invalid model selection/);
    assert.notEqual(ctx.runner.snapshot().pauseReason, 'quota');
  } finally {
    await ctx.cleanup();
  }
});

test('Runner + agy: không có --max-turns nên runner tự đếm lượt và dừng khi vượt, coi như hết số lượt (đúng luồng nâng bậc/hết lượt của Claude)', async () => {
  const ctx = await setup({}, { FAKE_AGY_SCENARIO: 'many_steps' });
  try {
    const { id } = await ctx.runner.submit({ ...job, level: 'hard' }); // người dùng chọn mức: không tự nâng bậc, thất bại thẳng để dễ kiểm
    const role = findMember(ctx.teams, 'An').role;
    const task = await waitFor(() => ctx.store.getTask(id).status === 'failed' && ctx.store.getTask(id), { timeout: 20000, label: 'thất bại vì hết lượt' });
    assert.equal(task.failure_code, 'max_turns');
    assert.match(task.error, /error_max_turns/);
    const tools = ctx.store.listEvents(id).filter((e) => e.kind === 'tool').length;
    assert.ok(tools > role.max_turns && tools < 45, `dừng ngay sau khi vượt ${role.max_turns} lượt, không để chạy hết 45 bước (được ${tools})`);
  } finally {
    await ctx.cleanup();
  }
});

test('Runner + agy: lượt Trưởng nhóm cần MCP nên thất bại rõ ràng với mã engine_unsupported, không chạy agy', async () => {
  const ctx = await setup();
  try {
    const created = await ctx.runner.jobs.create({ team: 'backend', title: 'Làm tính năng X', prompt: 'Chia việc giúp tôi' });
    const plan = await waitFor(() => ctx.store.jobTasks(created.id).find((t) => t.kind === 'plan' && t.status === 'failed'), { label: 'lượt lập kế hoạch lỗi' });
    assert.equal(plan.failure_code, 'engine_unsupported');
    assert.match(plan.error, /Engine agy chưa chạy được lượt của Trưởng nhóm/);
    assert.equal(ctx.calls().length, 0, 'không gọi agy');
  } finally {
    await ctx.cleanup();
  }
});

test('Runner + agy: tự đánh giá độ khó bị bỏ qua (tiết kiệm hạn mức), việc vẫn chạy với mức Bình thường', async () => {
  const ctx = await setup();
  try {
    const { id } = await ctx.runner.submit({ title: 'Tạo hello', prompt: 'Tạo file hello.txt', member: 'An' });
    const task = await waitFor(() => ctx.store.getTask(id).status === 'done' && ctx.store.getTask(id), { label: 'việc xong' });
    assert.equal(task.level, 'normal');
    assert.match(task.level_reason, /không tự đánh giá độ khó/);
    assert.equal(ctx.calls().length, 1, 'chỉ một lần gọi agy (không tốn lần nào cho đánh giá)');
  } finally {
    await ctx.cleanup();
  }
});

// ---- doctor / engine ----

test('getEngine("agy") và doctor: đọc phiên bản và danh sách model thật từ `agy models`', async () => {
  const root = tmpDir();
  try {
    const { project, local } = makeProject(root);
    const c = testConfig(root, project, local, { engine: 'agy', agyBin: process.execPath, agyArgsPrefix: [FAKE_AGY] });
    assert.equal(getEngine(c), agyEngine);
    const checks = await runDoctor(c);
    assert.equal(checks.find((x) => x.id === 'agy')?.level, 'ok');
    const models = checks.find((x) => x.id === 'agy-models');
    assert.equal(models?.level, 'ok');
    assert.match(models.title, /3 model: gemini-3\.8-flash-high, gemini-3\.8-flash-low, claude-opus-4-6-thinking/);
    assert.deepEqual(agyEngine.models.map((m) => m.id), ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'claude-opus-4-6-thinking']);
    // Sau khi biết danh sách thật, bậc model được chọn từ danh sách đó.
    assert.equal(resolveModel('opus', agyEngine.models.map((m) => m.id)), 'claude-opus-4-6-thinking');
    assert.ok(!checks.some((x) => x.id === 'claude'), 'không kiểm tra Claude khi engine là agy');
  } finally {
    agyEngine.models = null;
    removeDir(root);
  }
});

test('doctor với agy chưa cài: báo lỗi hướng dẫn, không ném lỗi', async () => {
  const root = tmpDir();
  try {
    const { project, local } = makeProject(root);
    const checks = await runDoctor(testConfig(root, project, local, { engine: 'agy', agyBin: 'khong-co-lenh-agy-nay', agyArgsPrefix: [] }));
    const agy = checks.find((x) => x.id === 'agy');
    assert.equal(agy.level, 'fail');
    assert.match(agy.detail, /Antigravity/);
  } finally {
    removeDir(root);
  }
});
