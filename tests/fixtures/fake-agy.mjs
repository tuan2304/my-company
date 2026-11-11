// Giả lập `agy -p ... --output-format stream-json` (Antigravity) để kiểm thử mà không tốn hạn mức.
// Hình dạng sự kiện lấy từ lần chạy thật (agy 1.5.3): init / step_update / result, lỗi mô hình, lỗi công cụ, lệnh bị từ chối.
// Kịch bản chọn bằng FAKE_AGY_SCENARIO; mỗi lần chạy ghi tham số, thư mục, môi trường và các file công ty đã đặt vào FAKE_AGY_LOG.
// Khi "gọi công cụ", fake chạy đúng lệnh hook trong .agents/hooks.json như agy thật (thư mục hiện tại của hook là .agents,
// JSON qua stdin, mã thoát 2 = chặn), nên kiểm thử phủ cả đường nối hook thật.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.0.0-fake-agy');
  process.exit(0);
}
if (args[0] === 'models') {
  console.log('Fetching available models...');
  console.log('gemini-3.8-flash-high\tGemini 3.8 Flash (High)');
  console.log('gemini-3.8-flash-low\tGemini 3.8 Flash (Low)');
  console.log('claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)');
  process.exit(0);
}

const scenario = process.env.FAKE_AGY_SCENARIO ?? 'success';
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const prompt = flag('-p') ?? '';
const conversation = flag('--conversation');
const sessionId = conversation ?? 'fake-agy-conversation-1';
const cwd = process.cwd();

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
if (process.env.FAKE_AGY_LOG) {
  fs.appendFileSync(
    process.env.FAKE_AGY_LOG,
    `${JSON.stringify({
      args, prompt, cwd, conversation,
      hooks: read(path.join(cwd, '.agents', 'hooks.json')),
      guardConfig: read(path.join(cwd, '.agents', 'company-guard', 'config.json')),
      agentsMd: read(path.join(cwd, 'AGENTS.md')),
      skills: fs.existsSync(path.join(cwd, '.agents', 'skills')) ? fs.readdirSync(path.join(cwd, '.agents', 'skills')).sort() : [],
      hasGeminiKey: Object.keys(process.env).some((k) => /^(GEMINI_API_KEY|GOOGLE_API_KEY)$/i.test(k)),
      hasApiKey: Object.keys(process.env).some((k) => k.toUpperCase() === 'ANTHROPIC_API_KEY'),
    })}\n`,
  );
}

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const step = (obj) => out({ event: 'step_update', step_update: { conversation_id: sessionId, ...obj } });
let index = 0;

out({ event: 'init', conversation_id: sessionId, init: { cwd, tools: ['read_file', 'write_to_file', 'run_command'], permission_mode: 'request-review' } });
step({ step_index: index++, state: 'DONE', step_type: 'user_input' });

const usage = (i, o) => ({ input_tokens: i, output_tokens: o, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: i + o + 5 });

/** Một câu trả lời của AI, chia thành nhiều mảnh chữ như agy thật. */
const say = (text) => {
  const i = index++;
  for (let p = 0; p < text.length; p += 7) step({ step_index: i, state: 'ACTIVE', step_type: 'agent_response', text_delta: text.slice(p, p + 7) });
  step({ step_index: i, state: 'DONE', step_type: 'agent_response', text_delta: '\n', duration_seconds: 1, usage: usage(100, 10) });
};

/** Gọi công cụ: chạy hook như agy thật; hook chặn (mã 2) thì bước công cụ báo lỗi. Trả về true nếu được chạy. */
const tool = (name, params, execute) => {
  const i = index++;
  step({ step_index: i, state: 'ACTIVE', step_type: 'tool', tool_name: name, tool_info: { name, parameters: params } });
  const hooksFile = path.join(cwd, '.agents', 'hooks.json');
  if (fs.existsSync(hooksFile)) {
    const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks?.PreToolUse ?? [];
    for (const entry of hooks) {
      for (const hook of entry.hooks ?? []) {
        const run = spawnSync(hook.command, {
          shell: true, cwd: path.join(cwd, '.agents'), encoding: 'utf8',
          input: JSON.stringify({ toolCall: { name, args: params }, workspacePaths: [cwd], cwd, stepIdx: i }),
        });
        if (run.status === 2) {
          step({ step_index: i, state: 'ERROR', step_type: 'tool', tool_name: name, tool_info: { name, parameters: params, error: { type: 'TOOL_ERROR', message: `hook từ chối: ${run.stderr.trim()}` } } });
          return false;
        }
      }
    }
  }
  const output = execute?.() ?? 'ok';
  step({ step_index: i, state: 'DONE', step_type: 'tool', tool_name: name, tool_info: { name, parameters: params, output } });
  return true;
};

