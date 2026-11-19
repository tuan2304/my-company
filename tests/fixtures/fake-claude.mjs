// Giả lập `claude -p --output-format stream-json` để kiểm thử mà không tốn hạn mức.
// Kịch bản chọn bằng biến môi trường FAKE_CLAUDE_SCENARIO; mọi lần chạy ghi lại
// tham số và môi trường vào FAKE_CLAUDE_LOG (mỗi dòng một JSON).
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.0.0-fake');
  process.exit(0);
}

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'success';
const resumed = args.includes('--resume');
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;

// Lần gọi đánh giá độ khó (triage): có --system-prompt và đầu ra JSON một khối.
const isTriage = args.includes('--system-prompt');

// Gói skill chỉ tồn tại lúc tiến trình chạy (runner dọn nó khi xong việc), nên ghi lại tên skill ngay bây giờ.
const pluginFlag = args.indexOf('--plugin-dir');
let pluginSkills = null;
try {
  if (pluginFlag >= 0) pluginSkills = fs.readdirSync(path.join(args[pluginFlag + 1], 'skills')).sort();
} catch {
  /* không có gói */
}

if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    `${JSON.stringify({
      args, prompt, cwd: process.cwd(), resumed, isTriage, pluginSkills,
      guard: { root: process.env.COMPANY_GUARD_ROOT, allow: process.env.COMPANY_GUARD_ALLOW, mode: process.env.COMPANY_GUARD_MODE, links: process.env.COMPANY_GUARD_LINKS },
      hasApiKey: Object.keys(process.env).some((k) => k.toUpperCase() === 'ANTHROPIC_API_KEY'),
      hasNestedVar: Object.keys(process.env).some((k) => k.toUpperCase() === 'CLAUDECODE'),
    })}\n`,
  );
}

if (isTriage) {
  const mode = process.env.FAKE_CLAUDE_TRIAGE ?? 'normal';
  if (mode === 'crash') process.exit(1);
  const text = mode === 'garbage' ? 'không có JSON ở đây' : `Đây là kết quả: {"level":"${mode}","reason":"Lý do giả lập cho mức ${mode}."}`;
  process.stdout.write(`${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.001,
    usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 11 },
  })}\n`);
  process.exit(0);
}

const sessionId = 'fake-session-1234';
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const nowSec = Math.floor(Date.now() / 1000);

out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', cwd: process.cwd() });

const rateLimit = (status, resetsAt) => out({
  type: 'rate_limit_event',
  rate_limit_info: {
    status, resetsAt, rateLimitType: 'five_hour',
    unifiedWindows: { five_hour: { utilization: status === 'allowed' ? 0.4 : 1, resetsAt } },
  },
});

const result = (extra) => out({
  type: 'result', session_id: sessionId, duration_ms: 1200, num_turns: 3, total_cost_usd: 0.05,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 400 },
  ...extra,
});

const doWork = () => {
  const base = process.cwd().split(/[\\/]/).at(-1);
  let file = 'hello.txt';
  let content = 'xin chào\n';
  if (process.env.FAKE_UNIQUE) file = `out-${base}.txt`; // mỗi việc một file riêng: gộp nhánh không xung đột
  if (process.env.FAKE_CONFLICT) {
    file = 'shared.txt'; // mọi việc cùng sửa một file: gộp nhánh sẽ xung đột
    content = `nội dung của ${base}\n`;
  }
  fs.writeFileSync(file, content);
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Mình bắt đầu làm.' }, { type: 'tool_use', name: 'Write', input: { file_path: file, content } }] } });
  // FAKE_SIDE_EFFECT='tsconfig.json': file do lệnh khác tự sinh (như next dev sửa tsconfig.json), không qua công cụ ghi file.
  if (process.env.FAKE_SIDE_EFFECT) fs.writeFileSync(process.env.FAKE_SIDE_EFFECT, `sinh bởi công cụ ${base}\n`);
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok', is_error: false }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Xong, token=sk-ant-abcdefghijklmnop' }] } });
};

