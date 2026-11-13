import path from 'node:path';
import { Contests, parseContest, validateSets } from './contest.mjs';
import { UserError } from './errors.mjs';
import { shorten } from './guard.mjs';
import { epicJobRescueBlock } from './epics.mjs';
import { describeFolders, folderRules, inFolders } from './path-guard.mjs';
import { findMember, workersOf } from './teams.mjs';
import { branchDiff, checkRepo, integrateBranches, removeWorktreeKeepBranch, resolveRef } from './worktree.mjs';
import { knownFailuresLine } from './project.mjs';

/**
 * Điều phối việc lớn (job) của một team:
 *   Chủ giao việc lớn → Trưởng nhóm lập kế hoạch (chia việc con bằng công cụ) → nhân viên làm song song
 *   → mỗi bài nộp được Trưởng nhóm duyệt hoặc trả lại → gộp các nhánh đã duyệt → báo cáo.
 * Mọi quy tắc cứng (giới hạn tải, trùng phạm vi, số lần trả bài) do máy chủ ép trong file này.
 */

const WORK_OPEN = ['queued', 'running', 'paused_quota', 'submitted', 'waiting_answer'];
const LEAD_OPEN = ['queued', 'running', 'paused_quota'];
export const JOB_TERMINAL = ['done', 'attention', 'failed', 'stopped'];

export class JobError extends Error {}

function toolError(message) {
  return new JobError(message);
}

export function normalizeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw toolError('Thiếu "files": hãy nêu các file hoặc thư mục mà việc con này sẽ sửa.');
  }
  const out = [];
  for (const raw of files) {
    const cleaned = String(raw ?? '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (!cleaned || cleaned === '.') throw toolError('Phạm vi file phải cụ thể (một file hoặc thư mục con), không được để trống hay là cả dự án.');
    if (cleaned.split('/').includes('..') || /^[A-Za-z]:/.test(cleaned)) throw toolError(`Đường dẫn không hợp lệ: ${raw}`);
    out.push(cleaned);
  }
  return [...new Set(out)];
}

const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export function findOverlap(files, otherFiles) {
  for (const a of files) for (const b of otherFiles) if (overlaps(a, b)) return [a, b];
  return null;
}

