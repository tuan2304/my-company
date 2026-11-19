import fs from 'node:fs';
import path from 'node:path';
import { git, gitResult, GIT_IDENTITY, parsePorcelainZ } from './worktree.mjs';

/**
 * "Đưa vào dự án": gộp nhánh `company/...` của một việc đã xong vào nhánh người dùng đang làm việc ở thư mục dự án.
 * Chỉ chạy khi người dùng bấm. Nút này không push (push là nút riêng "Push lên main", xem pushToMain), không tự sửa gì trong thư mục dự án nếu nó đang có thay đổi chưa commit,
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

function serialized(run) {
  const next = chain.then(run, run);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

// ---- "Push lên main": gộp nhánh vào main (không đổi nhánh người dùng đang mở) rồi `git push origin main` ----

export const PUSH_REMOTE = 'origin';
const MAIN_CANDIDATES = ['main', 'master'];
const NETWORK_TIMEOUT_MS = 120_000;
// Không để git treo chờ gõ mật khẩu trong cửa sổ dòng lệnh không ai thấy (Git Credential Manager đã đăng nhập vẫn dùng được).
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0' };

async function refSha(projectRoot, ref) {
  return git(projectRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
}

async function isAncestor(projectRoot, a, b) {
  return (await gitResult(projectRoot, ['merge-base', '--is-ancestor', a, b])).code === 0;
}

/** Nhánh đích để push: `main`, không có thì `master`. */
async function mainBranchOf(projectRoot) {
  for (const name of MAIN_CANDIDATES) if (await refSha(projectRoot, `refs/heads/${name}`)) return name;
  return null;
}

