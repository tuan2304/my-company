import { mcpName } from '../agent-tools.mjs';
import { sanitizedEnv } from '../guard.mjs';

/**
 * Engine "claude": mọi thứ riêng của Claude Code CLI nằm ở đây (tham số dòng lệnh, cấu hình hook chặn file,
 * cách đọc luồng sự kiện, cách kiểm tra cài đặt). Runner, triage và doctor chỉ nói chuyện qua giao diện engine,
 * nên thêm engine khác (Antigravity, Codex) không phải sửa logic chạy việc.
 *
 * Giao diện engine:
 *   id, label                       tên máy và tên hiển thị
 *   command(cfg)                    { bin, prefix }: lệnh và tham số đứng trước để chạy CLI
 *   taskArgs / answerArgs / leadArgs   tham số cho lượt làm việc, lượt trả lời câu hỏi, lượt của Trưởng nhóm
 *   triageArgs(rubric)              tham số cho lần đánh giá độ khó
 *   parseTriageOutput(stdout)       { result, isError, usage, costUsd } hoặc null
 *   guardSettings(guardScript)      nội dung file cấu hình hook chặn file ngoài phạm vi
 *   parseLine(line)                 mảng sự kiện dạng Claude, hoặc null nếu dòng không đọc được
 *   missingHint(cfg)                gợi ý khi không tìm thấy lệnh
 *   doctor(cfg, { run, result })    các kiểm tra cho `my-company doctor`
 *   modelFor(tier)                  model thật mà engine dùng cho bậc haiku/sonnet/opus của công ty (null nếu không có)
 *   detect(cfg, { run })            { installed, version, loggedIn (true|false|null), models: [{id,label}], detail } cho trang liên kết AI (/api/engines)
 *   capabilities                    { mcp, maxTurns, triage }: có công cụ MCP của công ty không; CLI tự dừng theo số lượt không
 *                                   (không thì runner tự đếm và dừng); có tự đánh giá độ khó bằng model nhỏ không
 *   env(base)                       môi trường cho tiến trình con (gỡ khóa API tính tiền)
 *   skillMode                       'tool' (agent gọi công cụ Skill) hoặc 'native' (CLI tự nạp skill từ thư mục làm việc)
 *   workspaceExcludes               file/thư mục engine đặt vào worktree, không được commit
 * Tùy chọn (chỉ engine cần):
 *   prepare({...})                  chuẩn bị thư mục làm việc rồi trả { cwd, args } (xem agy.mjs); có prepare thì lời nhắc đi qua args, không qua stdin
 *   detectQuota({ res, stderrTail }) nhận ra hết hạn mức từ lỗi khi CLI không phát sự kiện rate_limit_event
 * parseLine(line, scratch) nhận thêm một object riêng của lượt chạy để ghép các sự kiện rời rạc; scratch.turns và scratch.usage
 * (dạng usage của Claude) là quy ước để runner đếm lượt khi CLI không có --max-turns.
 * Mọi engine phải đổi sự kiện của CLI mình về dạng Claude (system/assistant/user/rate_limit_event/result) trong parseLine.
 */

const ALWAYS_DENIED = ['Bash(git push)', 'Bash(git push *)', 'Bash(git remote *)'];

// Lệnh git chỉ đọc mà Trưởng nhóm được tự chạy khi duyệt bài.
const LEAD_GIT = ['git diff', 'git log', 'git show', 'git status'];

/** Công cụ tự động được phép: mọi công cụ không phải Bash, cộng các lệnh Bash trong hồ sơ dự án. */
export function buildAllowedTools(role, project) {
  const allowed = role.tools.filter((tool) => tool !== 'Bash');
  if (role.tools.includes('Bash')) {
    for (const command of project?.allowedCommands ?? []) {
      allowed.push(`Bash(${command})`, `Bash(${command} *)`);
    }
  }
  return allowed;
}

