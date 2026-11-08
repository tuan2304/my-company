#!/usr/bin/env node
/**
 * Team Báo cáo push: sau mỗi lần push lên GitHub, ghi một file Markdown mô tả những gì vừa push.
 *
 *   npm run push                  push rồi báo cáo (nhận mọi tham số của `git push`)
 *   npm run push -- --no-ai       không nhờ Claude viết tóm tắt (chỉ ghi dữ kiện từ git)
 *   node scripts/push-report.mjs --range <từ>..<đến>   chỉ viết báo cáo cho một khoảng commit
 *
 * Quy ước đầu ra:
 *   reports/<YYYY-MM>/<nội-dung-đã-làm>.md      mỗi lần push một file, tên file là việc đã làm
 *
 * Làm việc theo Team Báo cáo (teams/report): người thu thập (hàm collect, đọc git), người viết (Mai, vai reporter,
 * Claude gói Pro, tùy chọn) và người kiểm (hàm validate, chắc chắn tên file và thư mục đúng quy ước).
 * Không có `git push` nào chạy ở đây ngoài lệnh của chính người dùng; báo cáo được commit rồi push thêm
 * một lần. Lần push thứ hai chỉ chứa thư mục reports/ nên bị bỏ qua, không lặp vô hạn.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontmatterFile } from '../server/frontmatter.mjs';
import { sanitizedEnv } from '../server/guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPORT_DIR = 'reports';
const MAX_NAME = 70;
const AI_INPUT_MAX = 14000;
const AI_TIMEOUT_MS = 180_000;

function git(args, { cwd = ROOT, allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} lỗi: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.status === 0 ? r.stdout.trim() : '';
}

/** Chuyển một câu thành tên file: bỏ dấu tiếng Việt, chữ thường, nối bằng gạch ngang, cắt ở ranh giới từ. */
export function slugify(text, max = MAX_NAME) {
  const base = String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length <= max) return base || 'cap-nhat';
  const cut = base.slice(0, max);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > max * 0.5 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '') || 'cap-nhat';
}

/** Người thu thập: đọc git để biết các commit và thay đổi trong khoảng commit. `commits` là danh sách sha, cũ tới mới. */
export function collect(commits, { cwd = ROOT } = {}) {
  const list = commits.map((sha) => {
    const [hash, author, date, subject, ...rest] = git(['show', '-s', '--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b', sha], { cwd }).split('\x1f');
    return { hash, short: hash.slice(0, 7), author, date, subject, body: rest.join('\x1f').trim() };
  });
  const files = new Map();
  for (const sha of commits) {
    const out = git(['show', '--numstat', '--format=', '--no-renames', sha], { cwd });
    for (const line of out.split('\n').filter(Boolean)) {
      const [add, del, ...nameParts] = line.split('\t');
      const name = nameParts.join('\t');
      const entry = files.get(name) ?? { name, add: 0, del: 0, binary: false };
      if (add === '-') entry.binary = true;
      else {
        entry.add += Number(add);
        entry.del += Number(del);
      }
      files.set(name, entry);
    }
  }
  return { commits: list, files: [...files.values()] };
}

/** Việc chỉ động vào thư mục reports/ thì không cần báo cáo (tránh báo cáo về báo cáo). */
export function onlyReports(files) {
  return files.length > 0 && files.every((f) => f.name.startsWith(`${REPORT_DIR}/`));
}

function groupByFolder(files) {
  const groups = new Map();
  for (const f of files) {
    const top = f.name.includes('/') ? f.name.split('/')[0] : '(thư mục gốc)';
    const g = groups.get(top) ?? { folder: top, files: 0, add: 0, del: 0 };
    g.files += 1;
    g.add += f.add;
    g.del += f.del;
    groups.set(top, g);
  }
  return [...groups.values()].sort((a, b) => b.add + b.del - (a.add + a.del));
}

function factsText(data, branch) {
  const lines = [`Nhánh: ${branch}`, `Số commit: ${data.commits.length}`, '', 'Commit (cũ tới mới):'];
  for (const c of data.commits) {
    lines.push(`- ${c.short} ${c.subject}`);
    if (c.body) lines.push(...c.body.split('\n').map((l) => `    ${l}`));
  }
  lines.push('', 'Thay đổi theo thư mục:');
  for (const g of groupByFolder(data.files)) lines.push(`- ${g.folder}: ${g.files} file, +${g.add} -${g.del}`);
  lines.push('', 'File thay đổi nhiều nhất:');
  for (const f of [...data.files].sort((a, b) => b.add + b.del - (a.add + a.del)).slice(0, 25)) {
    lines.push(`- ${f.name} ${f.binary ? '(nhị phân)' : `+${f.add} -${f.del}`}`);
  }
  return lines.join('\n').slice(0, AI_INPUT_MAX);
}

/**
 * Người viết: Mai của Team Báo cáo (teams/report/reporter.md) viết tiêu đề và tóm tắt bằng Claude gói Pro, không API.
 * Chỉ dẫn và model lấy từ chính vai trò đó để một nơi quyết định. Lỗi thì trả null để dùng bản dữ kiện.
 */
