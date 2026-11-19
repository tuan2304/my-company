import fs from 'node:fs';
import { diagnose } from './diagnose.mjs';
import { epicJobRescueBlock } from './epics.mjs';
import { UserError } from './errors.mjs';
import { maskSecrets } from './guard.mjs';
import { JOB_TERMINAL } from './jobs.mjs';
import { nextTier } from './triage.mjs';
import { branchDiff, branchExists, git, removeWorktreeKeepBranch } from './worktree.mjs';

const GUIDANCE_MAX = 2000;

/** Lượt của Trưởng nhóm/Giám đốc mà chủ chạy lại được. ("review" không có: xem leadRecoverability.) */
export const LEAD_RERUN_KINDS = ['plan', 'dplan', 'dreview'];

/** Việc lớn đã kết thúc: mở lại được thì trả về `reopensJob`, không thì nói rõ vì sao. `what` là thứ đang muốn xử lý. */
function terminalJobRescue(store, job, what) {
  if (['attention', 'failed'].includes(job.status)) {
    // Việc lớn đã kết luận "cần xem" hoặc "lỗi" thì mở lại được: xử lý xong, hệ thống gộp lại. Việc lớn thuộc yêu cầu thì yêu cầu phải cho phép.
    const why = job.epic_id === null ? null : epicJobRescueBlock(store, job);
    if (!why) return { recoverable: true, blockedReason: null, reopensJob: job.id };
    return { recoverable: false, blockedReason: `Việc lớn #${job.id} ${why}` };
  }
  return { recoverable: false, blockedReason: `Việc lớn #${job.id} đã ${job.status === 'done' ? 'xong' : 'dừng'}, nên không xử lý riêng ${what} được.` };
}

/** Một việc "làm" có xử lý lỗi được không? Chỉ việc đang ở trạng thái lỗi. */
function workRecoverability(store, task) {
  if (task.status !== 'failed') return { recoverable: false, blockedReason: 'Việc này không ở trạng thái lỗi.' };
  if (task.job_id) {
    const job = store.getJob(task.job_id);
    if (!job) return { recoverable: false, blockedReason: 'Không còn việc lớn chứa việc này.' };
    if (JOB_TERMINAL.includes(job.status)) return terminalJobRescue(store, job, 'việc con này');
  }
  return { recoverable: true, blockedReason: null };
}

const EPIC_STATUS_WHY = {
  awaiting_plan: 'Kế hoạch đang chờ bạn duyệt: hãy duyệt, hoặc từ chối kèm nhận xét để Giám đốc lập lại.',
  awaiting_result: 'Kết quả đang chờ bạn duyệt.',
  done: 'Yêu cầu đã hoàn thành.',
  stopped: 'Yêu cầu đã bị dừng.',
  rejected: 'Bạn đã không duyệt kết quả của yêu cầu này.',
};

/**
 * Lượt của Trưởng nhóm/Giám đốc chạy lại được không?
 *  - plan (lập kế hoạch cho việc lớn): lượt mới nhất; việc lớn đã kết thúc thì mở lại (kể cả việc lớn trong yêu cầu).
 *  - dplan (Giám đốc lập kế hoạch): lượt mới nhất, khi yêu cầu đang lỗi.
 *  - dreview (Giám đốc kiểm tra): lượt mới nhất, khi yêu cầu "cần xem" vì Giám đốc chưa kết luận được.
 *  - review (Trưởng nhóm duyệt bài): lượt lỗi hai lần thì bài nộp bị đánh dấu lỗi; chủ quyết ở bài nộp đó.
 * `force`: bỏ điều kiện "lượt phải đang ở trạng thái lỗi" (dùng khi chủ chạy lại từ màn hình của yêu cầu, ví dụ Giám đốc kết thúc mà không giao việc nào).
 */
