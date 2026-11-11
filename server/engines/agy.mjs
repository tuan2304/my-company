import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizedEnv } from '../guard.mjs';

/**
 * Engine "agy": Antigravity CLI (gói Google AI Pro/Ultra). Những điều dưới đây đều đã thử thật trên agy 1.5.3 (xem tài liệu dự án),
 * không phải đoán:
 * - Luồng `--output-format stream-json` có ba loại sự kiện {event:'init'|'step_update'|'result'}; parseLine đổi chúng về dạng Claude.
 * - Không có --max-turns, --tools, --append-system-prompt-file, --mcp-config: runner tự dừng theo số lượt; hook chặn thay cho --tools;
 *   lời nhắc hệ thống đi qua AGENTS.md trong thư mục làm việc; công cụ MCP của công ty (hỏi Trưởng nhóm, đồng nghiệp...) chưa dùng được.
 * - Chạy nền (-p) agy TỰ TỪ CHỐI mọi lệnh Bash chưa có luật cho phép. Luật `permissions.allow` ("command(<lệnh>)") chỉ khớp NGUYÊN VĂN
 *   (không có dấu * hay tham số thêm; lệnh ghép bằng && hoặc ; bị từ chối) nên nhân viên chỉ chạy đúng các lệnh đã khai trong hồ sơ dự án.
 * - `-p` luôn đòi lời nhắc làm tham số (không đọc stdin được).
 * - --effort xung đột với model đã có mức trong tên (gemini-3.8-flash-low...): chỉ truyền effort cho model không có mức trong tên.
 * - Không còn cách đo hạn mức bằng `/usage` (từ agy 1.5 nó bị coi là lời nhắc và tốn ~8 nghìn token): chỉ biết hết hạn mức khi lượt chạy lỗi.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');

export const AGENTS_BEGIN = '<!-- my-company:begin -->';
export const AGENTS_END = '<!-- my-company:end -->';
const GUARD_DIR_NAME = 'company-guard';

// Bậc model của công ty (haiku/sonnet/opus) -> model của agy, theo thứ tự ưu tiên; lấy cái đầu tiên đang có trong `agy models`.
// Gemini và Claude+GPT là hai nhóm hạn mức riêng nên bậc trung dùng Gemini để chừa hạn mức Claude cho bậc cao.
export const TIER_PREFERENCE = {
  haiku: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'],
  sonnet: ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'claude-sonnet-4-6'],
  opus: ['claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gemini-3.8-flash-high'],
};

const EMBEDDED_LEVEL = /-(low|medium|high)$/;

/** Danh sách model từ `agy models`: mỗi dòng "<id>\t<tên hiển thị>". */
export function parseModelList(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((cols) => cols.length >= 2 && /^[a-z0-9][\w.-]*$/i.test(cols[0].trim()))
    .map(([id, label]) => ({ id: id.trim(), label: label.trim() }));
}

/**
 * Tên model dùng cho agy. `name` có thể là bậc của công ty (haiku/sonnet/opus), một id agy cụ thể (giữ nguyên),
 * hoặc rỗng. `available` là mảng id đang có (null = chưa biết, lấy lựa chọn ưu tiên đầu tiên).
 * Trả về undefined nếu không chọn được: khi đó không truyền --model và agy dùng model mặc định.
 */
export function resolveModel(name, available = null) {
  const key = String(name ?? '').toLowerCase();
  const tier = Object.keys(TIER_PREFERENCE).find((t) => key.includes(t));
  if (!tier) return name || undefined;
  const list = TIER_PREFERENCE[tier];
  if (!Array.isArray(available) || available.length === 0) return list[0];
  return list.find((id) => available.includes(id)) ?? undefined;
}

function modelArgs({ model, effort, available }) {
  const id = resolveModel(model, available);
  const args = [];
  if (id) args.push('--model', id);
  // agy từ chối --effort đi cùng model đã có mức trong tên.
  if (effort && !(id && EMBEDDED_LEVEL.test(id))) args.push('--effort', effort);
  return args;
}