export function writeSummary(data, branch, { cwd = ROOT, run = spawnSync } = {}) {
  const roleFile = path.join(ROOT, 'teams', 'report', 'reporter.md');
  if (!fs.existsSync(roleFile)) return null;
  const { data: meta, body } = readFrontmatterFile(roleFile);
  const model = String(meta.model ?? 'haiku');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-report-'));
  try {
    const promptFile = path.join(tmp, 'system.md');
    fs.writeFileSync(promptFile, body, 'utf8');
    const input = `Chế độ tóm tắt: dữ liệu đã được đưa sẵn bên dưới, không dùng công cụ, không ghi tệp. Chỉ trả về TITLE và ba mục theo đúng định dạng.\n\n${factsText(data, branch)}`;
    const r = run(
      'claude',
      ['-p', '--model', model, '--no-session-persistence', '--max-turns', '2', '--append-system-prompt-file', promptFile],
      { cwd, input, encoding: 'utf8', env: sanitizedEnv(), timeout: AI_TIMEOUT_MS },
    );
    if (r.status !== 0 || !r.stdout) return null;
    const match = r.stdout.trim().match(/^TITLE:\s*(.+)\n+([\s\S]+)$/);
    if (!match) return null;
    return { title: match[1].trim(), body: match[2].trim() };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Nội dung file báo cáo. */
export function renderReport({ data, branch, title, summary, pushedAt, remoteUrl }) {
  const out = [`# ${title}`, ''];
  out.push(`- Ngày push: ${pushedAt}`, `- Nhánh: \`${branch}\``);
  if (remoteUrl) out.push(`- Kho: ${remoteUrl}`);
  out.push(`- Số commit: ${data.commits.length}`, `- Số file thay đổi: ${data.files.length}`, '');
  if (summary) out.push(summary, '');
  else out.push('## Tóm tắt', '', '_Tóm tắt tự động không có (không gọi được Claude), phần dưới là dữ kiện lấy trực tiếp từ git._', '');
  out.push('## Các commit', '');
  for (const c of data.commits) out.push(`- \`${c.short}\` ${c.subject} (${c.author}, ${c.date.slice(0, 10)})`);
  out.push('', '## Thay đổi theo thư mục', '', '| Thư mục | File | Dòng thêm | Dòng xóa |', '|---|---:|---:|---:|');
  for (const g of groupByFolder(data.files)) out.push(`| ${g.folder} | ${g.files} | ${g.add} | ${g.del} |`);
  out.push('', '## File thay đổi', '');
  for (const f of [...data.files].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(`- \`${f.name}\` ${f.binary ? '(nhị phân)' : `+${f.add} -${f.del}`}`);
  }
  return `${out.join('\n')}\n`;
}

/** Người kiểm: đường dẫn phải là reports/<YYYY-MM>/<tên>.md, tên chỉ gồm chữ thường, số, gạch ngang. */
export function validate(relPath) {
  return /^reports\/\d{4}-\d{2}\/[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(relPath.replace(/\\/g, '/'));
}

/** Chọn đường dẫn file chưa tồn tại: thêm -2, -3 nếu trùng tên. */
export function pickPath(title, date, { root = ROOT } = {}) {
  const month = date.toISOString().slice(0, 7);
  const slug = slugify(title);
  for (let n = 1; n < 1000; n += 1) {
    const rel = `${REPORT_DIR}/${month}/${n === 1 ? slug : `${slug}-${n}`}.md`;
    if (!fs.existsSync(path.join(root, rel))) return rel;
  }
  throw new Error('Quá nhiều báo cáo trùng tên.');
}

/** Viết báo cáo cho danh sách commit. Trả về đường dẫn tương đối, hoặc null nếu bỏ qua. */
export function writeReport(commits, { branch, ai = true, now = new Date(), root = ROOT } = {}) {
  const data = collect(commits, { cwd: root });
  if (data.commits.length === 0 || onlyReports(data.files)) return null;
  const summary = ai ? writeSummary(data, branch, { cwd: root }) : null;
  const fallback = data.commits.at(-1).subject;
  const title = summary?.title || fallback;
  const rel = pickPath(title, now, { root });
  if (!validate(rel)) throw new Error(`Tên báo cáo không hợp lệ: ${rel}`);
  const remoteUrl = git(['remote', 'get-url', 'origin'], { cwd: root, allowFail: true }).replace(/\.git$/, '');
  const text = renderReport({ data, branch, title, summary: summary?.body, pushedAt: now.toISOString().slice(0, 10), remoteUrl: remoteUrl || null });
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text, 'utf8');
  return rel;
}

/** Các commit sắp được push: chưa có trên upstream (hoặc chưa có trên remote nào nếu nhánh mới). Cũ tới mới. */
export function pendingCommits() {
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFail: true });
  const out = upstream
    ? git(['rev-list', '--reverse', 'HEAD', `^${upstream}`])
    : git(['rev-list', '--reverse', 'HEAD', '--not', '--remotes']);
  return out.split('\n').filter(Boolean);
}

function pushAndReport(args) {
  const ai = !args.includes('--no-ai');
  const gitArgs = args.filter((a) => a !== '--no-ai');
  const commits = pendingCommits();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const push = spawnSync('git', ['push', ...gitArgs], { cwd: ROOT, stdio: 'inherit' });
  if (push.status !== 0) process.exit(push.status ?? 1);
  if (commits.length === 0) return console.log('Không có commit mới để báo cáo.');
  const rel = writeReport(commits, { branch, ai });
  if (!rel) return console.log('Bỏ qua báo cáo: lần push này chỉ chứa thư mục reports/.');
  git(['add', '--', rel]);
  git(['commit', '-m', `Report: ${path.basename(rel, '.md')}`, '--', rel]);
  console.log(`Đã ghi báo cáo ${rel}, đang push thêm...`);
  const second = spawnSync('git', ['push', ...gitArgs], { cwd: ROOT, stdio: 'inherit' });
  if (second.status !== 0) process.exit(second.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rangeAt = args.indexOf('--range');
  if (rangeAt >= 0) {
    const commits = git(['rev-list', '--reverse', args[rangeAt + 1]]).split('\n').filter(Boolean);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const rel = writeReport(commits, { branch, ai: !args.includes('--no-ai') });
    console.log(rel ? `Đã ghi ${rel}` : 'Không có gì để báo cáo.');
  } else {
    pushAndReport(args);
  }
}