// Gọi công cụ của công ty qua HTTP như cầu nối MCP sẽ làm.
const makeCall = () => {
  const mcp = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.company.env;
  return async (name, input) => {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: `mcp__company__${name}`, input }] } });
    const res = await fetch(`${mcp.COMPANY_API_URL}/api/agent/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${mcp.COMPANY_RUN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, arguments: input }),
    });
    const reply = await res.json();
    out({ type: 'user', message: { content: [{ type: 'tool_result', content: reply.text ?? '', is_error: Boolean(reply.isError) }] } });
    return reply;
  };
};

const allowedArg = args.includes('--allowedTools') ? args[args.indexOf('--allowedTools') + 1] : '';

// ---- Lượt trả lời câu hỏi của đồng nghiệp (giai đoạn 6D): không MCP, chỉ trả về văn bản ----
// Lượt tiếp tục (--resume) có lời nhắc khác, nên nhận ra bằng cách chạy: chỉ đọc và không có MCP (Trưởng nhóm thì có MCP).
const isAnswerRun = prompt.startsWith('# Trả lời câu hỏi') || (process.env.COMPANY_GUARD_MODE === 'readonly' && !args.includes('--mcp-config'));
if (isAnswerRun) {
  rateLimit('allowed', nowSec + 3600);
  const mode = process.env.FAKE_ANSWER_MODE ?? 'ok';
  if (mode === 'crash') {
    process.stderr.write('lỗi giả lập khi trả lời\n');
    process.exit(2);
  }
  if (mode === 'hang') {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (mode === 'quota_once' && !resumed) {
    // Lần đầu chạm hạn mức; làm tiếp (--resume) thì trả lời được.
    rateLimit('rejected', nowSec + Number(process.env.FAKE_CLAUDE_RESET_IN ?? 2));
    result({ subtype: 'success', is_error: true, result: "You've hit your limit", terminal_reason: 'rate_limited' });
    process.exit(1);
  }
  if (process.env.FAKE_ANSWER_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_ANSWER_DELAY_MS)));
  const text = mode === 'empty' ? '' : (process.env.FAKE_ANSWER ?? 'Dùng cách A.');
  result({ subtype: 'success', is_error: false, result: text, num_turns: 2 });
  process.exit(0);
}

// ---- Nhân viên có công cụ hỏi (giai đoạn 6D) ----
// FAKE_ASK (hoặc FAKE_ASK_MAP theo số việc) là danh sách [{tool, input}] sẽ gọi ở lần chạy đầu rồi kết thúc lượt, đúng như được dặn.
// Lần chạy tiếp (--resume) có câu trả lời thì làm việc bình thường và nêu lại câu trả lời trong kết quả.
const isWorkerWithTools = args.includes('--mcp-config') && allowedArg.includes('mcp__company__ask_lead');
if (isWorkerWithTools) {
  const call = makeCall();
  rateLimit('allowed', nowSec + 3600);
  const taskId = prompt.match(/^# Việc #(\d+)/)?.[1];
  const map = JSON.parse(process.env.FAKE_ASK_MAP ?? '{}');
  const asks = (resumed ? null : (map[taskId] ?? (process.env.FAKE_ASK ? JSON.parse(process.env.FAKE_ASK) : null)));
  if (asks) {
    const replies = [];
    for (const item of asks) replies.push((await call(item.tool, item.input)).text);
    if (process.env.FAKE_ASK_KEEP_WORKING) doWork(); // nhân viên không nghe lời: cứ làm tiếp dù đã hỏi
    // Ở lại một lúc sau khi hỏi (để câu trả lời kịp đến TRƯỚC khi lượt chạy này kết thúc).
    if (process.env.FAKE_ASK_LINGER_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_ASK_LINGER_MS)));
    if (process.env.FAKE_ASK_RESULT === 'max_turns') {
      result({ subtype: 'error_max_turns', is_error: true, result: '', terminal_reason: 'max_turns' });
      process.exit(1);
    }
    result({ subtype: 'success', is_error: false, result: `Đang chờ trả lời. ${replies.join(' | ')}` });
    process.exit(0);
  }
  if (resumed && /câu trả lời/i.test(prompt)) {
    doWork();
    result({ subtype: 'success', is_error: false, result: `Đã làm tiếp theo câu trả lời.\n${prompt}` });
    process.exit(0);
  }
  // Không có gì để hỏi: làm việc như nhân viên thường (rơi xuống kịch bản bên dưới).
}

// ---- Lượt của Trưởng nhóm: gọi công cụ của công ty qua HTTP như cầu nối MCP sẽ làm ----
if (args.includes('--mcp-config') && !isWorkerWithTools) {
  const call = makeCall();
  rateLimit('allowed', nowSec + 3600);
  // Giữ Trưởng nhóm / Giám đốc ở trạng thái "đang làm" một lúc (để nhìn hoạt ảnh trong văn phòng 3D).
  if (process.env.FAKE_LEAD_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_LEAD_DELAY_MS)));

  const allowed = allowedArg;
  // FAKE_LEAD_FAIL='plan,dplan,dreview': các loại lượt của Trưởng nhóm/Giám đốc cần giả lập tiến trình tự thoát (lỗi).
  const leadKind = allowed.includes('mcp__company__review_submission') ? 'review'
    : allowed.includes('mcp__company__finish_epic') ? 'dreview'
      : allowed.includes('mcp__company__set_contract') ? 'dplan' : 'plan';
  if ((process.env.FAKE_LEAD_FAIL ?? '').split(',').includes(leadKind)) {
    process.stderr.write(`lỗi giả lập của lượt ${leadKind}\n`);
    await new Promise((r) => setTimeout(r, 100)); // để dòng "init" (mã phiên) kịp ra khỏi ống trước khi thoát
    process.exit(2);
  }
  if (allowed.includes('mcp__company__review_submission')) {
    // Duyệt bài
    const subject = Number(prompt.match(/task_id: (\d+)/)?.[1]);
    const revisions = Number(prompt.match(/Số lần đã trả bài: (\d+)/)?.[1] ?? 0);
    const map = JSON.parse(process.env.FAKE_REVIEW_MAP ?? '{}');
    const mode = map[subject] ?? process.env.FAKE_REVIEW ?? 'approve';
    const verdict = mode === 'reject_always' || (mode === 'reject_once' && revisions === 0) ? 'reject' : 'approve';
    if (mode !== 'none') {
      await call('review_submission', { task_id: subject, verdict, feedback: verdict === 'reject' ? 'Thiếu test cho trường hợp lỗi, hãy bổ sung.' : 'Đạt yêu cầu.' });
    }
    result({ subtype: 'success', is_error: false, result: `Đã duyệt xong việc #${subject} (${mode}).` });
  } else if (allowed.includes('mcp__company__finish_epic')) {
    // Giám đốc kiểm tra kết quả đã ghép
    const mode = process.env.FAKE_DREVIEW ?? 'accept';
    const round = Number(prompt.match(/Đợt làm lại đã dùng: (\d+)/)?.[1] ?? 0);
    await call('get_company_overview', {});
    if (mode === 'rework_once' && round === 0) {
      const job = JSON.parse(process.env.FAKE_REWORK_JOB);
      const reply = await call('create_team_job', job);
      // Cố tình gọi finish_epic ngay sau khi giao việc làm lại: hệ thống phải từ chối.
      const early = await call('finish_epic', { verdict: 'accept', report: 'Báo cáo quá sớm, phải bị từ chối.' });
      result({ subtype: 'success', is_error: false, result: `Giao việc làm lại: ${reply.text} | finish sớm: ${early.isError ? 'bị từ chối' : 'LỌT'}` });
    } else if (mode === 'none') {
      result({ subtype: 'success', is_error: false, result: 'Không kết luận gì cả.' });
    } else {
      const verdict = mode === 'attention' ? 'attention' : 'accept';
      await call('finish_epic', { verdict, report: `Báo cáo cuối cho chủ (${verdict}): các team đã làm xong phần của mình.` });
      result({ subtype: 'success', is_error: false, result: `Đã kiểm tra xong (${verdict}).` });
    }
  } else if (allowed.includes('mcp__company__set_contract')) {
    // Giám đốc lập kế hoạch (làm tiếp sau khi chủ từ chối thì dùng bản V2)
    const replanning = resumed && /Nhận xét của chủ/.test(prompt);
    const plan = JSON.parse((replanning && process.env.FAKE_DPLAN_V2) || process.env.FAKE_DPLAN || '{"jobs":[]}');
    await call('get_company_overview', {});
    if (plan.contract) await call('set_contract', { contract: plan.contract });
    const replies = [];
    for (const item of plan.jobs) replies.push((await call('create_team_job', item)).text);
    result({ subtype: 'success', is_error: false, result: `Kế hoạch của Giám đốc: ${plan.jobs.length} việc cho team.${replanning ? ' (đã lập lại theo nhận xét)' : ''}\n${replies.join('\n')}` });
  } else {
    // Trưởng nhóm lập kế hoạch: mỗi team có kế hoạch riêng trong FAKE_PLANS (khóa là id team ghi ở đầu yêu cầu)
    const teamId = prompt.match(/team_id: (\w+)/)?.[1];
    const plans = JSON.parse(process.env.FAKE_PLANS ?? '{}');
    // Lượt làm tiếp phiên cũ (--resume) có lời nhắc ngắn, không ghi team_id: nếu chỉ khai kế hoạch cho đúng một team thì dùng nó.
    const onlyPlan = Object.keys(plans).length === 1 ? Object.values(plans)[0] : null;
    const plan = plans[teamId] ?? (teamId ? null : onlyPlan) ?? JSON.parse(process.env.FAKE_PLAN ?? '[]');
    await call('get_team_workload', {});
    const replies = [];
    // FAKE_CONTEST: kế hoạch của việc lớn thi đấu skill (một lần gọi assign_contest thay vì assign_to_member).
    if (process.env.FAKE_CONTEST) replies.push((await call('assign_contest', JSON.parse(process.env.FAKE_CONTEST))).text);
    else for (const item of plan) replies.push((await call('assign_to_member', item)).text);
    result({ subtype: 'success', is_error: false, result: `Kế hoạch: ${plan.length} việc con.\n${replies.join('\n')}` });
  }
  process.exit(0);
}

