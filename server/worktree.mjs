import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { SCRATCH_DIR, folderRules, inFolders } from './path-guard.mjs';

const execFileAsync = promisify(execFile);

export async function git(cwd, args, { allowFail = false, raw = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return raw ? stdout : stdout.trim();
  } catch (err) {
    if (allowFail) return null;
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`git ${args[0]} thất bại: ${detail}`, { cause: err });
  }
}

/** Như `git` nhưng không ném lỗi: trả về mã thoát và đầu ra, cho những lệnh mà mã thoát khác 0 là kết quả bình thường. */
export async function gitResult(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? err.message ?? '') };
  }
}

export async function checkRepo(projectRoot) {
  if (!fs.existsSync(projectRoot)) throw new Error(`Không thấy thư mục dự án: ${projectRoot}`);
  const inside = await git(projectRoot, ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  if (inside !== 'true') throw new Error(`${projectRoot} không phải là git repo. Hãy chạy "git init" và tạo commit đầu tiên.`);
  const head = await git(projectRoot, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
  if (!head) throw new Error('Dự án chưa có commit nào. Hãy tạo commit đầu tiên để nhân viên có nhánh riêng để làm việc.');
  return head;
}

/** Tên an toàn cho nhánh/thư mục: bỏ dấu tiếng Việt ("Bình" thành "binh"), chỉ giữ chữ thường, số và gạch nối. */
export function safeName(value) {
  return (
    String(value)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  );
}

export async function branchExists(projectRoot, branch) {
  return (await git(projectRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })) !== null;
}

/**
 * Gỡ thư mục làm việc của một việc nhưng GIỮ nhánh (mọi commit vẫn còn để xem hoặc nhặt lại). Chỉ gỡ thư mục nằm trong
 * `worktreesDir`, và không bao giờ đụng thư mục dự án. Các thư mục nối từ dự án (node_modules...) được gỡ liên kết
 * TRƯỚC, từng cái một, để không bao giờ xóa nhầm nội dung thật của dự án qua liên kết.
 */
export async function removeWorktreeKeepBranch({ projectRoot, worktreesDir, dir }) {
  if (!dir) return false;
  const root = path.resolve(worktreesDir);
  const target = path.resolve(dir);
  if (target === root || !target.startsWith(root + path.sep)) return false;
  unlinkLinks(target);
  await git(projectRoot, ['worktree', 'remove', '--force', target], { allowFail: true });
  await git(projectRoot, ['worktree', 'prune'], { allowFail: true });
  return !fs.existsSync(target);
}

/** Gỡ mọi liên kết (symlink/junction) nằm ở gốc worktree và ở một cấp thư mục con, chỉ gỡ liên kết chứ không đụng đích. */
function unlinkLinks(dir) {
  const visit = (folder, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(folder, entry.name);
      let link = entry.isSymbolicLink();
      if (!link) {
        try {
          link = fs.lstatSync(full).isSymbolicLink();
        } catch {
          continue;
        }
      }
      if (link) {
        try {
          fs.unlinkSync(full);
        } catch {
          try {
            fs.rmdirSync(full);
          } catch {
            /* để git xử lý */
          }
        }
      } else if (entry.isDirectory() && depth < 1 && entry.name !== 'node_modules') {
        visit(full, depth + 1);
      }
    }
  };
  visit(dir, 0);
}

/** Mỗi việc một worktree và một nhánh riêng, đặt bên ngoài dự án (mục 3.7). */
/**
 * `startFrom` (không bắt buộc): nhánh/commit để thư mục làm việc bắt đầu từ đó (bài dở của lần trước) trong khi mã gốc của việc
 * (`baseCommit`, dùng để so diff và duyệt) vẫn giữ nguyên. Nhánh đó không còn thì bắt đầu từ mã gốc như thường.
 */
export async function createWorktree({ projectRoot, worktreesDir, member, taskId, links = [], copies = [], baseCommit: explicitBase, startFrom = null }) {
  const head = await checkRepo(projectRoot);
  const baseCommit = explicitBase ?? head;
  fs.mkdirSync(worktreesDir, { recursive: true });
  // "Làm lại" cần một nhánh mới trong khi nhánh cũ vẫn còn: thêm đuôi -2, -3... cho tới khi tên còn trống.
  let slug = `${safeName(member)}-task${taskId}`;
  for (let n = 2; await branchExists(projectRoot, `company/${slug}`) || fs.existsSync(path.join(worktreesDir, slug)); n += 1) {
    slug = `${safeName(member)}-task${taskId}-${n}`;
  }
  const branch = `company/${slug}`;
  const dir = path.join(worktreesDir, slug);
  const start = startFrom ? await gitResult(projectRoot, ['rev-parse', '--verify', '--quiet', `${startFrom}^{commit}`]) : null;
  const startCommit = start?.code === 0 ? start.stdout.trim() : null;
  await git(projectRoot, ['worktree', 'add', '-b', branch, dir, startCommit ?? baseCommit]);
  ensureScratchDir(dir);
  const linked = linkDirs({ projectRoot, worktree: dir, names: links });
  const copied = copyFiles({ projectRoot, worktree: dir, names: copies });
  return { dir, branch, baseCommit, linked, copied, startedFrom: startCommit ? startFrom : null };
}