/** Luật cho phép lệnh Bash: chỉ đúng các lệnh đã khai trong hồ sơ dự án, khớp nguyên văn. */
export function buildAllowRules(role, project) {
  if (!role?.tools?.includes('Bash')) return [];
  return [...new Set((project?.allowedCommands ?? []).map((c) => `command(${c})`))];
}

function settingsArg(role, project) {
  return JSON.stringify({ permissions: { allow: buildAllowRules(role, project) } });
}

function taskArgs({ task, role, project, resume, models }) {
  const args = ['--output-format', 'stream-json', ...modelArgs({ model: role.model, effort: role.effort, available: models })];
  args.push('--settings', settingsArg(role, project));
  if (resume && task.session_id) args.push('--conversation', task.session_id);
  return args;
}

function answerArgs({ model, effort, session, models }) {
  const args = ['--output-format', 'stream-json', ...modelArgs({ model, effort, available: models })];
  args.push('--settings', JSON.stringify({ permissions: { allow: [] } }));
  if (session) args.push('--conversation', session);
  return args;
}

function leadArgs() {
  throw new Error('Engine agy chưa chạy được lượt của Trưởng nhóm hoặc Giám đốc (cần công cụ MCP của công ty).');
}

// ---- Đổi sự kiện của agy về dạng Claude ----

const toolInput = (params = {}) => ({
  ...params,
  file_path: params.Path ?? params.TargetFile ?? params.AbsolutePath ?? params.File ?? params.SearchPath ?? undefined,
  command: params.CommandLine ?? undefined,
});

function usageOf(u = {}) {
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0),
    cache_read_input_tokens: u.cache_read_tokens ?? 0,
    cache_creation_input_tokens: 0,
  };
}

function addUsage(total, u) {
  for (const key of Object.keys(u)) total[key] = (total[key] ?? 0) + u[key];
}

/**
 * `scratch` là một object riêng của từng lượt chạy (runner đưa vào), để ghép các mảnh chữ và theo dõi bước công cụ.
 * scratch.turns đếm số lượt trả lời (mỗi tin nhắn của AI hoặc mỗi lần gọi công cụ) vì num_turns của agy luôn bằng 1.
 */
export function parseAgyLine(line, scratch = {}) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  scratch.text ??= {};
  scratch.tools ??= new Set();
  scratch.usage ??= { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  scratch.turns ??= 0;

  if (msg.event === 'init') {
    const init = msg.init ?? {};
    scratch.conversation = msg.conversation_id ?? null;
    return [{ type: 'system', subtype: 'init', session_id: msg.conversation_id ?? null, model: init.model, skills: undefined }];
  }

  if (msg.event === 'step_update') {
    const step = msg.step_update ?? {};
    const index = step.step_index;
    const out = [];
    if (step.step_type === 'agent_response') {
      if (typeof step.text_delta === 'string') scratch.text[index] = (scratch.text[index] ?? '') + step.text_delta;
      if (step.state === 'DONE') {
        if (step.usage) addUsage(scratch.usage, usageOf(step.usage));
        const text = (scratch.text[index] ?? '').trim();
        delete scratch.text[index];
        if (text) {
          scratch.turns += 1;
          out.push({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
        }
      }
    } else if (step.step_type === 'tool') {
      const info = step.tool_info ?? {};
      const name = step.tool_name ?? info.name ?? 'tool';
      if (!scratch.tools.has(index)) {
        scratch.tools.add(index);
        scratch.turns += 1;
        out.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `step-${index}`, name, input: toolInput(info.parameters) }] } });
      }
      if (step.state === 'DONE' || step.state === 'ERROR') {
        const failed = step.state === 'ERROR';
        const content = failed ? String(info.error?.message ?? 'lỗi') : String(info.output ?? '');
        out.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `step-${index}`, is_error: failed, content }] } });
      }
    }
    return out.length ? out : [];
  }

  if (msg.event === 'result') {
    const res = msg.result ?? {};
    const ok = res.status === 'SUCCESS';
    const out = [];
    const denied = Array.isArray(res.denied_actions) ? res.denied_actions : [];
    if (denied.length) {
      out.push({
        type: 'system', subtype: 'error',
        message: `agy từ chối ${denied.map((d) => d.display_name ?? d.action).join(', ')}: lệnh không nằm trong danh sách được phép, nên lượt bị dừng sớm.`,
      });
    }
    if (res.usage) {
      scratch.usage = usageOf(res.usage);
    }
    let text = ok ? String(res.response ?? '') : String(res.error ?? res.response ?? 'agy báo lỗi');
    if (ok && text.trim() === '' && denied.length) text = '(agy dừng vì một thao tác bị từ chối nên không có báo cáo; xem nhật ký)';
    out.push({
      type: 'result',
      subtype: ok ? 'success' : 'error_during_execution',
      is_error: !ok,
      result: text,
      num_turns: scratch.turns,
      duration_ms: Math.round((res.duration_seconds ?? 0) * 1000),
      usage: scratch.usage,
      total_cost_usd: 0,
      terminal_reason: res.finished_reason,
    });
    return out;
  }
  return [];
}