switch (scenario) {
  case 'quota':
    if (resumed) {
      rateLimit('allowed', nowSec + 3600);
      doWork();
      result({ subtype: 'success', is_error: false, result: 'Đã làm tiếp xong.' });
    } else {
      rateLimit('rejected', nowSec + Number(process.env.FAKE_CLAUDE_RESET_IN ?? 2));
      result({ subtype: 'success', is_error: true, result: "You've hit your limit", terminal_reason: 'rate_limited' });
      process.exitCode = 1;
    }
    break;
  case 'maxturns_once':
    // Lần đầu hết số lượt; làm tiếp (--resume) thì xong.
    rateLimit('allowed', nowSec + 3600);
    doWork();
    if (resumed) {
      result({ subtype: 'success', is_error: false, result: 'Xong sau khi được nâng bậc model.' });
    } else {
      result({ subtype: 'error_max_turns', is_error: true, result: '', terminal_reason: 'max_turns' });
      process.exitCode = 1;
    }
    break;
  case 'maxturns':
    rateLimit('allowed', nowSec + 3600);
    doWork();
    result({ subtype: 'error_max_turns', is_error: true, result: '', terminal_reason: 'max_turns' });
    process.exitCode = 1;
    break;
  case 'claim_only':
    // Nói đã sửa file nhưng không ghi gì (giả lập mất commit / ghi nhầm chỗ).
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Xong rồi.' }] } });
    result({ subtype: 'success', is_error: false, result: 'Đã làm: tạo hello.txt\nFile thay đổi: hello.txt, src/lib/moi.ts\nCách kiểm tra: mở file\nĐiều còn dang dở: không' });
    break;
  case 'crash':
    process.stderr.write('lỗi giả lập\n');
    process.exitCode = 2;
    break;
  case 'work_then_crash':
    // Ghi được phần bài rồi tiến trình chết (như hết hạn mức giữa chừng rồi engine sau chết ngay): bài dở được lưu tạm.
    doWork();
    process.stderr.write('lỗi giả lập sau khi đã làm\n');
    process.exitCode = 2;
    break;
  case 'crash_once':
    // Lần đầu tiến trình tự thoát; lần sau (--resume, tức tự thử lại) thì làm xong.
    if (resumed) {
      rateLimit('allowed', nowSec + 3600);
      doWork();
      result({ subtype: 'success', is_error: false, result: 'Xong sau khi tự thử lại.' });
    } else {
      process.stderr.write('lỗi giả lập một lần\n');
      process.exitCode = 2;
    }
    break;
  case 'hang':
    rateLimit('allowed', nowSec + 3600);
    setInterval(() => {}, 1000);
    break;
  default:
    rateLimit('allowed', nowSec + 3600);
    // FAKE_TOOLS='[["Read","src/a.ts"],["Bash","npm test"]]': phát lần lượt các lệnh gọi công cụ, mỗi lệnh cách nhau FAKE_TOOL_GAP_MS.
    for (const [name, detail] of JSON.parse(process.env.FAKE_TOOLS ?? '[]')) {
      const input = name === 'Bash' ? { command: detail } : name === 'Grep' ? { pattern: detail } : { file_path: detail };
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
      out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok', is_error: false }] } });
      await new Promise((r) => setTimeout(r, Number(process.env.FAKE_TOOL_GAP_MS ?? 0)));
    }
    doWork();
    // Làm chậm một chút để các nhân viên chạy chồng lên nhau (kiểm tra chạy song song).
    if (process.env.FAKE_WORK_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_WORK_DELAY_MS)));
    result({ subtype: 'success', is_error: false, result: 'Đã làm: tạo hello.txt\nFile thay đổi: hello.txt' });
}