export function buildClaudeArgs({ task, role, project, systemFile, pluginDir, resume, settingsFile, mcpConfigFile = null, mcpTools = [] }) {
  // Có gói skill thì agent cần công cụ "Skill" để nạp chúng (vì --tools chỉ liệt kê công cụ có sẵn).
  const tools = pluginDir ? [...role.tools, 'Skill'] : role.tools;
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', role.model,
    '--effort', role.effort,
    '--tools', tools.join(','),
    // Không dùng acceptEdits: chế độ đó tự cho phép lệnh Bash ghi file (echo > file, mkdir, touch) trong worktree,
    // lách qua hook chặn thư mục. Edit và Write vẫn dùng được vì đã nằm trong --allowedTools; Bash chỉ chạy lệnh được khai.
    '--permission-mode', 'default',
    '--max-turns', String(role.max_turns),
    // Bỏ cấu hình người dùng (hook, plugin của bạn) để không tốn hạn mức vào ngữ cảnh thừa.
    // Không dùng --bare: chế độ đó chỉ nhận khóa API, không dùng được với gói Pro.
    '--setting-sources', 'project,local',
    '--strict-mcp-config',
    '--append-system-prompt-file', systemFile,
  ];
  const allowed = buildAllowedTools(role, project);
  if (pluginDir) allowed.push('Skill');
  // Công cụ hỏi người khác của công ty (qua MCP): chỉ nạp khi có cấu hình.
  if (mcpConfigFile) {
    allowed.push(...mcpTools.map(mcpName));
    args.push('--mcp-config', mcpConfigFile);
  }
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  args.push('--disallowedTools', ALWAYS_DENIED.join(','));
  if (pluginDir) args.push('--plugin-dir', pluginDir);
  if (settingsFile) args.push('--settings', settingsFile);
  if (resume && task.session_id) args.push('--resume', task.session_id);
  return args;
}

/** Tham số cho lượt trả lời câu hỏi: chỉ đọc, không công cụ MCP, không Bash. */
export function buildAnswerArgs({ model, effort, maxTurns, systemFile, settingsFile, session }) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--effort', effort,
    '--tools', 'Read,Grep,Glob',
    '--permission-mode', 'default',
    '--max-turns', String(maxTurns),
    '--setting-sources', 'project,local',
    '--strict-mcp-config',
    '--settings', settingsFile,
    '--append-system-prompt-file', systemFile,
    '--allowedTools', 'Read,Grep,Glob',
    '--disallowedTools', ALWAYS_DENIED.join(','),
  ];
  if (session) args.push('--resume', session);
  return args;
}

/** Tham số cho lượt làm việc của Trưởng nhóm (lập kế hoạch hoặc duyệt bài): chỉ đọc + công cụ của công ty. */
export function buildLeadArgs({ model, effort, maxTurns, systemFile, mcpConfigFile, settingsFile, mcpTools, session, extraBash = [] }) {
  const allowed = [
    'Read', 'Grep', 'Glob',
    ...[...LEAD_GIT, ...extraBash].flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]),
    ...mcpTools.map(mcpName),
  ];
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--effort', effort,
    '--tools', 'Read,Grep,Glob,Bash',
    '--max-turns', String(maxTurns),
    '--setting-sources', 'project,local',
    '--strict-mcp-config',
    '--mcp-config', mcpConfigFile,
    '--settings', settingsFile,
    '--append-system-prompt-file', systemFile,
    '--allowedTools', allowed.join(','),
    '--disallowedTools', [...ALWAYS_DENIED, ...LEAD_GIT.map((c) => `Bash(${c} *--output*)`)].join(','),
  ];
  if (session) args.push('--resume', session);
  return args;
}

/** Tham số cho lần đánh giá độ khó: model nhỏ nhất, không công cụ, một lượt. */
export function buildTriageArgs(rubric) {
  return [
    '-p',
    '--output-format', 'json',
    '--model', 'haiku',
    '--effort', 'low',
    '--tools', '',
    '--max-turns', '1',
    '--setting-sources', 'project,local',
    '--strict-mcp-config',
    '--system-prompt', rubric,
  ];
}

/** Nội dung file --settings: hook PreToolUse chặn cứng file ngoài phạm vi (xem path-guard.mjs). */
export function buildGuardSettings(guardScript) {
  const script = guardScript.split('\\').join('/');
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit|NotebookEdit|Read',
          hooks: [{ type: 'command', command: `node "${script}"` }],
        },
      ],
    },
  };
}