// ---- Nhận ra hết hạn mức ----

const QUOTA = /(resource[_ ]exhausted|quota|usage limit|rate[ _-]?limit|too many requests|\b429\b|exceeded your (current |daily |weekly )?(usage|limit|quota))/i;
const ISO_AFTER_RESET = /reset[^0-9]{0,24}(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i;

/**
 * Chưa có mẫu lỗi hết hạn mức thật của agy (chưa thể thử), nên dựa vào chữ trong lỗi: kết quả lỗi, dòng AGY_ERROR trên stderr.
 * Nếu thấy giờ hồi dạng ISO sau chữ "reset" thì dùng, không thì runner lùi dần.
 * Trả về thông tin cùng dạng với parseRateLimitEvent hoặc null.
 */
export function detectAgyQuota({ res, stderrTail = '' } = {}) {
  const sources = [res?.is_error ? String(res.result ?? '') : '', String(stderrTail)];
  const text = sources.find((s) => QUOTA.test(s));
  if (!text) return null;
  const iso = text.match(ISO_AFTER_RESET)?.[1];
  const ms = iso ? Date.parse(iso) : NaN;
  return { status: 'exhausted', blocked: true, type: null, resetsAt: Number.isFinite(ms) ? ms : null, windows: {}, overageStatus: null, isUsingOverage: false };
}

// ---- Chuẩn bị thư mục làm việc ----

function writeUtf8(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Không BOM: agy từ chối file JSON có BOM.
  fs.writeFileSync(file, text, { encoding: 'utf8' });
}

/** Bỏ khối lời nhắc cũ của công ty khỏi AGENTS.md để làm lại không bị chồng lên. */
export function stripAgentsBlock(text) {
  const a = text.indexOf(AGENTS_BEGIN);
  const b = text.indexOf(AGENTS_END);
  if (a < 0 || b < a) return text;
  return `${text.slice(0, a)}${text.slice(b + AGENTS_END.length)}`.replace(/^\s+/, '');
}

function mergeHooks(file, command) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* chưa có hoặc hỏng: tạo mới */
  }
  const hooks = current.hooks && typeof current.hooks === 'object' ? current.hooks : {};
  const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const mine = { matcher: '.*', hooks: [{ type: 'command', command }] };
  const others = pre.filter((entry) => !JSON.stringify(entry).includes(GUARD_DIR_NAME));
  return { ...current, hooks: { ...hooks, PreToolUse: [...others, mine] } };
}

const PROMPT_FILE_LIMIT = 12_000;

/**
 * Chuẩn bị mọi thứ agy cần mà không có cờ dòng lệnh tương ứng, rồi trả { cwd, args }.
 * - Thư mục làm việc (worktree) nhận: .agents/hooks.json (hook chặn file), .agents/company-guard/ (script + config), .agents/skills/<tên>/
 *   (skill đã duyệt), AGENTS.md (lời nhắc hệ thống). Tất cả đều được loại khỏi commit (workspaceExcludes).
 * - Lượt chỉ đọc (trả lời câu hỏi) chạy từ thư mục riêng của lượt (`runDir`) với `--add-dir` trỏ vào thư mục thật, để không ghi gì vào dự án.
 */
