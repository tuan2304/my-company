import fs from 'node:fs';
import path from 'node:path';
import { git, gitResult, GIT_IDENTITY, parsePorcelainZ } from './worktree.mjs';

/**
 * "Đưa vào dự án": gộp nhánh `company/...` của một việc đã xong vào nhánh người dùng đang làm việc ở thư mục dự án.
 * Chỉ chạy khi người dùng bấm. Không push, không tự sửa gì trong thư mục dự án nếu nó đang có thay đổi chưa commit,
 * và gặp xung đột thì hủy hẳn lần gộp (thư mục dự án về đúng như trước khi bấm).
 */

// Tên nhánh do chính công cụ đặt (an toàn), nhưng vẫn kiểm lại trước khi đưa vào lệnh git.
const BRANCH_RE = /^company\/[a-z0-9][a-z0-9._-]*$/;
const KINDS = new Set(['task', 'job', 'epic']);
// Yêu cầu còn đang chạy (chưa kết thúc) thì việc lớn trong nó chưa được đưa riêng: kết quả còn đổi và sẽ được ghép chung.
const EPIC_OPEN = new Set(['planning', 'awaiting_plan', 'running', 'integrating', 'reviewing', 'awaiting_result']);

/** Việc nào được phép đưa vào dự án, và nhánh của nó. */
export function subjectOf(store, kind, id) {
  if (!KINDS.has(kind)) return { error: 'Loại không hợp lệ.' };
  if (kind === 'task') {
    const task = store.getTask(id);
    if (!task) return { error: 'Không có việc này.' };
    if (task.kind !== 'work' || task.job_id || task.epic_id) {
      return { error: 'Việc con của một việc lớn được đưa vào dự án cùng việc lớn đó, không đưa riêng từng việc.' };
    }
    if (task.status !== 'done') return { error: 'Chỉ đưa được việc đã xong.' };
    return { title: task.title, branch: task.branch };
  }
  if (kind === 'job') {
    const job = store.getJob(id);
    if (!job) return { error: 'Không có việc lớn này.' };
    if (job.epic_id) {
      // Yêu cầu đã kết thúc (kể cả lỗi, cần xem, bị dừng) mà việc lớn này có nhánh gộp: cho đưa riêng, khỏi phải cứu tay bằng git.
      const epic = store.getEpic(job.epic_id);
      if (epic && EPIC_OPEN.has(epic.status)) {
        return { error: `Việc lớn thuộc yêu cầu #${epic.id} đang chạy (${epic.status}): đợi yêu cầu kết thúc rồi đưa cả yêu cầu, hoặc đưa riêng việc này khi yêu cầu đã đóng.` };
      }
    }
    if (!['done', 'attention'].includes(job.status) || !job.merge_branch) {
      return { error: job.status === 'attention' ? 'Việc lớn này chưa có nhánh gộp (chưa có việc con nào được duyệt).' : 'Chỉ đưa được việc lớn đã xong (hoặc "cần xem" nhưng đã có nhánh gộp).' };
    }
    return { title: job.title, branch: job.merge_branch };
  }
  const epic = store.getEpic(id);
  if (!epic) return { error: 'Không có yêu cầu này.' };
  if (epic.status !== 'done') return { error: 'Chỉ đưa được yêu cầu đã xong (bạn đã duyệt kết quả).' };
  return { title: epic.title, branch: epic.merge_branch };
}

async function gitPathExists(projectRoot, name) {
  const p = await git(projectRoot, ['rev-parse', '--git-path', name], { allowFail: true });
  return Boolean(p) && fs.existsSync(path.resolve(projectRoot, p));
}

/** Cột "Tên file" của `git merge-tree --write-tree --name-only`: dòng đầu là mã cây, sau đó là các file xung đột đến dòng trống. */
export function parseMergeTreeConflicts(stdout) {
  const lines = stdout.split('\n').map((l) => l.replace(/\r$/, ''));
  const files = [];
  for (const line of lines.slice(1)) {
    if (line === '') break;
    files.push(line);
  }
  return files;
}