function leadRecoverability(store, task, { force = false } = {}) {
  const no = (reason) => ({ recoverable: false, blockedReason: reason });
  if (task.kind === 'review') {
    return no(`Đây là lượt duyệt bài của Trưởng nhóm. Nếu lượt duyệt lỗi hai lần, việc #${task.subject_id ?? '?'} được đánh dấu lỗi để bạn quyết định ở đó (ví dụ cho Trưởng nhóm duyệt lại bằng "Nhận phần đã làm").`);
  }
  if (!LEAD_RERUN_KINDS.includes(task.kind)) return no('Đây là lượt trả lời câu hỏi giữa đồng nghiệp; nếu lỗi thì người hỏi sẽ tự quyết, không cần bạn xử lý.');
  if (!force && task.status !== 'failed') return no('Lượt này không ở trạng thái lỗi.');

  if (task.kind === 'plan') {
    const job = task.job_id ? store.getJob(task.job_id) : null;
    if (!job) return no('Không còn việc lớn chứa lượt này.');
    const latest = store.jobTasks(job.id).filter((t) => t.kind === 'plan').at(-1);
    if (latest && latest.id !== task.id) return no('Đã có lượt lập kế hoạch mới hơn cho việc lớn này.');
    if (!JOB_TERMINAL.includes(job.status)) return { recoverable: true, blockedReason: null };
    return terminalJobRescue(store, job, 'lượt này');
  }

  const epic = task.epic_id ? store.getEpic(task.epic_id) : null;
  if (!epic) return no('Không còn yêu cầu chứa lượt này.');
  const latest = store.epicTasks(epic.id).filter((t) => t.kind === task.kind).at(-1);
  if (latest && latest.id !== task.id) return no(`Đã có lượt ${task.kind === 'dplan' ? 'lập kế hoạch' : 'kiểm tra'} mới hơn cho yêu cầu này.`);
  if (task.kind === 'dplan') {
    if (epic.status === 'failed') return { recoverable: true, blockedReason: null, reopensEpic: { id: epic.id, kind: 'dplan' } };
    return no(EPIC_STATUS_WHY[epic.status] ?? `Yêu cầu đang ở trạng thái "${epic.status}" nên chưa chạy lại riêng lượt này được.`);
  }
  if (epic.status === 'attention' && !epic.verdict) return { recoverable: true, blockedReason: null, reopensEpic: { id: epic.id, kind: 'dreview' } };
  if (epic.verdict) return no('Giám đốc đã có kết luận cho yêu cầu này nên không chạy lại lượt kiểm tra được.');
  return no(EPIC_STATUS_WHY[epic.status] ?? `Yêu cầu đang ở trạng thái "${epic.status}" nên chưa chạy lại riêng lượt này được.`);
}

async function branchAhead(projectRoot, task) {
  if (!task.branch || !task.base_commit) return 0;
  if (!(await branchExists(projectRoot, task.branch))) return 0;
  const count = await git(projectRoot, ['rev-list', '--count', `${task.base_commit}..${task.branch}`], { allowFail: true });
  return Number(count) || 0;
}

/**
 * Dữ kiện để chẩn đoán: nhánh có phần đã làm không, còn phiên/thư mục để làm tiếp không, có xử lý được không.
 * Lượt của Trưởng nhóm/Giám đốc không có nhánh riêng; chỉ cần còn phiên là làm tiếp được.
 */
export async function factsFor({ store, projectRoot, task, force = false }) {
  if (task.kind !== 'work') {
    return { hasWork: false, canResume: Boolean(task.session_id), ...leadRecoverability(store, task, { force }) };
  }
  const ahead = await branchAhead(projectRoot, task);
  const worktreeExists = Boolean(task.worktree) && fs.existsSync(task.worktree);
  return {
    hasWork: ahead > 0,
    canResume: Boolean(task.session_id) && worktreeExists,
    ...workRecoverability(store, task),
  };
}

/** Vài dòng nhật ký gần nhất đáng đọc của một lượt (đã che bí mật). */
export function evidenceOf(store, id) {
  const interesting = store.listEvents(id).filter((e) => ['error', 'tool_error', 'warn', 'say', 'quota', 'escalate', 'review'].includes(e.kind));
  return interesting.slice(-6).map((e) => ({ ts: e.ts, kind: e.kind, summary: maskSecrets(e.summary) }));
}

