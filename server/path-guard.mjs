#!/usr/bin/env node
/**
 * Hook PreToolUse của Claude Code: chặn CỨNG việc đọc/ghi file ngoài phạm vi, không dựa vào việc AI tự giữ lời.
 * Cấu hình qua biến môi trường do runner đặt:
 *   COMPANY_GUARD_ROOT   thư mục làm việc (worktree); mọi file phải nằm trong đây
 *   COMPANY_GUARD_ALLOW  JSON mảng thư mục được phép SỬA, tính từ gốc worktree. Mục bắt đầu bằng "!" là loại trừ
 *                        (ví dụ ["src/app", "!src/app/api"]). Rỗng = sửa được mọi nơi trong gốc (trừ chế độ "scoped").
 *   COMPANY_GUARD_MODE   "worker" (sửa được trong phạm vi), "scoped" (như worker nhưng danh sách rỗng = KHÔNG sửa được gì,
 *                        dùng cho team chỉ ghi tài liệu) hoặc "readonly" (không sửa gì, dùng cho Trưởng nhóm)
 *   COMPANY_GUARD_LINKS  JSON mảng thư mục được NỐI từ dự án vào worktree (worktree_links, ví dụ ["node_modules"]). Đích thật
 *                        của chúng nằm ngoài worktree nên realpath sẽ "ra ngoài": trong đó chỉ được ĐỌC, không được sửa.
 *   COMPANY_GUARD_COMMANDS JSON mảng lệnh Bash được phép (allowed_commands của hồ sơ dự án), để duyệt lệnh ghép.
 * Giao thức: đọc JSON từ stdin, thoát với mã 2 và in lý do ra stderr để chặn công cụ. Với Bash, khi mọi phần của lệnh đều
 * nằm trong luật của công ty thì in JSON "permissionDecision: allow" ra stdout để Claude Code khỏi hỏi (chạy nền không ai trả lời).
 *
 * Thư mục nháp `.company-tmp/` ở gốc worktree: nhân viên ghi và xóa thoải mái, không bị giới hạn thư mục của team, và không bao giờ
 * được commit (xem worktree.mjs). Dành cho file tạm, script thử nghiệm, kết quả chạy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const ENV_SAFE = /^\.env\.(example|sample|template|dist)$/i;
export const SCRATCH_DIR = '.company-tmp';

const isWin = process.platform === 'win32';
const norm = (p) => (isWin ? p.toLowerCase() : p);

/** realpath của đường dẫn, kể cả khi file chưa tồn tại (lấy realpath của thư mục cha có thật gần nhất). */
function realpathLoose(target) {
  const parts = [];
  let current = target;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return parts.length ? path.join(real, ...parts.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      parts.push(path.basename(current));
      current = parent;
    }
  }
}

const cleanFolder = (value) => String(value).trim().replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');

/**
 * Tách danh sách thư mục của một team thành phần được sửa (include) và phần loại trừ (exclude, viết "!đường/dẫn").
 * Khớp theo tiền tố đường dẫn: "src/lib" gồm cả "src/lib/a.ts" nhưng không gồm "src/library".
 */
export function folderRules(list) {
  const include = [];
  const exclude = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const text = String(raw).trim();
    const negated = text.startsWith('!');
    const folder = cleanFolder(negated ? text.slice(1) : text);
    if (folder) (negated ? exclude : include).push(folder);
  }
  return { include, exclude };
}

/** Đường dẫn (tính từ gốc, dạng a/b/c) có thuộc danh sách thư mục không. Danh sách không có mục "được sửa" nào thì coi là mọi nơi. */
export function inFolders(relPosix, list) {
  const { include, exclude } = folderRules(list);
  const rel = norm(cleanFolder(relPosix));
  const hit = (p) => rel === norm(p) || rel.startsWith(`${norm(p)}/`);
  return (include.length === 0 || include.some(hit)) && !exclude.some(hit);
}

/** Viết danh sách thư mục cho lời nhắc: "src/app, trừ src/app/api". */
export function describeFolders(list) {
  const { include, exclude } = folderRules(list);
  return [...include, ...exclude.map((e) => `trừ ${e}`)].join(', ');
}

