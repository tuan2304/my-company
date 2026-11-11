#!/usr/bin/env node
/**
 * Hook PreToolUse của Antigravity (`agy`): chặn CỨNG việc đọc/ghi file ngoài phạm vi, giống path-guard.mjs của Claude.
 *
 * Khác Claude ở ba điểm (đã thử thật trên agy):
 * - Cấu hình nằm trong file `config.json` cạnh script này ({ root, allow, mode }), không đọc biến môi trường,
 *   vì không chắc agy truyền môi trường cho hook.
 * - Tên công cụ và tên tham số của agy khác Claude (read_file { Path }, write_to_file { TargetFile }, run_command { CommandLine, Cwd }...).
 *   Danh sách đầy đủ không có tài liệu, nên guard không tin vào danh sách cố định: MỌI tham số trông như đường dẫn đều bị kiểm tra
 *   (trừ các tham số chứa nội dung), và công cụ có tên kiểu "ghi" thì còn phải qua luật thư mục được sửa.
 * - Công cụ không liên quan tới file nhưng ra ngoài máy hoặc sinh tiến trình khác (trình duyệt, subagent, MCP, tìm web...) bị chặn hẳn.
 * Giao thức: JSON từ stdin (toolCall.name, toolCall.args...), thoát mã 2 và in lý do ra stderr để chặn.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decide } from './path-guard.mjs';

const DENIED_TOOLS = /^(browser|open_browser|execute_browser|capture_browser|click_browser|list_browser|read_browser|invoke_subagent|define_subagent|manage_|schedule|call_mcp_tool|send_message|search_web|read_url_content|generate_image|run_workflow|delete_knowledge|notebook_execution|search_marketplace|list_plugin|read_resource|list_resources)/i;
const WRITE_TOOLS = /(write|replace|edit|sed|patch|create|delete|remove|move|rename|append|insert|mkdir)/i;
const PATH_KEY = /(path|file|dir|folder|uri|target|source|dest|cwd)/i;
// Tham số chứa nội dung (không phải đường dẫn): "TargetContent" có chữ "target" nhưng là đoạn văn bản cần thay.
const CONTENT_KEY = /(content|text|code|query|pattern|description|instruction|explanation|summary|diff|regex|glob|command)/i;

const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

function toFsPath(value) {
  const text = String(value);
  return text.startsWith('file://') ? decodeURIComponent(text.replace(/^file:\/\/\/?/, process.platform === 'win32' ? '' : '/')) : text;
}

/** Mọi giá trị chuỗi nằm ở tham số trông như đường dẫn (kể cả trong mảng). */
export function collectPaths(args) {
  const found = [];
  for (const [key, value] of Object.entries(args ?? {})) {
    if (!PATH_KEY.test(key) || CONTENT_KEY.test(key)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && item !== '') found.push(toFsPath(item));
    }
  }
  return found;
}

/** Trả về { allowed, reason }. `config` = { root, allow, mode }. */
export function decideAgy({ toolName, args, config }) {
  const name = String(toolName ?? '');
  if (!name) return { allowed: false, reason: 'Sự kiện công cụ thiếu tên.' };
  if (DENIED_TOOLS.test(name)) return { allowed: false, reason: `Công cụ ${name} không được dùng trong công ty (ra ngoài máy hoặc tạo tiến trình khác).` };

  const readonly = config.mode === 'readonly';
  const isWrite = WRITE_TOOLS.test(name);
  if (readonly && /^run_command$/.test(name)) return { allowed: false, reason: 'Vai trò này chỉ được đọc, không được chạy lệnh.' };

  const root = path.resolve(config.root);
  for (const target of collectPaths(args)) {
    if (isWrite) {
      // Không cho tự sửa cấu hình chặn hay lời nhắc hệ thống mà công ty đặt trong thư mục làm việc (kiểm trước để thông báo rõ nghĩa).
      const rel = path.relative(norm(root), norm(path.resolve(root, target))).split(path.sep).join('/');
      if (rel.toLowerCase() === 'agents.md' || rel === '.agents' || rel.startsWith('.agents/')) {
        return { allowed: false, reason: 'Không được sửa .agents hay AGENTS.md: đây là cấu hình của công ty.' };
      }
    }
    const verdict = decide({
      toolName: isWrite ? 'Write' : 'Read',
      toolInput: { file_path: target },
      root,
      allow: config.allow ?? [],
      mode: config.mode ?? 'worker',
    });
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true };
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const config = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8'));
    const event = JSON.parse(input);
    const verdict = decideAgy({ toolName: event.toolCall?.name, args: event.toolCall?.args, config });
    if (!verdict.allowed) {
      process.stderr.write(`${verdict.reason}\n`);
      process.exit(2);
    }
  } catch (err) {
    // Không đọc được cấu hình hay sự kiện thì chặn cho chắc.
    process.stderr.write(`Bộ chặn file gặp lỗi nên từ chối thao tác: ${err.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
