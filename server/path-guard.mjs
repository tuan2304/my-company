#!/usr/bin/env node
/**
 * Hook PreToolUse của Claude Code: chặn CỨNG việc đọc/ghi file ngoài phạm vi, không dựa vào việc AI tự giữ lời.
 * Cấu hình qua biến môi trường do runner đặt:
 *   COMPANY_GUARD_ROOT   thư mục làm việc (worktree); mọi file phải nằm trong đây
 *   COMPANY_GUARD_ALLOW  JSON mảng thư mục được phép SỬA, tính từ gốc worktree. Mục bắt đầu bằng "!" là loại trừ
 *                        (ví dụ ["src/app", "!src/app/api"]). Rỗng = sửa được mọi nơi trong gốc (trừ chế độ "scoped").
 *   COMPANY_GUARD_MODE   "worker" (sửa được trong phạm vi), "scoped" (như worker nhưng danh sách rỗng = KHÔNG sửa được gì,
 *                        dùng cho team chỉ ghi tài liệu) hoặc "readonly" (không sửa gì, dùng cho Trưởng nhóm)
 * Giao thức: đọc JSON từ stdin, thoát với mã 2 và in lý do ra stderr để chặn công cụ.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const ENV_SAFE = /^\.env\.(example|sample|template|dist)$/i;

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

export function decide({ toolName, toolInput, root, allow = [], mode = 'worker' }) {
  const raw = toolInput?.file_path ?? toolInput?.notebook_path ?? toolInput?.path;
  if (typeof raw !== 'string' || raw === '') return { allowed: true };

  const rootReal = realpathLoose(path.resolve(root));
  const target = realpathLoose(path.resolve(root, raw));
  const rel = path.relative(norm(rootReal), norm(target));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { allowed: false, reason: `Không được truy cập file ngoài thư mục làm việc: ${raw}` };
  }
  const relPosix = path.relative(rootReal, target).split(path.sep).join('/');
  const segments = relPosix.split('/');
  const base = segments.at(-1) ?? '';

  if (/^\.env(\..+)?$/i.test(base) && !ENV_SAFE.test(base)) {
    return { allowed: false, reason: `Không được đọc hay sửa file bí mật ${base}.` };
  }
  if (segments.includes('.git')) {
    return { allowed: false, reason: 'Không được đụng vào thư mục .git.' };
  }

  if (WRITE_TOOLS.has(toolName)) {
    if (mode === 'readonly') return { allowed: false, reason: 'Vai trò này chỉ được đọc, không được sửa file.' };
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

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let allow = [];
  try {
    allow = JSON.parse(process.env.COMPANY_GUARD_ALLOW || '[]');
  } catch {
    process.stderr.write('Cấu hình chặn file bị hỏng (COMPANY_GUARD_ALLOW).\n');
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
    });
    if (!verdict.allowed) {
      process.stderr.write(`${verdict.reason}\n`);
      process.exit(2);
    }
  } catch (err) {
    // Không đọc được sự kiện thì chặn cho chắc, tránh để lọt thao tác ngoài phạm vi.
    process.stderr.write(`Bộ chặn file gặp lỗi nên từ chối thao tác: ${err.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