const isOutside = (rel) => rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

/** Kiểm tra chung cho mọi đường dẫn đã được phép tới gần: file bí mật và thư mục .git thì không đọc, không sửa. */
function secretVerdict(segments) {
  const base = segments.at(-1) ?? '';
  if (/^\.env(\..+)?$/i.test(base) && !ENV_SAFE.test(base)) {
    return { allowed: false, reason: `Không được đọc hay sửa file bí mật ${base}.` };
  }
  if (segments.includes('.git')) {
    return { allowed: false, reason: 'Không được đụng vào thư mục .git.' };
  }
  return null;
}

export function decide({ toolName, toolInput, root, allow = [], mode = 'worker', links = [], commands = [] }) {
  if (toolName === 'Bash') return decideBash({ command: toolInput?.command, root, allow, mode, links, commands });
  const raw = toolInput?.file_path ?? toolInput?.notebook_path ?? toolInput?.path;
  if (typeof raw !== 'string' || raw === '') return { allowed: true };

  const rootReal = realpathLoose(path.resolve(root));
  const target = realpathLoose(path.resolve(root, raw));
  const rel = path.relative(norm(rootReal), norm(target));
  if (isOutside(rel)) {
    // Thư mục nối từ dự án (node_modules...): đích thật nằm ngoài worktree. Trong đó chỉ được đọc (tài liệu của thư viện,
    // mã nguồn gói), không được sửa: sửa là sửa thẳng vào dự án thật, lại không qua nhánh của việc.
    for (const name of Array.isArray(links) ? links : []) {
      const clean = cleanFolder(name);
      if (!clean || clean.split('/').includes('..')) continue;
      const linkReal = realpathLoose(path.resolve(root, clean));
      if (!isOutside(path.relative(norm(rootReal), norm(linkReal)))) continue; // không phải liên kết ra ngoài: theo luật thường
      const inLink = path.relative(norm(linkReal), norm(target));
      if (isOutside(inLink)) continue;
      if (WRITE_TOOLS.has(toolName)) {
        return { allowed: false, reason: `Thư mục ${clean} được nối từ dự án để đọc, không được sửa: ${raw}` };
      }
      const segments = [clean, ...path.relative(linkReal, target).split(path.sep)].join('/').split('/').filter(Boolean);
      return secretVerdict(segments) ?? { allowed: true };
    }
    return { allowed: false, reason: `Không được truy cập file ngoài thư mục làm việc: ${raw}` };
  }
  const relPosix = path.relative(rootReal, target).split(path.sep).join('/');
  const segments = relPosix.split('/');

  const secret = secretVerdict(segments);
  if (secret) return secret;

  if (WRITE_TOOLS.has(toolName)) {
    if (mode === 'readonly') return { allowed: false, reason: 'Vai trò này chỉ được đọc, không được sửa file.' };
    // Thư mục nháp: ghi thoải mái, không theo thư mục của team (không commit nên không ảnh hưởng ai).
    if (segments[0] === SCRATCH_DIR && segments.length > 1) return { allowed: true };
    const { include, exclude } = folderRules(allow);
    if (mode === 'scoped' && include.length === 0) {
      return {
        allowed: false,
        reason: 'Team của bạn chỉ được ghi vào thư mục khai trong hồ sơ dự án (local/project.md, mục folders), nhưng hồ sơ chưa khai thư mục nào cho team này. Hãy báo lại trong phần "Điều còn dang dở" để chủ dự án khai thư mục.',
      };
    }
    if ((include.length > 0 || exclude.length > 0) && !inFolders(relPosix, allow)) {
      const scope = [...include, ...exclude.map((e) => `trừ ${e}`)].join(', ');
      return {
        allowed: false,
        reason: `Ngoài thư mục được phép sửa của team (${scope}): ${relPosix}. Nếu thật sự cần, hãy báo lại trong phần "Điều còn dang dở" để Trưởng nhóm xử lý.`,
      };
    }
  }
  return { allowed: true };
}