export function prepareAgyRun({ cwd, runDir, readonly, guardMode = null, root, allow = [], commands = [], systemText = '', skillsDir = null, prompt = '' }) {
  const base = readonly ? runDir : cwd;
  const agentsDir = path.join(base, '.agents');
  const guardDir = path.join(agentsDir, GUARD_DIR_NAME);
  fs.mkdirSync(guardDir, { recursive: true });

  for (const file of ['agy-guard.mjs', 'path-guard.mjs']) fs.copyFileSync(path.join(SERVER_DIR, file), path.join(guardDir, file));
  writeUtf8(path.join(guardDir, 'config.json'), JSON.stringify({ root, allow, mode: readonly ? 'readonly' : guardMode ?? 'worker' }, null, 2));
  // Lệnh KHÔNG dùng dấu ngoặc kép (agy làm hỏng chúng trên Windows); thư mục hiện tại của hook là .agents.
  writeUtf8(path.join(agentsDir, 'hooks.json'), JSON.stringify(mergeHooks(path.join(agentsDir, 'hooks.json'), `node ${GUARD_DIR_NAME}/agy-guard.mjs`), null, 2));

  const skillsRoot = skillsDir ? path.join(skillsDir, 'skills') : null;
  if (skillsRoot && fs.existsSync(skillsRoot)) {
    for (const name of fs.readdirSync(skillsRoot)) {
      fs.cpSync(path.join(skillsRoot, name), path.join(agentsDir, 'skills', name), { recursive: true, force: true });
    }
  }

  // agy dừng cả phiên ngay khi một lệnh bị từ chối (không kịp báo cáo), nên phải dặn trước chứ không chỉ chặn.
  const listed = commands.map((c) => `\`${c}\``).join(', ');
  const shell = readonly || commands.length === 0
    ? 'Bạn không được chạy lệnh shell nào.'
    : `Bạn chỉ được chạy lệnh shell đúng nguyên văn một trong các lệnh sau: ${listed} (không thêm tham số, không ghép bằng && hoặc ;).`;
  const rules = `\n\n## Giới hạn của công cụ (bắt buộc)\n- ${shell}\n- Mọi lệnh khác bị từ chối và làm phiên dừng ngay, không kịp báo cáo. Hãy dùng công cụ đọc, tìm và sửa file thay cho ls, dir, cat, echo, mkdir.`;
  const where = readonly ? `\n\nThư mục dự án cần đọc là \`${root}\` (không phải thư mục hiện tại). Hãy dùng đường dẫn tuyệt đối trong thư mục đó.` : '';
  const agentsFile = path.join(base, 'AGENTS.md');
  const existing = fs.existsSync(agentsFile) ? stripAgentsBlock(fs.readFileSync(agentsFile, 'utf8')) : '';
  writeUtf8(agentsFile, `${AGENTS_BEGIN}\n${systemText.trim()}${rules}${where}\n${AGENTS_END}\n${existing ? `\n${existing}` : ''}`);

  // -p đòi lời nhắc làm tham số. Lời nhắc quá dài (giới hạn dòng lệnh của Windows ~32 nghìn ký tự) thì đưa vào file trong thư mục làm việc.
  let text = prompt;
  if (prompt.length > PROMPT_FILE_LIMIT) {
    writeUtf8(path.join(agentsDir, 'task-prompt.md'), prompt);
    text = `Yêu cầu đầy đủ nằm trong file ${path.join(agentsDir, 'task-prompt.md')}. Hãy đọc file đó và làm đúng theo nội dung của nó.`;
  }
  return { cwd: base, args: [...(readonly ? ['--add-dir', root] : []), '-p', text] };
}