/** Thư mục (worktree) đang mở nhánh `branch`, trừ thư mục dự án. Cập nhật nhánh đó từ ngoài sẽ làm worktree kia lệch. */
async function otherCheckout(projectRoot, branch) {
  const out = (await git(projectRoot, ['worktree', 'list', '--porcelain'], { allowFail: true })) ?? '';
  const self = path.resolve(projectRoot).toLowerCase();
  let current = null;
  for (const line of out.split('\n').map((l) => l.replace(/\r$/, ''))) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}` && current && path.resolve(current).toLowerCase() !== self) return current;
  }
  return null;
}

/**
 * Xem trước "Push lên main". Không thay đổi gì, không gọi mạng (dùng `origin/main` đã tải lần trước).
 * state: not_ready | missing | blocked | conflict | ready (cần gộp rồi push) | unpushed (đã trong main ở máy, chỉ còn push) | pushed.
 */
export async function inspectPush({ store, projectRoot, kind, id }) {
  const subject = subjectOf(store, kind, id);
  const base = { kind, id, title: subject.title ?? null, branch: subject.branch ?? null, target: null, remote: PUSH_REMOTE, current: null, files: [], conflictFiles: [], dirtyFiles: [], commit: null };
  if (subject.error) return { ...base, state: 'not_ready', reason: subject.error };
  const { branch } = subject;
  if (!branch || !BRANCH_RE.test(branch)) return { ...base, state: 'missing', reason: 'Việc này chưa có nhánh để push (có thể chưa thay đổi file nào).' };
  if (!(await refSha(projectRoot, `refs/heads/${branch}`))) return { ...base, state: 'missing', reason: `Nhánh ${branch} không còn trong dự án (đã bị xóa?).` };

  const target = await mainBranchOf(projectRoot);
  if (!target) return { ...base, state: 'blocked', reason: 'Dự án không có nhánh main (hay master) nên không biết push vào đâu.' };
  const current = await git(projectRoot, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true });
  const withTarget = { ...base, target, current };
  if (!(await git(projectRoot, ['remote', 'get-url', PUSH_REMOTE], { allowFail: true }))) {
    return { ...withTarget, state: 'blocked', reason: `Dự án chưa có remote "${PUSH_REMOTE}" (chưa nối với GitHub) nên không push được.` };
  }

  const tracking = `refs/remotes/${PUSH_REMOTE}/${target}`;
  const remoteSha = await refSha(projectRoot, tracking);
  if (remoteSha && await isAncestor(projectRoot, branch, tracking)) {
    return { ...withTarget, state: 'pushed', commit: remoteSha, reason: `${PUSH_REMOTE}/${target} đã có mọi thay đổi của nhánh này.` };
  }
  // GitHub có commit mà main ở máy chưa có: gộp xong cũng không push được (git từ chối), nên chặn từ trước khi gộp.
  if (remoteSha && !(await isAncestor(projectRoot, tracking, `refs/heads/${target}`))) {
    return { ...withTarget, state: 'blocked', reason: `${PUSH_REMOTE}/${target} trên GitHub có commit mới hơn ${target} ở máy. Hãy pull ${target} về (git pull) rồi bấm lại. Công cụ không force push.` };
  }

  if (await isAncestor(projectRoot, branch, `refs/heads/${target}`)) {
    return { ...withTarget, state: 'unpushed', commit: await refSha(projectRoot, `refs/heads/${target}`), reason: null };
  }

  const files = ((await git(projectRoot, ['diff', '--name-only', `refs/heads/${target}...${branch}`], { allowFail: true })) ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const filled = { ...withTarget, files };
  if (current === target) {
    // Thư mục dự án đang mở main: phải gộp thật trong thư mục làm việc, nên cần sạch và không dở thao tác git nào.
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      if (await gitPathExists(projectRoot, name)) {
        return { ...filled, state: 'blocked', reason: 'Thư mục dự án đang dở một thao tác git (gộp, rebase, cherry-pick hoặc revert). Hãy hoàn tất hoặc hủy nó trước.' };
      }
    }
    const dirtyFiles = parsePorcelainZ((await git(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=no'], { raw: true })) ?? '');
    if (dirtyFiles.length > 0) {
      return { ...filled, dirtyFiles, state: 'blocked', reason: `Thư mục dự án đang mở ${target} và có ${dirtyFiles.length} file thay đổi chưa commit. Hãy commit hoặc stash chúng trước.` };
    }
  } else {
    const elsewhere = await otherCheckout(projectRoot, target);
    if (elsewhere) return { ...filled, state: 'blocked', reason: `Nhánh ${target} đang được mở ở thư mục ${elsewhere}. Hãy gộp và push từ thư mục đó, hoặc chuyển thư mục đó sang nhánh khác.` };
  }

  const dry = await gitResult(projectRoot, ['merge-tree', '--write-tree', '--name-only', `refs/heads/${target}`, branch]);
  if (dry.code === 1) {
    const conflictFiles = parseMergeTreeConflicts(dry.stdout);
    return { ...filled, state: 'conflict', conflictFiles, reason: `Gộp vào ${target} sẽ xung đột ở ${conflictFiles.length || 'một số'} file. Hãy gộp bằng git rồi giải quyết xung đột bằng tay.` };
  }
  if (dry.code !== 0) return { ...filled, state: 'blocked', reason: `Không kiểm tra thử được việc gộp: ${dry.stderr.trim() || 'git merge-tree lỗi'}` };
  return { ...filled, state: 'ready', reason: null };
}

/** Tạo commit gộp `branch` vào `target` mà không checkout (thư mục dự án đang mở nhánh khác). Trả về mã commit mới. */
async function mergeWithoutCheckout(projectRoot, target, branch, message) {
  const ref = `refs/heads/${target}`;
  const old = await refSha(projectRoot, ref);
  const branchSha = await refSha(projectRoot, `refs/heads/${branch}`);
  const tree = await gitResult(projectRoot, ['merge-tree', '--write-tree', old, branchSha]);
  if (tree.code !== 0) throw new Error(tree.code === 1 ? `gộp vào ${target} bị xung đột` : tree.stderr.trim() || 'git merge-tree lỗi');
  const treeId = tree.stdout.split('\n')[0].trim();
  const commit = await git(projectRoot, [...GIT_IDENTITY, 'commit-tree', treeId, '-p', old, '-p', branchSha, '-m', message]);
  // Kèm giá trị cũ: nếu main vừa bị đổi ở chỗ khác thì git từ chối thay vì ghi đè.
  await git(projectRoot, ['update-ref', '-m', message, ref, commit, old]);
  return commit;
}

/**
 * Gộp vào main (nếu chưa có) rồi push lên GitHub. Không force push. Push lỗi thì phần gộp ở máy vẫn giữ để bấm "Push lại".
 * Trả về { ok: true, target, commit, merged } hoặc { ok: false, error, state, merged }.
 */
export function pushToMain({ store, projectRoot, kind, id, now = Date.now(), timeout = NETWORK_TIMEOUT_MS }) {
  return serialized(async () => {
    let info = await inspectPush({ store, projectRoot, kind, id });
    if (!['ready', 'unpushed'].includes(info.state)) return { ok: false, error: info.reason ?? 'Chưa push được.', state: info.state, merged: false };
    const { target, branch } = info;

    // Tải main mới nhất từ GitHub để biết có ai push trước không. Remote chưa có nhánh này (repo mới) thì push sẽ tạo.
    const fetched = await gitResult(projectRoot, ['fetch', '--quiet', '--no-tags', PUSH_REMOTE, `+refs/heads/${target}:refs/remotes/${PUSH_REMOTE}/${target}`], { env: NO_PROMPT, timeout });
    if (fetched.code !== 0 && !/couldn't find remote ref/i.test(fetched.stderr)) {
      return { ok: false, error: `Không tải được ${PUSH_REMOTE}/${target} từ GitHub (chưa gộp gì): ${(fetched.stderr || fetched.stdout).trim()}`, state: info.state, merged: false };
    }
    info = await inspectPush({ store, projectRoot, kind, id });
    if (info.state === 'pushed') return { ok: true, target, commit: info.commit, merged: false };
    if (!['ready', 'unpushed'].includes(info.state)) return { ok: false, error: info.reason ?? 'Chưa push được.', state: info.state, merged: false };

    let merged = false;
    if (info.state === 'ready') {
      const message = `company: đưa ${branch} vào ${target} (${kind} #${id}: ${info.title})`;
      let commit;
      if (info.current === target) {
        const result = await gitResult(projectRoot, [...GIT_IDENTITY, 'merge', '--no-ff', '--no-verify', '-m', message, branch]);
        if (result.code !== 0) {
          await gitResult(projectRoot, ['merge', '--abort']);
          return { ok: false, error: `Việc gộp vào ${target} thất bại, thư mục dự án giữ nguyên: ${(result.stderr || result.stdout).trim()}`, state: 'failed', merged: false };
        }
        commit = await git(projectRoot, ['rev-parse', 'HEAD']);
      } else {
        try {
          commit = await mergeWithoutCheckout(projectRoot, target, branch, message);
        } catch (err) {
          return { ok: false, error: `Việc gộp vào ${target} thất bại, ${target} giữ nguyên: ${err.message}`, state: 'failed', merged: false };
        }
      }
      store.addIntegration({ kind, refId: id, branch, target, commitId: commit, now });
      merged = true;
    }

    const pushed = await gitResult(projectRoot, ['push', '--porcelain', PUSH_REMOTE, `refs/heads/${target}:refs/heads/${target}`], { env: NO_PROMPT, timeout });
    if (pushed.code !== 0) {
      const detail = (pushed.stderr || pushed.stdout).trim();
      return {
        ok: false, state: 'unpushed', merged,
        error: `${merged ? `Đã gộp vào ${target} ở máy nhưng push` : 'Push'} lên ${PUSH_REMOTE} thất bại: ${detail}. Sửa xong (đăng nhập git, pull…) rồi bấm "Push lại".`,
      };
    }
    return { ok: true, target, commit: await refSha(projectRoot, `refs/heads/${target}`), merged };
  });
}

/** Thực hiện việc gộp. Trả về { ok: true, ... } hoặc { ok: false, error, state }. */
export function integrate({ store, projectRoot, kind, id, now = Date.now() }) {
  return serialized(async () => {
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
  });
}