/** Xem trước: có đưa được không, sẽ đưa những file nào, và nếu không thì vì sao. Không thay đổi gì. */
export async function inspect({ store, projectRoot, kind, id }) {
  const subject = subjectOf(store, kind, id);
  const last = KINDS.has(kind) && !subject.error ? store.lastIntegration(kind, id) : null;
  const base = { kind, id, title: subject.title ?? null, branch: subject.branch ?? null, target: null, files: [], stat: '', conflictFiles: [], dirtyFiles: [], integration: last };
  if (subject.error) return { ...base, state: 'not_ready', reason: subject.error };
  const { branch } = subject;
  if (!branch || !BRANCH_RE.test(branch)) return { ...base, state: 'missing', reason: 'Việc này chưa có nhánh để đưa vào dự án (có thể chưa thay đổi file nào).' };
  const exists = await git(projectRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });
  if (!exists) return { ...base, state: 'missing', reason: `Nhánh ${branch} không còn trong dự án (đã bị xóa?).` };

  const target = await git(projectRoot, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true });
  if (!target) return { ...base, state: 'blocked', reason: 'Thư mục dự án đang ở trạng thái "detached HEAD" (không ở trên nhánh nào). Hãy chuyển sang một nhánh rồi thử lại.' };
  const withTarget = { ...base, target };

  const ancestor = await gitResult(projectRoot, ['merge-base', '--is-ancestor', branch, 'HEAD']);
  if (ancestor.code === 0) {
    return { ...withTarget, state: 'integrated', reason: `Nhánh ${target} đã có mọi thay đổi của nhánh này.` };
  }

  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (await gitPathExists(projectRoot, name)) {
      return { ...withTarget, state: 'blocked', reason: 'Thư mục dự án đang dở một thao tác git (gộp, rebase, cherry-pick hoặc revert). Hãy hoàn tất hoặc hủy nó trước.' };
    }
  }
  const status = (await git(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=no'], { raw: true })) ?? '';
  const dirtyFiles = parsePorcelainZ(status);
  const range = `HEAD...${branch}`;
  const files = ((await git(projectRoot, ['diff', '--name-only', range], { allowFail: true })) ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const stat = (await git(projectRoot, ['diff', '--stat', range], { allowFail: true })) ?? '';
  const filled = { ...withTarget, files, stat, dirtyFiles };
  if (dirtyFiles.length > 0) {
    return {
      ...filled,
      state: 'blocked',
      reason: `Thư mục dự án đang có ${dirtyFiles.length} file thay đổi chưa commit. Hãy commit hoặc stash chúng trước để việc gộp không lẫn vào code đang viết dở.`,
    };
  }

  // Chạy thử việc gộp trong bộ nhớ git (không đụng thư mục làm việc) để biết trước có xung đột không.
  const dry = await gitResult(projectRoot, ['merge-tree', '--write-tree', '--name-only', 'HEAD', branch]);
  if (dry.code === 1) {
    const conflictFiles = parseMergeTreeConflicts(dry.stdout);
    return { ...filled, state: 'conflict', conflictFiles, reason: `Gộp vào ${target} sẽ xung đột ở ${conflictFiles.length || 'một số'} file. Hãy gộp bằng git rồi giải quyết xung đột bằng tay, hoặc nhờ nhân viên làm lại trên bản mới.` };
  }
  if (dry.code !== 0) {
    return { ...filled, state: 'blocked', reason: `Không kiểm tra thử được việc gộp: ${dry.stderr.trim() || 'git merge-tree lỗi'}` };
  }
  return { ...filled, state: 'ready', reason: null };
}

// Mọi lần gộp chạy lần lượt trong một tiến trình: hai lần bấm gần nhau không được đụng nhau ở thư mục dự án.
let chain = Promise.resolve();

/** Thực hiện việc gộp. Trả về { ok: true, ... } hoặc { ok: false, error, state }. */
export function integrate({ store, projectRoot, kind, id, now = Date.now() }) {
  const run = async () => {
    // Kiểm tra lại ngay trước khi gộp: từ lúc xem trước đến lúc bấm, thư mục dự án có thể đã đổi.
    const info = await inspect({ store, projectRoot, kind, id });
    if (info.state !== 'ready') return { ok: false, error: info.reason ?? 'Chưa đưa vào dự án được.', state: info.state, info };
    const message = `company: đưa ${info.branch} vào dự án (${kind} #${id}: ${info.title})`;
    const result = await gitResult(projectRoot, [...GIT_IDENTITY, 'merge', '--no-ff', '--no-verify', '-m', message, info.branch]);
    if (result.code !== 0) {
      // Hủy để thư mục dự án về nguyên trạng. Nếu git từ chối ngay từ đầu (không có gì để hủy) thì lệnh này báo lỗi vô hại.
      await gitResult(projectRoot, ['merge', '--abort']);
      const detail = (result.stderr || result.stdout).trim();
      return { ok: false, error: `Việc gộp thất bại, thư mục dự án giữ nguyên như trước: ${detail}`, state: 'failed', info };
    }
    const commit = await git(projectRoot, ['rev-parse', 'HEAD']);
    store.addIntegration({ kind, refId: id, branch: info.branch, target: info.target, commitId: commit, now });
    return { ok: true, branch: info.branch, target: info.target, commit, files: info.files };
  };
  const next = chain.then(run, run);
  chain = next.then(() => undefined, () => undefined);
  return next;
}