// ---------- Lệnh Bash ----------
// Claude Code tự duyệt lệnh theo --allowedTools (Bash(<lệnh> *)). Hook này duyệt THÊM những gì allowedTools không tả được:
// xóa file trong thư mục làm việc, chạy node với file trong thư mục làm việc, và lệnh ghép (a && b) khi từng phần đều được phép.
// Hook chỉ nói "allow" khi chắc; không chắc thì im lặng để Claude Code quyết theo luật của nó. Chỉ chặn (exit 2) khi lệnh đụng
// ra ngoài thư mục làm việc hay vào .git: khi đó chặn kèm lý do giúp nhân viên khỏi thử lại tốn lượt.

const SPLIT_OPS = ['&&', '||', ';', '|', '\n'];
const NODE_DENIED_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-r', '--require', '--import', '--input-type', '-i', '--interactive', '--loader', '--experimental-loader']);
const REDIRECT = /^(\d*>>?|<|&>|\d*>&\d*)$/;
const REDIRECT_INLINE = /^(\d*>>?|<|&>)(.+)$/;
const QUOTES = new Set(["'", '"']);

/** Tách lệnh thành các phần theo &&, ||, ;, | và xuống dòng, giữ nguyên chuỗi trong ngoặc. null nếu có cú pháp hook không hiểu. */
export function splitCommand(command) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[i + 1];
        i += 1;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (QUOTES.has(ch)) {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 1;
      continue;
    }
    // Thay thế lệnh, nhóm lệnh, biến: hook không phân tích được thì không có ý kiến.
    if ('`(){}$'.includes(ch)) return null;
    const op = SPLIT_OPS.find((o) => command.startsWith(o, i));
    if (op) {
      parts.push(current);
      current = '';
      i += op.length - 1;
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  parts.push(current);
  const cleaned = parts.map((p) => p.trim());
  return cleaned.some((p) => p === '') ? null : cleaned;
}

/** Tách một phần lệnh thành các từ, bỏ dấu ngoặc. */
function words(segment) {
  const out = [];
  let current = '';
  let quote = null;
  let has = false;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (QUOTES.has(ch)) {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) out.push(current);
      current = '';
      has = false;
      continue;
    }
    current += ch;
    has = true;
  }
  if (has) out.push(current);
  return out;
}