/** Thông tin cho màn hình xử lý lỗi: chẩn đoán, vài dòng nhật ký gần nhất, và phần nhân viên đã làm (nếu có). */
export async function inspectFailure({ store, projectRoot, id }) {
  const task = store.getTask(id);
  if (!task) throw new UserError('Không có việc này.');
  const facts = await factsFor({ store, projectRoot, task });
  const diagnosis = diagnose(task, facts);
  const evidence = evidenceOf(store, id);
  let work = null;
  if (facts.hasWork) {
    const diff = await branchDiff({ projectRoot, baseCommit: task.base_commit, branch: task.branch, maxChars: 20_000 });
    const names = (await git(projectRoot, ['diff', '--name-only', `${task.base_commit}..${task.branch}`], { allowFail: true })) ?? '';
    const files = names.split('\n').map((s) => s.trim()).filter(Boolean);
    work = { branch: task.branch, stat: diff.stat, patch: maskSecrets(diff.patch), truncated: diff.truncated, files };
  }
  return { diagnosis, evidence, work };
}

export function cleanGuidance(value) {
  const text = String(value ?? '').trim();
  if (text.length > GUIDANCE_MAX) throw new UserError(`Lời dặn quá dài (tối đa ${GUIDANCE_MAX} ký tự).`);
  return text || null;
}

/** Áp dụng đúng một hành động lên việc "làm" (đã được kiểm tra hợp lệ). */
async function apply(runner, current, { action, note }) {
  const { id } = current;
  const reset = { error: null, failure_code: null, finished_at: null, resume_at: null };
  switch (action) {
    case 'continue':
    case 'raise': {
      const fields = { ...reset, status: 'queued', owner_guidance: note, recoveries: current.recoveries + 1 };
      let detail = 'Làm tiếp đúng phiên cũ';
      if (action === 'raise') {
        const next = nextTier(current.model);
        fields.model = next.model;
        fields.effort = next.effort;
        detail = `Nâng ${current.model} lên ${next.model} (suy luận ${next.effort}) rồi làm tiếp`;
      }
      runner.update(id, fields);
      runner.log(id, 'recover', `Chủ chọn: ${detail}.${note ? ` Lời dặn: ${note}` : ''}`);
      break;
    }
    case 'redo': {
      const oldBranch = current.branch;
      await removeWorktreeKeepBranch({ projectRoot: runner.cfg.projectRoot, worktreesDir: runner.cfg.worktreesDir, dir: current.worktree });
      runner.update(id, {
        ...reset, status: 'queued', owner_guidance: note, recoveries: current.recoveries + 1,
        session_id: null, worktree: null, branch: null, start_from: null, changed_files: null, result: null, turns: 0,
      });
      runner.log(id, 'recover', `Chủ chọn: Làm lại từ đầu${oldBranch ? ` (nhánh cũ ${oldBranch} vẫn được giữ)` : ''}.${note ? ` Lời dặn: ${note}` : ''}`);
      break;
    }
    case 'accept': {
      let files = [];
      try {
        files = (await git(runner.cfg.projectRoot, ['diff', '--name-only', `${current.base_commit}..${current.branch}`])).split('\n').filter(Boolean);
      } catch {
        /* không đọc được danh sách file: vẫn nhận bài */
      }
      const submitted = Boolean(current.job_id);
      runner.update(id, {
        ...reset, status: submitted ? 'submitted' : 'done', finished_at: Date.now(),
        changed_files: JSON.stringify(files),
        result: `(Bạn đã nhận phần nhân viên làm dở. Lý do dừng: ${current.error ?? 'không rõ'})`,
      });
      runner.log(id, 'recover', `Chủ chọn: Nhận phần đã làm (${files.length} file).${submitted ? ' Đã nộp bài, chờ Trưởng nhóm duyệt.' : ''}`);
      break;
    }
    case 'skip': {
      runner.update(id, { ...reset, status: 'stopped', error: 'Bạn đã bỏ qua việc này.', finished_at: Date.now() });
      runner.log(id, 'recover', 'Chủ chọn: Bỏ qua việc này.');
      break;
    }
    default:
      throw new UserError(`Hành động "${action}" không hợp lệ.`);
  }
}

/**
 * Chạy lại một lượt của Trưởng nhóm/Giám đốc: cùng một dòng trong bảng, trạng thái về "xếp hàng".
 * Còn phiên thì làm tiếp phiên đó (trừ khi chọn "từ đầu"); lời dặn của chủ đi kèm; có thêm lượt và thời gian.
 */