function parseFiles(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export class Jobs {
  /** @param {import('./runner.mjs').Runner} runner */
  constructor(runner) {
    this.r = runner;
    this.starting = new Set(); // việc đang được chuẩn bị bắt đầu (tránh bắt đầu hai lần khi hai việc phụ thuộc cùng xong)
    this.contests = new Contests(this);
  }

  get store() {
    return this.r.store;
  }

  // ---------- Tải của nhân viên ----------

  capacity(team) {
    return team.limits.max_active_per_member + team.limits.max_queue_per_member;
  }

  workload(team) {
    const cap = this.capacity(team);
    return workersOf(team).map((m) => {
      const role = team.roles[m.role];
      const open = this.store.openLoad(m.name);
      const active = open.filter((t) => t.status === 'running').length;
      return {
        name: m.name, title: role.title, model: role.model, strengths: m.strengths,
        active, queued: open.length - active, free: Math.max(0, cap - open.length), cap, open,
      };
    });
  }

  renderWorkload(team) {
    return this.workload(team)
      .map((w) => {
        const tasks = w.open.length ? w.open.map((t) => `#${t.id} "${shorten(t.title, 50)}" (${t.status})`).join('; ') : 'không có việc';
        return `- ${w.name} (${w.title}; thế mạnh: ${w.strengths.join(', ') || 'chung'}; model mặc định ${w.model}): đang làm ${w.active}, chờ ${w.queued}, còn nhận thêm được ${w.free}/${w.cap}. Việc hiện tại: ${tasks}`;
      })
      .join('\n');
  }

  teamOf(task) {
    const found = findMember(this.r.getTeams(), task.member);
    if (!found) throw toolError('Không tìm thấy team của Trưởng nhóm trong cấu hình.');
    return found.team;
  }

  // ---------- Tạo việc lớn ----------

  async create({ team: teamId, title, prompt, acceptance = '', contest = null }) {
    const cleanTitle = String(title ?? '').trim();
    const cleanPrompt = String(prompt ?? '').trim();
    if (!cleanTitle) throw new UserError('Thiếu tiêu đề việc lớn.');
    if (!cleanPrompt) throw new UserError('Thiếu mô tả việc lớn.');
    if (cleanTitle.length > 200 || cleanPrompt.length > 20_000 || String(acceptance).length > 10_000) {
      throw new UserError('Nội dung việc lớn quá dài.');
    }
    const team = this.r.getTeams().find((t) => t.id === teamId);
    if (!team) throw new UserError(`Không có team "${teamId}".`);
    if (!team.lead) throw new UserError(`Team "${team.name}" chưa có Trưởng nhóm nên không nhận việc lớn.`);
    if (workersOf(team).length === 0) throw new UserError(`Team "${team.name}" chưa có nhân viên nào.`);
    let contestState = null;
    if (contest) {
      if (workersOf(team).length < 2) throw new UserError(`Thi đấu cần ít nhất hai nhân viên, mà team "${team.name}" chỉ có ${workersOf(team).length}.`);
      contestState = { sets: validateSets(contest, path.join(this.r.cfg.toolDir, 'skills.lock')), status: 'splitting' };
    }
    let baseCommit;
    try {
      baseCommit = await checkRepo(this.r.cfg.projectRoot);
    } catch (err) {
      throw new UserError(err.message, { cause: err });
    }

    const job = this.store.createJob({
      title: cleanTitle, prompt: cleanPrompt, acceptance: String(acceptance), team: team.id, lead: team.lead, baseCommit, contest: contestState,
    });
    const plan = this.r.createLeadTask({ kind: 'plan', job });
    const updated = this.store.updateJob(job.id, { plan_task_id: plan.id });
    this.r.log(plan.id, 'job', `Việc lớn #${job.id} "${job.title}" giao cho ${team.name}. ${team.lead} sẽ lập kế hoạch.`);
    this.r.emit('job', updated);
    this.r.schedule();
    return updated;
  }

  /** Ghi nhật ký của việc lớn vào lượt lập kế hoạch của nó (hoặc của yêu cầu chứa nó nếu chưa bắt đầu). */
  jobLog(job, kind, text) {
    const taskId = job.plan_task_id ?? (job.epic_id ? this.store.getEpic(job.epic_id)?.plan_task_id : null);
    if (taskId) this.r.log(taskId, kind, text);
  }

  /** Việc lớn của một team trong một yêu cầu: tạo ở dạng nháp, chưa chạy cho tới khi kế hoạch được duyệt. */
  createDraft({ epic, team, title, description, acceptance = '', dependsOn = [], baseRef = null, baseDir = null, round = 0 }) {
    const status = dependsOn.length ? 'waiting' : 'draft';
    return this.store.createJob({
      title, prompt: description, acceptance, team: team.id, lead: team.lead, baseCommit: null,
      epicId: epic.id, dependsOn, baseRef, baseDir, round, status,
    });
  }

  /**
   * Bắt đầu một việc lớn đang ở trạng thái nháp hoặc chờ phụ thuộc: chốt mã gốc để các nhân viên rẽ nhánh,
   * rồi giao cho Trưởng nhóm lập kế hoạch. Việc có phụ thuộc thì gốc là kết quả đã ghép của các việc đó.
   */
  async start(jobId) {
    if (this.starting.has(jobId)) return;
    this.starting.add(jobId);
    try {
      await this.doStart(jobId);
    } finally {
      this.starting.delete(jobId);
    }
  }

  async doStart(jobId) {
    const job = this.store.getJob(jobId);
    if (!job || !['draft', 'waiting'].includes(job.status)) return;
    const epic = job.epic_id ? this.store.getEpic(job.epic_id) : null;
    const deps = JSON.parse(job.depends_on ?? '[]').map((id) => this.store.getJob(id));

    let baseCommit;
    let baseDir = job.base_dir;
    try {
      if (job.base_ref) {
        baseCommit = await resolveRef(this.r.cfg.projectRoot, job.base_ref);
      } else if (deps.length) {
        const merged = await integrateBranches({
          projectRoot: this.r.cfg.projectRoot, worktreesDir: this.r.cfg.worktreesDir, name: `job${job.id}-base`,
          baseCommit: epic?.base_commit ?? (await checkRepo(this.r.cfg.projectRoot)), branches: deps.map((d) => d.merge_branch).filter(Boolean),
        });
        if (!merged.ok) {
          this.finishJob(job, {
            status: 'failed',
            error: `Không ghép được kết quả của các việc mà việc này phụ thuộc (xung đột ở ${merged.conflictFiles.join(', ') || 'không rõ'}).`,
          });
          return;
        }
        baseCommit = merged.commit;
        baseDir = merged.dir;
      } else {
        baseCommit = epic?.base_commit ?? (await checkRepo(this.r.cfg.projectRoot));
      }
    } catch (err) {
      this.finishJob(job, { status: 'failed', error: `Không chuẩn bị được mã gốc cho việc này: ${err.message}` });
      return;
    }

    // Hợp đồng chung của yêu cầu được đính kèm để Trưởng nhóm và nhân viên cùng bám theo.
    const contract = epic?.contract?.trim();
    const prompt = contract
      ? `${job.prompt}\n\n## Hợp đồng chung của yêu cầu (bắt buộc bám theo)\nChỉ để tham chiếu: hợp đồng mô tả cả phần của các team khác. CHỈ làm đúng phần việc được giao ở trên; phần nào thuộc team khác thì KHÔNG làm, chỉ bám đúng giao diện mà hợp đồng đã chốt.\n\n${contract}`
      : job.prompt;
    this.store.updateJob(job.id, { status: 'planning', base_commit: baseCommit, base_dir: baseDir, prompt });
    const started = this.store.getJob(job.id);
    const plan = this.r.createLeadTask({ kind: 'plan', job: started });
    const updated = this.store.updateJob(job.id, { plan_task_id: plan.id });
    this.r.log(plan.id, 'job', `Việc lớn #${job.id} "${job.title}" bắt đầu${epic ? ` (thuộc yêu cầu #${epic.id})` : ''}. ${updated.lead} sẽ lập kế hoạch.`);
    this.r.emit('job', updated);
    this.r.schedule();
  }

  // ---------- Chủ xử lý việc lớn lỗi ----------

  /**
   * Mở lại một việc lớn đã kết thúc ở trạng thái "cần xem" hoặc "lỗi" (không thuộc yêu cầu nào) để xử lý lại việc con lỗi.
   * Nhánh gộp cũ vẫn giữ; khi các việc con xong, hệ thống gộp lại sang nhánh mới.
   */
  async reopen(jobId) {
    let job = this.store.getJob(jobId);
    if (!job) throw new UserError('Không có việc lớn này.');
    if (!['attention', 'failed'].includes(job.status)) throw new UserError('Việc lớn này không mở lại được.');
    // Việc lớn thuộc một yêu cầu: chỉ mở lại khi yêu cầu cho phép (xem epicJobRescueBlock). Kiểm tra trước khi động vào thư mục gộp.
    if (job.epic_id !== null) {
      const blocked = epicJobRescueBlock(this.store, job);
      if (blocked) throw new UserError(`Việc lớn này không mở lại được: ${blocked}`);
    }
    if (job.merge_worktree) {
      await removeWorktreeKeepBranch({ projectRoot: this.r.cfg.projectRoot, worktreesDir: this.r.cfg.worktreesDir, dir: job.merge_worktree });
    }
    // Từ đây không await nữa: mở lại yêu cầu và việc lớn trong cùng một nhịp. (Trong lúc dọn thư mục, trạng thái có thể đã đổi.)
    job = this.store.getJob(jobId);
    if (!['attention', 'failed'].includes(job.status)) throw new UserError('Việc lớn này không mở lại được.');
    if (job.epic_id !== null) this.r.epics.reopenForJob(job);
    const updated = this.store.updateJob(jobId, {
      status: 'running', error: null, summary: null, conflict_files: null, merge_branch: null, merge_worktree: null, finished_at: null,
    });
    this.jobLog(updated, 'job', `Chủ mở lại việc lớn #${jobId} để xử lý việc con lỗi${job.merge_branch ? ` (nhánh gộp cũ ${job.merge_branch} vẫn được giữ)` : ''}.`);
    this.r.emit('job', updated);
    return updated;
  }

  /** Việc lớn lỗi mà chưa có việc con nào (Trưởng nhóm lập kế hoạch lỗi hoặc không chia được việc): cho Trưởng nhóm lập kế hoạch lại. */
  replan(jobId, { guidance } = {}) {
    const job = this.store.getJob(jobId);
    if (!job) throw new UserError('Không có việc lớn này.');
    if (job.status !== 'failed') throw new UserError('Chỉ lập kế hoạch lại được cho việc lớn đang ở trạng thái lỗi.');
    if (this.store.jobTasks(jobId).some((t) => t.kind === 'work')) {
      throw new UserError('Việc lớn này đã có việc con. Hãy xử lý từng việc con lỗi thay vì lập kế hoạch lại.');
    }
    const note = String(guidance ?? '').trim();
    if (note.length > 2000) throw new UserError('Lời dặn quá dài (tối đa 2000 ký tự).');
    // Việc lớn của một yêu cầu: mở lại yêu cầu trước (ném lỗi nếu yêu cầu không cho phép).
    if (job.epic_id !== null) this.r.epics.reopenForJob(job);
    const plan = this.r.createLeadTask({ kind: 'plan', job });
    if (note) this.store.updateTask(plan.id, { owner_guidance: note });
    const updated = this.store.updateJob(jobId, { status: 'planning', error: null, summary: null, plan_task_id: plan.id, finished_at: null });
    this.r.log(plan.id, 'job', `Chủ cho ${job.lead} lập kế hoạch lại cho việc lớn #${job.id}.${note ? ` Lời dặn: ${note}` : ''}`);
    this.r.emit('job', updated);
    this.r.schedule();
    return updated;
  }

  // ---------- Công cụ của Trưởng nhóm ----------

  describeWorkload(planTask) {
    return this.renderWorkload(this.teamOf(planTask));
  }

  /** Phạm vi file của một việc con: chuẩn hóa, và phải nằm trong thư mục của team (hồ sơ dự án), vì hook chỉ cho nhân viên sửa ở đó. */
  checkScope(rawFiles, team) {
    const files = normalizeFiles(rawFiles);
    const folders = this.r.getProject()?.folders?.[team.id] ?? [];
    const { include, exclude } = folderRules(folders);
    if (team.requiresFolders && include.length === 0) {
      throw toolError(
        `Hồ sơ dự án chưa khai thư mục cho ${team.name} (local/project.md, mục folders.${team.id}), nên nhân viên của team không ghi được file nào. ` +
          'Đừng giao việc con; hãy kết thúc lượt và báo chủ dự án khai thư mục cho team trước.',
      );
    }
    if (include.length || exclude.length) {
      const outside = files.filter((f) => !inFolders(f, folders));
      if (outside.length) {
        const scope = [...include, ...exclude.map((e) => `trừ ${e}`)].join(', ');
        throw toolError(
          `Phạm vi ${outside.map((f) => `"${f}"`).join(', ')} nằm ngoài thư mục của ${team.name} (${scope}). ` +
            'Nhân viên của team không sửa được ở đó (sẽ bị chặn), nên đó là phần của team khác. Chỉ giao việc trong thư mục của team, và bỏ phần thuộc team khác ra khỏi việc này.',
        );
      }
    }
    return files;
  }

  /** Thi đấu skill: giao cùng một việc cho hai người (được miễn luật "không chồng lấn phạm vi", vì chỉ một nhánh được gộp). */
  assignContest(planTask, args) {
    const job = this.store.getJob(planTask.job_id);
    if (!job || JOB_TERMINAL.includes(job.status)) throw toolError('Việc lớn này đã kết thúc, không giao thêm được.');
    return this.contests.assign(planTask, args, { checkScope: (files, team) => this.checkScope(files, team), toolError });
  }

  assign(planTask, args) {
    const job = this.store.getJob(planTask.job_id);
    if (!job || JOB_TERMINAL.includes(job.status)) throw toolError('Việc lớn này đã kết thúc, không giao thêm được.');
    if (parseContest(job)) throw toolError('Đây là việc thi đấu skill: hãy dùng assign_contest để giao cùng một việc cho hai người, không dùng assign_to_member.');
    const team = this.teamOf(planTask);
    const workers = workersOf(team);

    const wanted = String(args.member ?? '').trim().toLowerCase();
    const member = workers.find((m) => m.name.toLowerCase() === wanted);
    if (!member) throw toolError(`Không có nhân viên "${args.member}". Các nhân viên của team: ${workers.map((m) => m.name).join(', ')}.`);

    const title = String(args.title ?? '').trim();
    const description = String(args.description ?? '').trim();
    if (!title || !description) throw toolError('Thiếu title hoặc description.');
    if (title.length > 200 || description.length > 20_000) throw toolError('title hoặc description quá dài.');
    const level = args.level ?? 'auto';
    if (!['auto', 'easy', 'normal', 'hard'].includes(level)) throw toolError(`level "${level}" không hợp lệ.`);

    const existing = this.store.jobTasks(job.id).filter((t) => t.kind === 'work');
    if (existing.length >= team.limits.max_subtasks) {
      throw toolError(`Việc lớn đã có ${existing.length} việc con, bằng mức tối đa của team (${team.limits.max_subtasks}). Hãy gộp bớt thay vì chia nhỏ thêm.`);
    }
    if (existing.some((t) => t.title.trim().toLowerCase() === title.toLowerCase())) {
      throw toolError(`Đã có việc con tên "${title}" trong việc lớn này. Hãy đặt tiêu đề khác, hoặc bỏ qua nếu bạn đã giao việc này rồi.`);
    }

    const files = this.checkScope(args.files, team);
    for (const other of existing.filter((t) => !['failed', 'stopped'].includes(t.status))) {
      const clash = findOverlap(files, parseFiles(other.files));
      if (clash) {
        throw toolError(
          `Phạm vi file chồng lấn với việc #${other.id} "${other.title}" của ${other.member} (${clash[0]} và ${clash[1]}). ` +
            'Hai người sửa cùng chỗ trong lúc làm song song sẽ xung đột khi gộp. Hãy gộp hai việc này cho cùng một người, hoặc đổi phạm vi cho tách biệt.',
        );
      }
    }

    const found = findMember(this.r.getTeams(), member.name);
    try {
      this.r.checkCapacity(found);
    } catch (err) {
      throw toolError(`${err.message}\nTải hiện tại:\n${this.renderWorkload(team)}\nHãy giao cho người còn chỗ, hoặc gộp việc.`);
    }

    const task = this.r.createWork({
      found, title, prompt: description, acceptance: String(args.acceptance ?? ''), level, jobId: job.id, files,
    });
    this.r.log(planTask.id, 'job', `Giao việc #${task.id} "${title}" cho ${member.name} (phạm vi: ${files.join(', ')}).`);
    this.r.schedule();
    return `Đã giao việc #${task.id} "${title}" cho ${member.name}${level === 'auto' ? ' (độ khó sẽ do hệ thống tự đánh giá)' : ` (độ khó ${level})`}. Phạm vi: ${files.join(', ')}.`;
  }

  review(reviewTask, args) {
    if (reviewTask.verdict) throw toolError('Bạn đã đưa ra kết luận cho bài này rồi.');
    const subject = this.store.getTask(reviewTask.subject_id);
    if (!subject) throw toolError('Không tìm thấy bài nộp đang duyệt.');
    if (Number(args.task_id) !== subject.id) throw toolError(`Bạn đang duyệt việc #${subject.id}, không phải #${args.task_id}.`);
    if (subject.status !== 'submitted') throw toolError(`Việc #${subject.id} không ở trạng thái chờ duyệt (hiện là ${subject.status}).`);
    const team = this.teamOf(reviewTask);
    const feedback = String(args.feedback ?? '').trim();

    if (args.verdict === 'approve') {
      this.r.update(subject.id, { status: 'done', error: null, review_feedback: null, finished_at: Date.now() });
      this.r.update(reviewTask.id, { verdict: 'approve' });
      this.r.log(subject.id, 'review', `${reviewTask.member} đã duyệt bài.${feedback ? ` Nhận xét: ${shorten(feedback, 300)}` : ''}`);
      return `Đã duyệt việc #${subject.id} của ${subject.member}.`;
    }
    if (args.verdict !== 'reject') throw toolError('verdict phải là "approve" hoặc "reject".');
    if (feedback.length < 5) throw toolError('Khi reject phải có nhận xét cụ thể (feedback) để nhân viên biết cần sửa gì.');

    const max = team.limits.max_revisions;
    if (subject.revisions >= max) {
      this.r.update(subject.id, {
        status: 'failed', failure_code: 'rejected_final', finished_at: Date.now(),
        error: `Bị trả bài quá ${max} lần mà vẫn chưa đạt. Nhận xét cuối: ${shorten(feedback, 400)}`,
      });
      this.r.update(reviewTask.id, { verdict: 'reject_final' });
      this.r.log(subject.id, 'review', `${reviewTask.member} trả bài lần cuối: ${shorten(feedback, 300)}. Đã hết ${max} lần được trả, việc này cần con người xem.`);
      return `Việc #${subject.id} đã bị trả ${subject.revisions}/${max} lần nên không trả thêm được. Hệ thống ghi nhận việc này chưa đạt và cần người xem.`;
    }
    this.r.update(subject.id, {
      status: 'queued', revisions: subject.revisions + 1, review_feedback: feedback, finished_at: null, error: null,
    });
    this.r.update(reviewTask.id, { verdict: 'reject' });
    this.r.log(subject.id, 'review', `${reviewTask.member} trả bài (lần ${subject.revisions + 1}/${max}): ${shorten(feedback, 400)}`);
    return `Đã trả việc #${subject.id} cho ${subject.member} làm lại (lần ${subject.revisions + 1}/${max}).`;
  }

  // ---------- Vòng đời ----------

  /** Gọi sau mỗi lần một việc thuộc việc lớn đổi trạng thái (đã kết thúc một lượt chạy hoặc bị dừng). */
  async afterChange(taskId) {
    const task = this.store.getTask(taskId);
    if (!task?.job_id) return;
    const job = this.store.getJob(task.job_id);
    if (!job || JOB_TERMINAL.includes(job.status)) return;

    if (parseContest(job) && task.kind === 'work') {
      // Thi đấu: không duyệt riêng từng bài. Đợi cả hai bản nộp xong rồi chụp ảnh cho chủ chọn (xem contest.mjs).
      await this.contests.progress(job.id);
      return;
    }
    if (task.kind === 'work' && task.status === 'submitted') {
      const pending = this.store.jobTasks(job.id).some((t) => t.kind === 'review' && t.subject_id === task.id && LEAD_OPEN.includes(t.status));
      if (!pending) this.r.createLeadTask({ kind: 'review', job, subject: task });
      this.r.schedule();
    } else if (task.kind === 'review' && ['done', 'failed'].includes(task.status)) {
      this.handleReviewEnded(job, task);
    } else if (task.kind === 'plan' && task.status === 'stopped') {
      await this.stop(job.id, 'Việc lớn bị dừng theo yêu cầu.');
      return;
    }
    await this.advance(job.id);
  }

  /** Lượt duyệt kết thúc mà chưa có kết luận (agent quên gọi công cụ hoặc lỗi): thử lại một lần. */
  handleReviewEnded(job, reviewTask) {
    if (reviewTask.verdict) return;
    const subject = this.store.getTask(reviewTask.subject_id);
    if (!subject || subject.status !== 'submitted') return;
    const attempts = this.store.jobTasks(job.id).filter((t) => t.kind === 'review' && t.subject_id === subject.id).length;
    if (attempts < 2) {
      this.r.log(subject.id, 'warn', 'Lượt duyệt kết thúc mà chưa có kết luận. Thử duyệt lại một lần.');
      this.r.createLeadTask({ kind: 'review', job, subject });
      this.r.schedule();
      return;
    }
    this.r.update(subject.id, {
      status: 'failed', failure_code: 'review_no_verdict', finished_at: Date.now(),
      error: 'Trưởng nhóm không đưa ra được kết luận sau hai lượt duyệt. Cần con người xem.',
    });
    this.r.log(subject.id, 'error', 'Trưởng nhóm không đưa ra được kết luận sau hai lượt duyệt.');
  }

  async stop(jobId, reason) {
    const job = this.store.getJob(jobId);
    if (!job || JOB_TERMINAL.includes(job.status)) return;
    this.store.updateJob(jobId, { status: 'stopped', error: reason, finished_at: Date.now() });
    if (job.epic_id) await this.r.epics.onJobFinished(this.store.getJob(jobId));
    for (const t of this.store.jobTasks(jobId)) {
      if (WORK_OPEN.includes(t.status)) {
        if (t.status === 'submitted') {
          this.r.update(t.id, { status: 'stopped', error: reason, finished_at: Date.now() });
        } else this.r.stop(t.id);
      }
    }
    this.r.emit('job', this.store.getJob(jobId));
    this.r.schedule();
  }

  finishJob(job, fields) {
    const updated = this.store.updateJob(job.id, { ...fields, finished_at: Date.now() });
    this.jobLog(job, 'job', `Việc lớn #${job.id}: ${updated.status}. ${shorten(updated.error ?? updated.summary ?? '', 300)}`);
    this.r.emit('job', updated);
    // Việc thuộc một yêu cầu: báo để yêu cầu mở khóa các việc phụ thuộc hoặc chuyển sang bước tiếp theo.
    if (job.epic_id) {
      this.r.epics.onJobFinished(updated).catch((err) => this.jobLog(job, 'error', `Lỗi khi cập nhật yêu cầu: ${err.message}`));
    }
    return updated;
  }

  /** Tính lại trạng thái việc lớn từ trạng thái các việc con; khi mọi việc đã xong thì gộp nhánh và báo cáo. */
  async advance(jobId) {
    const job = this.store.getJob(jobId);
    if (!job || JOB_TERMINAL.includes(job.status) || ['integrating', 'draft', 'waiting', 'awaiting_choice'].includes(job.status)) return;
    if (parseContest(job)) {
      await this.contests.progress(jobId);
      return;
    }
    const tasks = this.store.jobTasks(jobId);
    const plan = tasks.filter((t) => t.kind === 'plan').at(-1); // lượt mới nhất (chủ có thể đã cho lập kế hoạch lại)
    const work = tasks.filter((t) => t.kind === 'work');
    const planOpen = plan && LEAD_OPEN.includes(plan.status);
    const reviewOpen = tasks.some((t) => t.kind === 'review' && LEAD_OPEN.includes(t.status));
    const workOpen = work.some((t) => WORK_OPEN.includes(t.status));

    if (planOpen || reviewOpen || workOpen) {
      const next = planOpen && work.length === 0 ? 'planning' : 'running';
      if (job.status !== next) this.r.emit('job', this.store.updateJob(jobId, { status: next }));
      return;
    }
    if (work.length === 0) {
      const why = plan?.status === 'failed' ? `Trưởng nhóm gặp lỗi khi lập kế hoạch: ${shorten(plan.error ?? '', 300)}` : `Trưởng nhóm không chia ra việc nào. ${shorten(plan?.result ?? '', 300)}`;
      this.finishJob(job, { status: 'failed', error: why });
      return;
    }
    const approved = work.filter((t) => t.status === 'done');
    const bad = work.filter((t) => t.status !== 'done');
    if (approved.length === 0) {
      this.finishJob(job, { status: 'failed', error: 'Không có việc con nào được duyệt.', summary: this.buildSummary(job, tasks) });
      return;
    }

    this.store.updateJob(jobId, { status: 'integrating' });
    this.r.emit('job', this.store.getJob(jobId));
    let result;
    try {
      result = await integrateBranches({
        projectRoot: this.r.cfg.projectRoot, worktreesDir: this.r.cfg.worktreesDir, name: `job${jobId}`,
        baseCommit: job.base_commit, branches: approved.map((t) => t.branch),
      });
    } catch (err) {
      this.finishJob(job, { status: 'attention', error: `Không gộp được nhánh: ${err.message}`, summary: this.buildSummary(job, tasks) });
      return;
    }
    const summary = this.buildSummary(job, tasks);
    if (!result.ok) {
      this.finishJob(job, {
        status: 'attention', summary, conflict_files: JSON.stringify(result.conflictFiles),
        error: `Xung đột khi gộp nhánh ${result.failedBranch}. File xung đột: ${result.conflictFiles.join(', ') || '(không rõ)'}. Các nhánh đã gộp được: ${result.merged.join(', ') || 'không có'}.`,
      });
      return;
    }
    const fields = { summary, merge_branch: result.branch, merge_worktree: result.dir };
    if (bad.length || plan?.status === 'failed') {
      this.finishJob(job, { ...fields, status: 'attention', error: `${bad.length} việc con chưa đạt hoặc bị dừng: ${bad.map((t) => `#${t.id}`).join(', ')}. Phần đã được duyệt đã gộp vào nhánh ${result.branch}.` });
    } else {
      this.finishJob(job, { ...fields, status: 'done' });
    }
  }

  buildSummary(job, tasks) {
    const work = tasks.filter((t) => t.kind === 'work');
    const lines = [`Việc lớn #${job.id}: ${job.title}`, ''];
    for (const t of work) {
      const files = (() => {
        try {
          return JSON.parse(t.changed_files ?? '[]');
        } catch {
          return [];
        }
      })();
      const state = t.status === 'done' ? 'đã duyệt' : t.status;
      lines.push(`- #${t.id} ${t.member}: ${t.title} — ${state}${t.revisions ? `, bị trả ${t.revisions} lần` : ''}, ${files.length} file, ${t.turns} lượt, model ${t.model}`);
    }
    const sum = (key) => tasks.reduce((n, t) => n + (t[key] ?? 0), 0);
    lines.push('', `Tổng cộng ${tasks.length} lượt chạy (gồm kế hoạch và duyệt bài): token ra ${sum('output_tokens')}, token cache ${sum('cache_read_tokens') + sum('cache_creation_tokens')}, ước tính giá API $${sum('est_cost_usd').toFixed(3)} (bạn dùng gói Pro nên không bị tính khoản này).`);
    return lines.join('\n');
  }

  // ---------- Câu lệnh cho Trưởng nhóm ----------

  buildPlanPrompt(job, team) {
    const lines = [
      `# Việc lớn #${job.id}: ${job.title}`,
      `team_id: ${team.id}`,
      '',
      job.prompt,
    ];
    if (job.acceptance?.trim()) lines.push('', '## Tiêu chí hoàn thành của cả việc lớn', job.acceptance.trim());
    if (parseContest(job)) {
      lines.push(
        '',
        '## Đây là cuộc THI ĐẤU SKILL (không chia việc)',
        'Chủ công ty muốn so sánh hai cách làm trên CÙNG một sản phẩm. Đừng chia nhỏ và đừng dùng assign_to_member.',
        '- Gọi get_team_workload, chọn đúng HAI nhân viên còn chỗ và có thế mạnh phù hợp.',
        '- Viết MỘT đề bài đầy đủ và gọi assign_contest đúng một lần: cả hai người nhận cùng đề bài, cùng tiêu chí, làm độc lập trên hai nhánh riêng.',
        '- Đề bài phải đủ cụ thể để hai bản so sánh được với nhau (trang nào, thành phần nào, dữ liệu mẫu nào), nhưng KHÔNG gợi ý phong cách thiết kế, màu sắc hay cách trình bày: đó chính là thứ đem ra so sánh.',
        '- Hệ thống tự gán ngẫu nhiên bộ skill cho từng người và ẩn danh khi chủ xem; bạn không biết và không cần biết ai dùng bộ nào.',
        '- "files" là thư mục/file mà CẢ HAI cùng sửa (được phép trùng nhau). Kết thúc bằng một đoạn tóm tắt ngắn.',
      );
    } else {
      lines.push(
        '',
        '## Tải hiện tại của team',
        this.renderWorkload(team),
        '',
        `Hãy đọc code liên quan, chia việc lớn này thành tối đa ${team.limits.max_subtasks} việc con độc lập và giao từng việc bằng công cụ assign_to_member.`,
      );
    }
    return lines.join('\n');
  }

  async buildReviewPrompt(job, subject) {
    const diff = subject.branch
      ? await branchDiff({ projectRoot: this.r.cfg.projectRoot, baseCommit: subject.base_commit ?? job.base_commit, branch: subject.branch })
      : { stat: '', patch: '', truncated: false };
    return [
      `# Duyệt bài nộp: việc #${subject.id} "${subject.title}"`,
      `task_id: ${subject.id}`,
      `Người nộp: ${subject.member}. Số lần đã trả bài: ${subject.revisions}.`,
      '',
      `## Việc lớn #${job.id}: ${job.title}`,
      shorten(job.prompt, 1500),
      '',
      '## Yêu cầu của việc con',
      subject.prompt,
      subject.acceptance?.trim() ? `\n### Tiêu chí hoàn thành\n${subject.acceptance.trim()}` : '',
      '',
      '## Phạm vi file đã định',
      parseFiles(subject.files).join(', ') || '(không ghi)',
      '',
      '## Báo cáo của nhân viên',
      subject.result ?? '(không có báo cáo)',
      '',
      '## Thay đổi (so với mã gốc)',
      diff.stat || '(không có thay đổi)',
      '',
      '```diff',
      diff.patch,
      '```',
      '',
      `Thư mục hiện tại là nhánh của ${subject.member}; bạn có thể đọc file ở đây để kiểm tra thêm. Hãy kết luận bằng một lần gọi review_submission.`,
    ].join('\n');
  }
}

export function buildLeadSystemPrompt({ member, team, role, project, kind }) {
  const parts = [`Bạn là ${member.name}, ${role.title} của ${team.name} trong một công ty phần mềm.`];
  if (role.body) parts.push(role.body);
  if (project) {
    const lines = ['## Hồ sơ dự án'];
    if (project.name) lines.push(`- Tên: ${project.name}`);
    if (project.stack.length) lines.push(`- Công nghệ: ${project.stack.join(', ')}`);
    const own = project.folders[team.id];
    if (own?.length) lines.push(`- Thư mục của team bạn (chỉ giao việc trong đây, nhân viên không sửa được chỗ khác): ${describeFolders(own)}`);
    else if (team.requiresFolders) lines.push('- Hồ sơ chưa khai thư mục cho team bạn: nhân viên không ghi được file nào, đừng giao việc con mà hãy báo chủ dự án.');
    for (const [id, list] of Object.entries(project.folders).filter(([id, l]) => id !== team.id && l.length)) lines.push(`- Thư mục của team ${id} (không giao việc ở đây): ${describeFolders(list)}`);
    const commands = Object.entries(project.commands);
    if (commands.length) lines.push(`- Lệnh: ${commands.map(([k, v]) => `${k} = ${v}`).join('; ')}`);
    const failLine = knownFailuresLine(project);
    if (failLine) lines.push(failLine);
    if (project.conventions) lines.push(`- Quy ước:\n${project.conventions}`);
    parts.push(lines.join('\n'));
  }

  if (kind === 'plan') {
    parts.push(
      [
        '## Cách lập kế hoạch',
        '- Đọc code liên quan trước, rồi gọi get_team_workload để biết ai còn chỗ.',
        `- Chia thành tối đa ${team.limits.max_subtasks} việc con. Mỗi việc con giao cho đúng MỘT người bằng assign_to_member. Chọn người theo thế mạnh và tải hiện tại.`,
        '- Các việc con chạy SONG SONG, nên chúng phải độc lập: khai báo "files" (file hoặc thư mục sẽ sửa) và các việc con KHÔNG được chồng lấn nhau. Nếu việc B cần kết quả của việc A thì đừng chia thành hai việc, hãy giao cả hai cho cùng một người.',
        '- Mỗi việc con phải tự chứa đủ thông tin để làm mà không cần hỏi lại: file nào, hành vi mong muốn, ràng buộc, cách kiểm tra. Tiêu chí hoàn thành phải kiểm chứng được (ví dụ "npm test chạy qua và có test cho X").',
        '- Có thể ghi "level": easy cho việc cơ học nhỏ, hard cho việc cần suy nghĩ sâu (thiết kế, schema, xác thực, lỗi khó). Không chắc thì bỏ trống để hệ thống tự đánh giá.',
        '- Một việc nhỏ làm gọn được bởi một người thì giao một việc con, đừng chia vụn: mỗi lượt chạy đều tốn hạn mức.',
        '- Nếu một lần giao bị từ chối (người đó đủ việc, trùng phạm vi), đọc lý do và điều chỉnh. Đừng giao lặp lại cùng một việc.',
        '- Nếu mô tả việc có "Hợp đồng chung", đó chỉ là tham chiếu: nó mô tả cả phần của các team khác. Chỉ chia phần việc của team bạn; đừng giao việc thuộc team khác.',
        '- Bạn không tự viết code. Khi đã giao xong, kết thúc bằng một đoạn tóm tắt ngắn kế hoạch (ai làm gì).',
        '- Không có người trực tiếp để hỏi. Thiếu thông tin thì chọn phương án hợp lý nhất và ghi rõ giả định trong mô tả việc con.',
      ].join('\n'),
    );
  } else {
    parts.push(
      [
        '## Cách duyệt bài',
        '- Đọc yêu cầu, tiêu chí, báo cáo và thay đổi (diff). Có thể đọc thêm file trong thư mục hiện tại (nhánh của nhân viên), dùng git diff, git log, git show, git status, và chạy lệnh test của dự án để tự kiểm chứng báo cáo.',
        '- Mỗi lần chỉ chạy MỘT lệnh Bash, không nối bằng &&, ; hay |, và không dùng cd (thư mục hiện tại đã là nhánh cần xem). Lệnh nối nhiều phần sẽ bị từ chối.',
        '- Kiểm tra: đúng yêu cầu và tiêu chí, có test cho phần mới, không sửa ngoài phạm vi, không lộ bí mật, bám quy ước của dự án, báo cáo trung thực (đã chạy test thật chưa).',
        '- Kết luận bằng ĐÚNG MỘT lần gọi review_submission. approve nếu đạt. reject kèm nhận xét cụ thể và làm theo được, nêu từng điểm cần sửa.',
        '- Đừng trả bài vì sở thích cá nhân hay chuyện nhỏ không ảnh hưởng. Số lần được trả bài có hạn, nên chỉ trả khi thật sự chưa đạt.',
        '- Bạn không tự sửa code.',
      ].join('\n'),
    );
  }
  parts.push('Trả lời bằng tiếng Việt.');
  return parts.join('\n\n');
}