const finish = (response, extra = {}) => out({
  event: 'result',
  result: {
    conversation_id: sessionId, status: 'SUCCESS', response, duration_seconds: 1.5, num_turns: 1,
    usage: { input_tokens: 200, output_tokens: 20, thinking_tokens: 10, cache_read_tokens: 30, total_tokens: 260 },
    ...extra,
  },
});

// Mặc định ghi vào src/ vì hồ sơ dự án của kiểm thử chỉ cho team backend sửa trong src (hook phải cho qua).
const doWork = () => {
  const file = process.env.FAKE_AGY_FILE ?? 'src/hello.txt';
  say('Mình bắt đầu làm, token=sk-ant-abcdefghijklmnop.');
  tool('write_to_file', { TargetFile: path.join(cwd, file), CodeContent: 'xin chào\n' }, () => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), 'xin chào\n');
    return '1 lines';
  });
};

switch (scenario) {
  case 'quota':
    // Lỗi hết hạn mức: kết quả ERROR + AGY_ERROR trên stderr + mã thoát 3 (theo changelog của agy).
    process.stderr.write('AGY_ERROR: {"code":"RESOURCE_EXHAUSTED","message":"Quota exceeded. Your quota will reset at 2099-01-01T00:00:00Z"}\n');
    out({ event: 'result', result: { conversation_id: sessionId, status: 'ERROR', response: '', error: 'RESOURCE_EXHAUSTED: Quota exceeded. Your quota will reset at 2099-01-01T00:00:00Z', duration_seconds: 1, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }, finished_reason: 'error' } });
    process.exitCode = 3;
    break;
  case 'quota_once':
    if (conversation) {
      doWork();
      finish('Đã làm tiếp xong.');
    } else {
      process.stderr.write('AGY_ERROR: {"code":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}\n');
      out({ event: 'result', result: { conversation_id: sessionId, status: 'ERROR', response: '', error: 'RESOURCE_EXHAUSTED: Quota exceeded', duration_seconds: 1, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }, finished_reason: 'error' } });
      process.exitCode = 3;
    }
    break;
  case 'bad_model':
    out({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'invalid model selection (--model "x"): model x is not recognized as a known model', duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }, finished_reason: 'error' } });
    process.exitCode = 1;
    break;
  case 'denied':
    // Lệnh Bash chưa được cho phép: agy dừng lượt, kết quả trống, có denied_actions.
    // (Việc từ chối do agy tự làm, không qua hook: phát thẳng bước ERROR như agy thật.)
    step({ step_index: index, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'git --version' } } });
    step({ step_index: index, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'git --version' }, error: { type: 'TOOL_ERROR', message: 'permission check failed for unsandboxed "git --version": user denied permission to run command' } } });
    finish('', { denied_actions: [{ action: 'command', display_name: 'RunCommand' }] });
    break;
  case 'escape':
    // Cố ghi ra ngoài thư mục làm việc và sửa cấu hình công ty: hook phải chặn cả hai.
    tool('write_to_file', { TargetFile: path.join(cwd, '..', 'escaped.txt'), CodeContent: 'x' }, () => fs.writeFileSync(path.join(cwd, '..', 'escaped.txt'), 'x'));
    tool('write_to_file', { TargetFile: path.join(cwd, 'AGENTS.md'), CodeContent: 'x' }, () => fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'x'));
    tool('read_file', { Path: path.join(cwd, '..', '..', 'secret.txt') }, () => 'LỌT');
    doWork();
    finish('Xong sau khi bị chặn hai lần.');
    break;
  case 'many_steps':
    // Nhiều lượt hơn số cho phép (vai trò backend: 30), rồi treo: runner phải tự dừng.
    for (let n = 0; n < 45; n += 1) tool('read_file', { Path: path.join(cwd, 'README.md') }, () => 'ok');
    setInterval(() => {}, 1000);
    break;
  case 'crash':
    process.stderr.write('lỗi giả lập\n');
    process.exitCode = 2;
    break;
  default:
    doWork();
    say('Xong rồi.');
    finish('Đã làm: tạo hello.txt\nFile thay đổi: hello.txt');
}