export const agyEngine = {
  id: 'agy',
  label: 'Antigravity',
  capabilities: { mcp: false, maxTurns: false, triage: false },
  /** Khối "Skill của bạn" trong lời nhắc hệ thống: agy nạp skill có sẵn thay vì gọi công cụ Skill. */
  skillMode: 'native',
  /** File công ty đặt vào worktree: không được commit. */
  workspaceExcludes: ['.agents', 'AGENTS.md'],

  /** Model agy đang có (id). null = chưa biết; được cập nhật bởi doctor / sau này là /api/engines. */
  models: null,

  command(cfg) {
    return { bin: cfg.agyBin ?? 'agy', prefix: cfg.agyArgsPrefix ?? [] };
  },

  /** Gỡ khóa API của Google để agy chỉ dùng gói đăng ký. */
  env(base) {
    const env = sanitizedEnv(base);
    for (const key of Object.keys(env)) {
      if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_CLOUD_PROJECT|GOOGLE_APPLICATION_CREDENTIALS|AGY_ADC_AUTH)$/i.test(key)) delete env[key];
    }
    return env;
  },

  taskArgs(params) {
    return taskArgs({ ...params, models: agyEngine.models?.map((m) => m.id) ?? null });
  },
  answerArgs(params) {
    return answerArgs({ ...params, models: agyEngine.models?.map((m) => m.id) ?? null });
  },
  leadArgs,
  // Hook nằm trong thư mục làm việc (prepare), không phải file --settings.
  guardSettings() {
    return {};
  },
  prepare: prepareAgyRun,
  parseLine: parseAgyLine,
  detectQuota: detectAgyQuota,

  triageArgs() {
    return [];
  },
  parseTriageOutput() {
    return null;
  },

  missingHint(cfg) {
    return ` Không tìm thấy lệnh "${cfg.agyBin ?? 'agy'}". Hãy cài Antigravity CLI và đăng nhập (chạy "agy" một lần).`;
  },

  modelFor(tier) {
    return resolveModel(tier, agyEngine.models?.map((m) => m.id) ?? null) ?? null;
  },

  /** Danh sách model thật lấy từ `agy models` (đồng thời cập nhật bộ nhớ dùng khi chọn model theo bậc). */
  async detect(cfg, { run }) {
    const out = { installed: false, version: null, loggedIn: null, models: [], detail: '' };
    const bin = cfg.agyBin ?? 'agy';
    const prefix = cfg.agyArgsPrefix ?? [];
    try {
      out.version = await run(bin, [...prefix, '--version']);
      out.installed = true;
    } catch {
      out.detail = `Không chạy được "${bin}".`;
      return out;
    }
    try {
      out.models = parseModelList(await run(bin, [...prefix, 'models']));
      agyEngine.models = out.models;
      out.loggedIn = out.models.length > 0;
      if (!out.loggedIn) out.detail = 'agy không liệt kê model nào: có thể chưa đăng nhập.';
    } catch {
      out.detail = 'Không lấy được danh sách model: có thể chưa đăng nhập hoặc mất mạng.';
    }
    return out;
  },

  /** Cài đặt + danh sách model thật. Chỉ chạy lệnh trạng thái, không tốn hạn mức. */
  async doctor(cfg, { run, result }) {
    const checks = [];
    const bin = cfg.agyBin ?? 'agy';
    const prefix = cfg.agyArgsPrefix ?? [];
    try {
      const version = await run(bin, [...prefix, '--version']);
      checks.push(result('agy', 'ok', `Antigravity CLI ${version}`));
    } catch {
      checks.push(result('agy', 'fail', `Không chạy được "${bin}"`, 'Hãy cài Antigravity CLI và đăng nhập bằng tài khoản Google có gói AI Pro hoặc Ultra.'));
      return checks;
    }
    try {
      const models = parseModelList(await run(bin, [...prefix, 'models']));
      agyEngine.models = models;
      checks.push(
        models.length
          ? result('agy-models', 'ok', `${models.length} model: ${models.map((m) => m.id).join(', ')}`)
          : result('agy-models', 'warn', 'agy không liệt kê model nào', 'Có thể chưa đăng nhập: chạy "agy" một lần và đăng nhập.'),
      );
    } catch {
      checks.push(result('agy-models', 'warn', 'Không lấy được danh sách model của agy', 'Có thể chưa đăng nhập hoặc mất mạng.'));
    }
    return checks;
  },
};
