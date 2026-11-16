import fs from 'node:fs';
import path from 'node:path';
import { folderRules } from './path-guard.mjs';

/**
 * Bản đồ file cho đề bài: liệt kê sẵn các file trong phạm vi của một việc (hoặc thư mục của team) để nhân viên và
 * Trưởng nhóm đọc đúng file cần, thay vì tốn hàng chục lượt ls/Glob/Read dò đường (một nhân viên web96 mất 28 lượt chỉ để đọc code).
 * Chỉ liệt kê, không đọc nội dung. Bỏ qua thư mục sinh ra hay nặng (node_modules, .git, .next...). Có trần số mục và độ sâu.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'dist', 'build', 'out', 'coverage', '.company-tmp', '__pycache__', '.venv', 'venv', 'target', 'vendor']);

const clean = (p) => String(p).trim().replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');

/**
 * @param {object} o
 * @param {string} o.root thư mục gốc (worktree hoặc thư mục dự án)
 * @param {string[]} o.scopes file/thư mục cần liệt kê, tính từ gốc; mục "!x" là loại trừ; rỗng = cả gốc
 * @returns {{ entries: string[], truncated: boolean, missing: string[] }} đường dẫn tương đối dạng a/b/c, đã sắp xếp
 */
export function fileMap({ root, scopes = [], maxEntries = 150, maxDepth = 5 }) {
  const { include, exclude } = folderRules(scopes);
  const excluded = (rel) => exclude.some((e) => rel === e || rel.startsWith(`${e}/`));
  const entries = [];
  const missing = [];
  let truncated = false;

  const walk = (rel, depth) => {
    if (truncated) return;
    const full = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return;
    }
    if (stat.isFile()) {
      if (!excluded(rel)) entries.push(rel);
      if (entries.length >= maxEntries) truncated = true;
      return;
    }
    if (!stat.isDirectory() || depth > maxDepth) return;
    let children;
    try {
      children = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const child of children) {
      if (truncated) return;
      if (child.isSymbolicLink()) continue; // thư mục nối từ dự án (node_modules...) không liệt kê
      const childRel = rel ? `${rel}/${child.name}` : child.name;
      if (child.isDirectory()) {
        if (SKIP_DIRS.has(child.name) || excluded(childRel)) continue;
        if (depth + 1 > maxDepth) {
          entries.push(`${childRel}/ (…)`);
          if (entries.length >= maxEntries) truncated = true;
          continue;
        }
        walk(childRel, depth + 1);
      } else if (child.isFile()) {
        if (excluded(childRel)) continue;
        entries.push(childRel);
        if (entries.length >= maxEntries) truncated = true;
      }
    }
  };

  const roots = include.length ? include : [''];
  for (const scope of roots) {
    const rel = clean(scope);
    if (rel.split('/').includes('..')) continue;
    if (rel && !fs.existsSync(path.join(root, rel))) {
      missing.push(rel);
      continue;
    }
    walk(rel, 0);
  }
  return { entries: [...new Set(entries)], truncated, missing };
}

/** Đoạn văn bản cho đề bài. Trả về '' khi không có gì để kể. */
export function renderFileMap({ root, scopes = [], maxEntries, title = 'Bản đồ file trong phạm vi của bạn' }) {
  let map;
  try {
    map = fileMap({ root, scopes, maxEntries });
  } catch {
    return '';
  }
  if (map.entries.length === 0 && map.missing.length === 0) return '';
  const lines = [`## ${title}`, 'Danh sách dưới đây là file có sẵn trong phạm vi (chỉ liệt kê tên, chưa đọc). Hãy mở đúng file cần, đừng ls/Glob/Read dò đường cả thư mục: mỗi lần đọc là một lượt.'];
  for (const e of map.entries) lines.push(`- ${e}`);
  if (map.truncated) lines.push(`- … (còn nữa, chỉ liệt kê ${map.entries.length} mục đầu)`);
  for (const m of map.missing) lines.push(`- ${m}: chưa có (file/thư mục mới, bạn sẽ tạo)`);
  return lines.join('\n');
}