/**
 * Thư mục nối (worktree_links) hiện có trong worktree và đích thật của chúng, để khai cho hook chặn file (chỉ đọc) và cho
 * Claude Code (--add-dir). Tính lại mỗi lần chạy, vì khi làm tiếp một việc thì worktree đã có sẵn.
 */
export function linkedDirs({ worktree, names }) {
  const out = [];
  for (const name of names ?? []) {
    const clean = String(name).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!clean || clean.split('/').includes('..')) continue;
    const full = path.join(worktree, clean);
    try {
      if (!fs.lstatSync(full).isSymbolicLink()) continue;
      out.push({ name: clean, real: fs.realpathSync.native(full) });
    } catch {
      /* chưa có hoặc không đọc được: bỏ qua */
    }
  }
  return out;
}

/**
 * Chép file/thư mục của dự án vào worktree (worktree_copies): dành cho file bị gitignore nhưng nhân viên cần đọc
 * (ví dụ AGENTS.md). Không chép file bí mật (.env*), .git, hay đường dẫn đi ra ngoài; không đè file đã có trong worktree.
 */
export function copyFiles({ projectRoot, worktree, names }) {
  const copied = [];
  for (const name of names ?? []) {
    const clean = String(name).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const parts = clean.split('/');
    if (!clean || parts.includes('..') || parts.includes('.git')) continue;
    if (parts.some((p) => /^\.env(\..+)?$/i.test(p))) continue;
    const src = path.join(projectRoot, clean);
    const dst = path.join(worktree, clean);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, dereference: true });
    copied.push(clean);
  }
  return copied;
}

export const GIT_IDENTITY = ['-c', 'user.name=Công ty AI', '-c', 'user.email=my-company@localhost', '-c', 'commit.gpgsign=false'];

/**
 * Gộp các nhánh đã được duyệt của một việc lớn vào một nhánh tích hợp `company/job<id>`, trong worktree
 * riêng. Gặp xung đột thì hủy lần gộp đó và báo file xung đột (không tự giải quyết thay con người).
 */
export async function integrateBranches({ projectRoot, worktreesDir, name: wanted, baseCommit, branches }) {
  fs.mkdirSync(worktreesDir, { recursive: true });
  // Việc lớn được mở lại thì gộp lại từ đầu: nhánh gộp cũ vẫn giữ, nhánh mới thêm đuôi -2, -3...
  let name = wanted;
  for (let n = 2; await branchExists(projectRoot, `company/${name}`) || fs.existsSync(path.join(worktreesDir, `${name}-merge`)); n += 1) {
    name = `${wanted}-${n}`;
  }
  const branch = `company/${name}`;
  const dir = path.join(worktreesDir, `${name}-merge`);
  await git(projectRoot, ['worktree', 'add', '-b', branch, dir, baseCommit]);
  const merged = [];
  for (const source of branches) {
    try {
      await git(dir, [...GIT_IDENTITY, 'merge', '--no-ff', '--no-edit', '-m', `company: gộp ${source} vào ${name}`, source]);
      merged.push(source);
    } catch (err) {
      const conflicts = (await git(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })) ?? '';
      await git(dir, ['merge', '--abort'], { allowFail: true });
      return {
        ok: false, branch, dir, merged, failedBranch: source,
        conflictFiles: conflicts.split('\n').map((s) => s.trim()).filter(Boolean),
        error: err.message,
      };
    }
  }
  const commit = await git(dir, ['rev-parse', 'HEAD']);
  return { ok: true, branch, dir, merged, commit, conflictFiles: [] };
}

/** Mã commit mà một nhánh/tham chiếu đang trỏ tới. */
export async function resolveRef(projectRoot, ref) {
  return git(projectRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

/** Diff giữa mã gốc và nhánh của một việc, cắt gọn để đưa cho Trưởng nhóm duyệt. */
export async function branchDiff({ projectRoot, baseCommit, branch, maxChars = 30_000 }) {
  const stat = (await git(projectRoot, ['diff', '--stat', `${baseCommit}..${branch}`], { allowFail: true })) ?? '';
  const full = (await git(projectRoot, ['diff', '--no-color', `${baseCommit}..${branch}`], { allowFail: true })) ?? '';
  const truncated = full.length > maxChars;
  return { stat, patch: truncated ? `${full.slice(0, maxChars)}\n... (đã cắt bớt, còn ${full.length - maxChars} ký tự)` : full, truncated };
}

/** Đọc kết quả `git status --porcelain=v1 -z`: mỗi mục là "XY đường-dẫn", đổi tên có thêm một mục đường-dẫn-cũ. */
export function parsePorcelainZ(output) {
  const tokens = output.split('\0');
  const files = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.length < 4) continue;
    files.push(token.slice(3));
    if (token[0] === 'R' || token[0] === 'C') i += 1;
  }
  return files;
}