export const claudeEngine = {
  id: 'claude',
  label: 'Claude Code',
  capabilities: { mcp: true, maxTurns: true, triage: true },
  skillMode: 'tool',
  workspaceExcludes: [],

  env(base) {
    return sanitizedEnv(base);
  },

  command(cfg) {
    return { bin: cfg.claudeBin, prefix: cfg.claudeArgsPrefix ?? [] };
  },

  taskArgs: buildClaudeArgs,
  answerArgs: buildAnswerArgs,
  leadArgs: buildLeadArgs,
  triageArgs: buildTriageArgs,
  guardSettings: buildGuardSettings,

  /** Đầu ra của `claude -p --output-format json`: một object, hoặc mảng sự kiện có phần tử `result` ở cuối. */
  parseTriageOutput(stdout) {
    let outer = null;
    try {
      const parsed = JSON.parse(stdout);
      outer = Array.isArray(parsed) ? parsed.findLast((m) => m?.type === 'result') : parsed;
    } catch {
      /* đầu ra không phải JSON */
    }
    if (!outer) return null;
    return { result: outer.result, isError: Boolean(outer.is_error), usage: outer.usage ?? {}, costUsd: outer.total_cost_usd ?? 0 };
  },

  /** Một dòng của luồng stream-json đã ở dạng Claude sẵn. Dòng không phải object JSON thì trả null để runner ghi "raw". */
  parseLine(line) {
    try {
      const msg = JSON.parse(line);
      return msg && typeof msg === 'object' ? [msg] : null;
    } catch {
      return null;
    }
  },

  missingHint(cfg) {
    return ` Không tìm thấy lệnh "${cfg.claudeBin}". Hãy kiểm tra Claude Code đã cài chưa.`;
  },

  modelFor(tier) {
    return tier;
  },

  /** Claude Code không có lệnh liệt kê model: dùng ba bậc đã biết (không có fable, xem teams.mjs). */
  async detect(cfg, { run }) {
    const out = { installed: false, version: null, loggedIn: null, models: [{ id: 'haiku', label: 'Haiku' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }], detail: '' };
    try {
      out.version = await run(cfg.claudeBin, [...(cfg.claudeArgsPrefix ?? []), '--version']);
      out.installed = true;
    } catch {
      out.detail = `Không chạy được "${cfg.claudeBin}".`;
      return out;
    }
    if ((cfg.claudeArgsPrefix ?? []).length === 0) {
      try {
        const status = JSON.parse(await run(cfg.claudeBin, ['auth', 'status']));
        out.loggedIn = Boolean(status.loggedIn) && status.authMethod === 'claude.ai';
        out.detail = out.loggedIn ? `Tài khoản claude.ai, gói ${status.subscriptionType ?? 'không rõ'}` : 'Chưa đăng nhập bằng tài khoản claude.ai.';
      } catch {
        out.detail = 'Không đọc được trạng thái đăng nhập.';
      }
    }
    return out;
  },

  /** Kiểm tra cài đặt và đăng nhập. Chỉ chạy lệnh trạng thái, không tốn hạn mức. */
  async doctor(cfg, { run, result }) {
    const checks = [];
    let found = false;
    try {
      const version = await run(cfg.claudeBin, [...cfg.claudeArgsPrefix, '--version']);
      found = true;
      checks.push(result('claude', 'ok', `Claude Code ${version}`));
    } catch {
      checks.push(result('claude', 'fail', `Không chạy được "${cfg.claudeBin}"`, 'Hãy cài Claude Code và đăng nhập bằng tài khoản Pro.'));
    }

    if (found && cfg.claudeArgsPrefix.length === 0) {
      try {
        const status = JSON.parse(await run(cfg.claudeBin, ['auth', 'status']));
        if (!status.loggedIn) {
          checks.push(result('auth', 'fail', 'Claude Code chưa đăng nhập', 'Chạy "claude" một lần và đăng nhập bằng tài khoản Pro.'));
        } else if (status.authMethod !== 'claude.ai') {
          checks.push(result('auth', 'fail', `Đang đăng nhập kiểu "${status.authMethod}", không phải tài khoản claude.ai`, 'Công ty chỉ chạy bằng gói Pro, không dùng API.'));
        } else {
          const plan = status.subscriptionType ?? 'không rõ';
          checks.push(
            plan === 'pro'
              ? result('auth', 'ok', `Đăng nhập bằng tài khoản claude.ai (gói ${plan})`)
              : result('auth', 'warn', `Đăng nhập bằng tài khoản claude.ai, gói "${plan}" (không phải Pro)`),
          );
        }
      } catch {
        checks.push(result('auth', 'warn', 'Không đọc được trạng thái đăng nhập', 'Phiên bản Claude Code có thể không hỗ trợ "claude auth status".'));
      }
    }
    return checks;
  },
};