const GLOB = /[*?[]/;

/**
 * Đường dẫn trong lệnh có nằm trong thư mục làm việc không (và có được SỬA ở đó không, nếu write).
 * Phần có ký tự glob (*, ?) thì xét thư mục đứng trước ký tự glob đầu tiên. Trả về { ok, reason }.
 */
function commandPath(raw, { root, allow, mode, links, write }) {
  if (raw.startsWith('~') || raw.startsWith('-')) return { ok: false, reason: `đường dẫn không rõ: ${raw}` };
  let probe = raw;
  if (GLOB.test(raw)) {
    const idx = raw.search(GLOB);
    const slash = raw.lastIndexOf('/', idx);
    probe = slash >= 0 ? raw.slice(0, slash) || '/' : '.';
    if (write && probe === '.') return { ok: false, reason: `không xóa bằng mẫu ở gốc thư mục làm việc: ${raw}` };
  }
  if (write) {
    const rel = path.relative(norm(realpathLoose(path.resolve(root))), norm(realpathLoose(path.resolve(root, probe))));
    if (rel === '') return { ok: false, reason: 'không được xóa cả thư mục làm việc.' };
  }
  const verdict = decide({ toolName: write ? 'Write' : 'Read', toolInput: { file_path: probe }, root, allow, mode, links });
  return verdict.allowed ? { ok: true } : { ok: false, reason: verdict.reason };
}

const NODE_FLAGS_WITH_VALUE = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--input-type']);

/** Một phần lệnh: 'allow', 'unknown' (không ý kiến) hoặc { deny: lý do }. */
function segmentVerdict(segment, ctx) {
  const normalized = segment.replace(/\s+/g, ' ');
  for (const cmd of ctx.commands) {
    const c = String(cmd).trim().replace(/\s+/g, ' ');
    if (c && (normalized === c || normalized.startsWith(`${c} `))) return 'allow';
  }
  const list = words(segment);
  if (list.length === 0) return 'unknown';
  // Chuyển hướng ra file: file đích phải ở nơi được ghi (thư mục nháp hoặc thư mục của team), không thì không ý kiến.
  const plain = [];
  for (let i = 0; i < list.length; i += 1) {
    const w = list[i];
    let target;
    if (REDIRECT.test(w)) {
      target = list[i + 1];
      i += 1;
    } else if (REDIRECT_INLINE.test(w)) {
      target = w.replace(REDIRECT_INLINE, '$2');
    } else {
      plain.push(w);
      continue;
    }
    if (w.startsWith('<') || /^\d*>&\d*$/.test(w)) continue;
    if (target === undefined) return 'unknown';
    if (target === '/dev/null' || target === 'NUL') continue;
    if (!commandPath(target, { ...ctx, write: true }).ok) return 'unknown';
  }
  const [name, ...rest] = plain;
  if (name === 'rm') {
    const paths = rest.filter((w) => !w.startsWith('-'));
    if (paths.length === 0) return 'unknown';
    for (const p of paths) {
      const r = commandPath(p, { ...ctx, write: true });
      if (!r.ok) return { deny: `Lệnh rm chỉ được xóa trong thư mục làm việc (thư mục của team hoặc ${SCRATCH_DIR}/). ${r.reason}` };
    }
    return 'allow';
  }
  if (name === 'node') {
    let i = 0;
    for (; i < rest.length && rest[i].startsWith('-'); i += 1) {
      const flag = rest[i].split('=')[0];
      if (NODE_DENIED_FLAGS.has(flag)) return 'unknown';
      if (NODE_FLAGS_WITH_VALUE.has(flag) && !rest[i].includes('=')) i += 1;
    }
    const file = rest[i];
    if (!file) return 'unknown';
    const r = commandPath(file, { ...ctx, write: false });
    if (!r.ok) return { deny: `Lệnh node chỉ chạy được file trong thư mục làm việc. ${r.reason}` };
    return 'allow';
  }
  return 'unknown';
}

/** Quyết định cho công cụ Bash: { allowed, decision: 'allow' | undefined, reason }. Xem chú thích ở trên. */
export function decideBash({ command, root, allow = [], mode = 'worker', links = [], commands = [] }) {
  if (typeof command !== 'string' || command.trim() === '' || mode === 'readonly') return { allowed: true };
  const parts = splitCommand(command);
  if (!parts) return { allowed: true };
  const ctx = { root, allow, mode, links, commands: Array.isArray(commands) ? commands : [] };
  let all = true;
  for (const part of parts) {
    const v = segmentVerdict(part, ctx);
    if (v !== 'allow' && v !== 'unknown') return { allowed: false, reason: `${v.deny} Đừng thử cách khác.` };
    if (v !== 'allow') all = false;
  }
  return all ? { allowed: true, decision: 'allow', reason: 'Mọi phần của lệnh đều nằm trong luật của công ty.' } : { allowed: true };
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let allow = [];
  let links = [];
  let commands = [];
  try {
    allow = JSON.parse(process.env.COMPANY_GUARD_ALLOW || '[]');
    links = JSON.parse(process.env.COMPANY_GUARD_LINKS || '[]');
    commands = JSON.parse(process.env.COMPANY_GUARD_COMMANDS || '[]');
  } catch {
    process.stderr.write('Cấu hình chặn file bị hỏng (COMPANY_GUARD_ALLOW / COMPANY_GUARD_LINKS / COMPANY_GUARD_COMMANDS).\n');
    process.exit(2);
  }
  try {
    const event = JSON.parse(input);
    const verdict = decide({
      toolName: event.tool_name,
      toolInput: event.tool_input,
      root: process.env.COMPANY_GUARD_ROOT || event.cwd || process.cwd(),
      allow,
      mode: process.env.COMPANY_GUARD_MODE || 'worker',
      links,
      commands,
    });
    if (!verdict.allowed) {
      process.stderr.write(`${verdict.reason}\n`);
      process.exit(2);
    }
    if (verdict.decision === 'allow') {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: verdict.reason } })}\n`);
    }
  } catch (err) {
    // Không đọc được sự kiện thì chặn cho chắc, tránh để lọt thao tác ngoài phạm vi.
    process.stderr.write(`Bộ chặn file gặp lỗi nên từ chối thao tác: ${err.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