/**
 * Nối các thư mục nặng của dự án (như node_modules) vào worktree để nhân viên chạy được test mà
 * không phải cài lại. Chỉ nối thư mục có thật ở gốc dự án và chưa có trong worktree.
 */
export function linkDirs({ projectRoot, worktree, names }) {
  const linked = [];
  for (const name of names ?? []) {
    const clean = String(name).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!clean || clean.includes('..')) continue;
    const src = path.join(projectRoot, clean);
    const dst = path.join(worktree, clean);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(src, dst, 'junction');
    linked.push(clean);
  }
  return linked;
}

const excludeSpecs = (names) => (names ?? []).map((n) => `:(exclude)${n}`);

/**
 * Thư mục nháp của nhân viên (xem path-guard.mjs): tạo sẵn kèm .gitignore tự loại trừ, nên git không bao giờ thấy nội dung
 * trong đó (commit, status, diff đều bỏ qua). Worktree cũ (làm tiếp) chưa có thì tạo thêm.
 */
export function ensureScratchDir(worktree) {
  const dir = path.join(worktree, SCRATCH_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  return dir;
}

/**
 * File nằm ngoài thư mục được sửa của team. Nhân viên không tự ghi được ra đó (hook chặn), nên thay đổi ở đó là do công cụ tự sinh:
 * `next dev` sửa tsconfig.json và next-env.d.ts (web96: việc của team Kiểm thử mang hai file này vào nhánh, rồi DevOps không khôi phục
 * được). `scope` = { allow, mode, written } giống path-guard; null = không lọc. `written`: file nhân viên tự ghi bằng công cụ,
 * không bao giờ bị bỏ (hook đã cho ghi thì là bài làm, không phải thứ tự sinh).
 */
export function outOfScope(files, scope) {
  if (!scope) return [];
  const { include, exclude } = folderRules(scope.allow);
  const scopedEmpty = scope.mode === 'scoped' && include.length === 0;
  if (!scopedEmpty && include.length === 0 && exclude.length === 0) return [];
  const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const written = new Set((scope.written ?? []).map(key));
  return files.filter((f) => !written.has(key(f)) && (scopedEmpty || !inFolders(f, scope.allow)));
}

/**
 * Commit mọi thay đổi trong worktree lên nhánh của việc (không push). Trả về danh sách file đổi. Thư mục nháp luôn bị loại.
 * Có `scope` thì file ngoài phạm vi của team không được commit (để nguyên trong thư mục làm việc) và trả về trong `skipped`.
 */
export async function commitWorktree({ dir, message, exclude = [], scope = null }) {
  exclude = [...new Set([SCRATCH_DIR, ...exclude])];
  const specs = exclude.length ? ['--', '.', ...excludeSpecs(exclude)] : [];
  const status = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...specs], { raw: true });
  const all = parsePorcelainZ(status);
  const skipped = outOfScope(all, scope);
  const changedFiles = all.filter((f) => !skipped.includes(f));
  if (changedFiles.length === 0) return { changedFiles: [], commit: null, skipped };
  // Mục đã nằm trong .gitignore thì không cần loại trừ nữa. Nếu vẫn truyền `:(exclude)` cho nó, `git add` gom file khác xong
  // vẫn thoát mã 1 ("paths are ignored by one of your .gitignore files"): commit bị bỏ, công việc nằm lại trong index mà không ai hay.
  const notIgnored = [];
  for (const name of exclude) {
    const checked = await gitResult(dir, ['check-ignore', '-q', '--', name]);
    if (checked.code !== 0) notIgnored.push(name);
  }
  // File bị bỏ vì ngoài phạm vi: loại theo đúng tên (literal: tên có ký tự glob không bị hiểu thành mẫu).
  const skipSpecs = skipped.map((f) => `:(exclude,literal)${f}`);
  const pathspecs = [...excludeSpecs(notIgnored), ...skipSpecs];
  await git(dir, ['add', '-A', ...(pathspecs.length ? ['--', '.', ...pathspecs] : [])]);
  await git(dir, [
    '-c', 'user.name=Công ty AI',
    '-c', 'user.email=my-company@localhost',
    '-c', 'commit.gpgsign=false',
    'commit', '--no-verify', '-m', message,
  ]);
  const commit = await git(dir, ['rev-parse', 'HEAD']);
  return { changedFiles, commit, skipped };
}