export function applyLead(runner, current, { action, note }) {
  const fields = {
    error: null, failure_code: null, finished_at: null, resume_at: null, result: null,
    status: 'queued', owner_guidance: note, recoveries: current.recoveries + 1, auto_retries: 0,
  };
  let detail;
  if (action === 'continue') {
    detail = 'Chạy lại, làm tiếp phiên cũ';
  } else if (action === 'raise') {
    const next = nextTier(current.model);
    if (!next) throw new UserError('Đã ở model mạnh nhất, không nâng thêm được.');
    fields.model = next.model;
    fields.effort = next.effort;
    detail = `Nâng ${current.model} lên ${next.model} (suy luận ${next.effort}) rồi chạy lại`;
  } else if (action === 'redo') {
    fields.session_id = null;
    detail = 'Chạy lại từ đầu (phiên mới)';
  } else {
    throw new UserError(`Hành động "${action}" không hợp lệ.`);
  }
  runner.update(current.id, fields);
  runner.log(current.id, 'recover', `Chủ chọn: ${detail}.${note ? ` Lời dặn: ${note}` : ''}`);
}

/**
 * Mở lại việc lớn hoặc yêu cầu đã kết thúc để lượt vừa chạy lại còn chỗ chạy. Trả về hàm hoàn tác (dùng khi bước sau hỏng giữa chừng),
 * để việc lớn tự kết luận lại hoặc yêu cầu về đúng trạng thái cũ chứ không kẹt ở "đang chạy" mà không có lượt nào chạy.
 */
export async function reopenParent(runner, facts) {
  if (facts.reopensJob) {
    await runner.jobs.reopen(facts.reopensJob);
    return () => runner.jobs.advance(facts.reopensJob);
  }
  if (facts.reopensEpic) {
    const { id, kind } = facts.reopensEpic;
    const before = runner.store.getEpic(id);
    runner.epics.reopenForDirector(id, kind);
    return () => runner.epics.update(id, { status: before.status, error: before.error, finished_at: before.finished_at });
  }
  return () => {};
}

/**
 * Thực hiện một lựa chọn của chủ cho việc đã lỗi. Mỗi việc chỉ xử lý một lần tại một thời điểm (bấm đúp không làm hai lần).
 * @param {import('./runner.mjs').Runner} runner
 */
export async function recoverTask(runner, id, { action, guidance } = {}) {
  const { store } = runner;
  if (!store.getTask(id)) throw new UserError('Không có việc này.');
  runner.recovering ??= new Set();
  if (runner.recovering.has(id)) throw new UserError('Việc này đang được xử lý, đợi một chút.');
  runner.recovering.add(id);
  try {
    const current = store.getTask(id);
    const facts = await factsFor({ store, projectRoot: runner.cfg.projectRoot, task: current });
    if (!facts.recoverable) throw new UserError(facts.blockedReason);
    const diagnosis = diagnose(current, facts);
    const option = diagnosis.options.find((o) => o.action === action);
    if (!option) {
      const valid = diagnosis.options.map((o) => o.action).join(', ') || '(không có)';
      throw new UserError(`Không thể "${action}" với việc này lúc này. Các lựa chọn hiện có: ${valid}.`);
    }
    const note = cleanGuidance(guidance);
    if (note && !option.guidance) throw new UserError('Lựa chọn này không nhận lời dặn.');

    // Việc lớn/yêu cầu đã kết luận thì mở lại trước. Nếu bước xử lý hỏng giữa chừng thì hoàn tác.
    const undo = await reopenParent(runner, facts);
    try {
      if (current.kind === 'work') await apply(runner, current, { action, note });
      else applyLead(runner, current, { action, note });
    } catch (err) {
      await undo();
      throw err;
    }
  } finally {
    runner.recovering.delete(id);
  }
  // Báo cho việc lớn (nếu có) biết trạng thái mới, rồi để bộ lập lịch nhận việc đang xếp hàng.
  await runner.notifyJobs(id);
  runner.schedule();
  return store.getTask(id);
}
