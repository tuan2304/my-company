import { describeFolders } from './path-guard.mjs';
import { UserError } from './errors.mjs';
import { shorten } from './guard.mjs';
import { findMember, workersOf } from './teams.mjs';
import { checkRepo, integrateBranches, resolveRef } from './worktree.mjs';
import { knownFailuresLine } from './project.mjs';

/**
 * Yêu cầu của chủ giao cho cả công ty:
 *   Chủ giao yêu cầu → Giám đốc lập kế hoạch (hợp đồng chung + việc cho từng team, có phụ thuộc)
 *   → [Chủ duyệt kế hoạch] → các team làm (Backend và Frontend song song, Chất lượng sau) → ghép kết quả
 *   → Giám đốc kiểm tra (được giao làm lại tối đa một đợt) → [Chủ duyệt kết quả] → hoàn thành.
 * Mỗi việc cho một team chính là một "việc lớn" (jobs.mjs), chạy theo luồng của giai đoạn 2.
 */

const EPIC_TERMINAL = ['done', 'attention', 'failed', 'stopped', 'rejected'];
const JOB_OPEN = ['draft', 'waiting', 'planning', 'running', 'integrating'];
const MAX_JOBS = 6;
const MAX_REPLANS = 2;
export const MAX_REWORK_ROUNDS = 1;

/** Yêu cầu còn "mở" hoặc vừa kết thúc ở lỗi/cần xem thì mới cứu được một việc lớn của nó. */
const EPIC_RESCUE_STATUSES = ['running', 'attention', 'failed'];

/**
 * Việc lớn nằm trong một yêu cầu có mở lại để cứu được không? Trả về lý do nếu không (chuỗi), hoặc null nếu được.
 * Dùng chung cho việc mở lại việc lớn, lập kế hoạch lại và xử lý việc con lỗi.
 */
export function epicJobRescueBlock(store, job) {
  const epic = job.epic_id ? store.getEpic(job.epic_id) : null;
  if (!epic) return 'không còn yêu cầu chứa nó nên không mở lại được.';
  if (!EPIC_RESCUE_STATUSES.includes(epic.status)) {
    return `thuộc yêu cầu #${epic.id} (đang "${epic.status}") nên chưa mở lại riêng được; chỉ mở lại khi yêu cầu đang chạy, cần xem hoặc lỗi.`;
  }
  if (job.round !== epic.round) return `thuộc đợt làm lại cũ của yêu cầu #${epic.id} nên không mở lại được.`;
  return null;
}

export class Epics {
  /** @param {import('./runner.mjs').Runner} runner */
  constructor(runner) {
    this.r = runner;
  }

  get store() {
    return this.r.store;
  }

  // ---------- Cấu hình ----------

  /** Giám đốc: người đứng đầu một team mà vai trò của họ là "director". */
  directorOf() {
    for (const team of this.r.getTeams()) {
      const lead = team.members.find((m) => m.name === team.lead);
      if (lead && team.roles[lead.role]?.id === 'director') return findMember(this.r.getTeams(), team.lead);
    }
    return null;
  }

  /** Các team nhận việc: có Trưởng nhóm và ít nhất một nhân viên, không phải ban giám đốc. */
  workTeams() {
    return this.r.getTeams().filter((t) => {
      const lead = t.members.find((m) => m.name === t.lead);
      return lead && t.roles[lead.role]?.id !== 'director' && workersOf(t).length > 0;
    });
  }

  epicOf(task) {
    const epic = task.epic_id ? this.store.getEpic(task.epic_id) : null;
    if (!epic) throw new UserError('Không tìm thấy yêu cầu của lượt làm việc này.');
    return epic;
  }

  log(epic, kind, text) {
    if (epic.plan_task_id) this.r.log(epic.plan_task_id, kind, text);
  }

  update(id, fields) {
    const updated = this.store.updateEpic(id, fields);
    this.r.emit('epic', updated);
    return updated;
  }

  // ---------- Tạo yêu cầu ----------

  async create({ title, prompt, acceptance = '' }) {
    const cleanTitle = String(title ?? '').trim();
    const cleanPrompt = String(prompt ?? '').trim();
    if (!cleanTitle) throw new UserError('Thiếu tiêu đề yêu cầu.');
    if (!cleanPrompt) throw new UserError('Thiếu mô tả yêu cầu.');
    if (cleanTitle.length > 200 || cleanPrompt.length > 20_000 || String(acceptance).length > 10_000) {
      throw new UserError('Nội dung yêu cầu quá dài.');
    }
    const director = this.directorOf();
    if (!director) throw new UserError('Chưa có Giám đốc trong cấu hình (cần một team có Trưởng nhóm mang vai trò "director").');
    if (this.workTeams().length === 0) throw new UserError('Chưa có team nào có Trưởng nhóm và nhân viên để nhận việc.');
    let baseCommit;
    try {
      baseCommit = await checkRepo(this.r.cfg.projectRoot);
    } catch (err) {
      throw new UserError(err.message, { cause: err });
    }
    const epic = this.store.createEpic({ title: cleanTitle, prompt: cleanPrompt, acceptance: String(acceptance), director: director.member.name, baseCommit });
    const plan = this.r.createDirectorTask({ kind: 'dplan', epic });
    const updated = this.update(epic.id, { plan_task_id: plan.id });
    this.r.log(plan.id, 'job', `Yêu cầu #${epic.id} "${epic.title}" giao cho Giám đốc ${director.member.name}.`);
    this.r.schedule();
    return updated;
  }

  // ---------- Công cụ của Giám đốc ----------

  describeOverview(task) {
    const epic = this.epicOf(task);
    const blocks = this.workTeams().map((team) => {
      const lead = findMember(this.r.getTeams(), team.lead);
      return [
        `## ${team.name} (id: ${team.id}, Trưởng nhóm ${team.lead}, model ${lead.role.model})`,
        team.description ? `Phạm vi: ${team.description}` : '',
        this.r.jobs.renderWorkload(team),
        `Giới hạn: mỗi người ${team.limits.max_active_per_member} việc đang làm + ${team.limits.max_queue_per_member} chờ; tối đa ${team.limits.max_subtasks} việc con mỗi việc lớn.`,
      ].filter(Boolean).join('\n');
    });
    const jobs = this.store.epicJobs(epic.id);
    const lines = jobs.length ? jobs.map((j) => `- #${j.id} [${j.team}] "${j.title}" (${j.status}${j.depends_on ? `, phụ thuộc ${j.depends_on}` : ''})`).join('\n') : '(chưa có việc nào)';
    return `${blocks.join('\n\n')}\n\n## Các việc đã tạo cho yêu cầu này (round ${epic.round})\n${lines}`;
  }

  setContract(task, args) {
    const epic = this.epicOf(task);
    if (epic.status !== 'planning') throw new UserError('Chỉ chốt hợp đồng được khi đang lập kế hoạch.');
    const text = String(args.contract ?? '').trim();
    if (text.length < 20) throw new UserError('Hợp đồng quá ngắn. Hãy nêu cụ thể: đường dẫn, phương thức, dữ liệu vào ra, mã lỗi.');
    if (text.length > 20_000) throw new UserError('Hợp đồng quá dài (tối đa 20.000 ký tự).');
    this.update(epic.id, { contract: text });
    this.log(epic, 'job', `Giám đốc đã chốt hợp đồng chung (${text.length} ký tự).`);
    return 'Đã lưu hợp đồng chung. Nó sẽ được đính kèm vào mọi việc của các team.';
  }

  async createTeamJob(task, args) {
    const epic = this.epicOf(task);
    const rework = task.kind === 'dreview';
    if (rework) {
      if (epic.status !== 'reviewing') throw new UserError('Bạn đã giao việc làm lại hoặc đã kết thúc yêu cầu, không giao thêm được nữa.');
      if (epic.round >= MAX_REWORK_ROUNDS) throw new UserError('Đã dùng hết lượt làm lại cho yêu cầu này. Hãy kết thúc bằng finish_epic.');
    } else if (epic.status !== 'planning') {
      throw new UserError('Chỉ giao việc cho team được khi đang lập kế hoạch.');
    }

    const wanted = String(args.team ?? '').trim().toLowerCase();
    const team = this.workTeams().find((t) => t.id.toLowerCase() === wanted || t.name.toLowerCase() === wanted);
    if (!team) throw new UserError(`Không có team "${args.team}". Các team: ${this.workTeams().map((t) => `${t.id} (${t.name})`).join(', ')}.`);
    const title = String(args.title ?? '').trim();
    const description = String(args.description ?? '').trim();
    if (!title || !description) throw new UserError('Thiếu title hoặc description.');
    if (title.length > 200 || description.length > 20_000) throw new UserError('title hoặc description quá dài.');

    const jobs = this.store.epicJobs(epic.id);
    if (jobs.length >= MAX_JOBS) throw new UserError(`Yêu cầu đã có ${jobs.length} việc cho team, bằng mức tối đa (${MAX_JOBS}).`);
    if (jobs.some((j) => j.title.trim().toLowerCase() === title.toLowerCase())) throw new UserError(`Đã có việc tên "${title}" trong yêu cầu này.`);

    const dependsOn = [];
    for (const dep of Array.isArray(args.depends_on) ? args.depends_on : []) {
      const found = jobs.find((j) => j.title.trim().toLowerCase() === String(dep).trim().toLowerCase());
      if (!found) throw new UserError(`depends_on: không có việc nào tên "${dep}". Hãy tạo việc đó trước, rồi mới khai phụ thuộc vào nó.`);
      dependsOn.push(found.id);
    }

    const round = rework ? epic.round + 1 : 0;
    const job = this.r.jobs.createDraft({
      epic, team, title, description, acceptance: String(args.acceptance ?? ''), dependsOn,
      baseRef: rework ? epic.merge_branch : null, baseDir: rework ? epic.merge_worktree : null, round,
    });
    if (rework) {
      this.update(epic.id, { round, status: 'running', verdict: null });
      this.log(epic, 'job', `Giám đốc giao việc làm lại #${job.id} cho ${team.name}: ${title}`);
      if (!dependsOn.length) await this.r.jobs.start(job.id);
    } else {
      this.log(epic, 'job', `Giám đốc lập kế hoạch: việc #${job.id} cho ${team.name}: ${title}${dependsOn.length ? ` (chờ ${dependsOn.map((d) => `#${d}`).join(', ')})` : ''}.`);
    }
    return `Đã tạo việc #${job.id} "${title}" cho ${team.name}${dependsOn.length ? `, chỉ bắt đầu sau khi ${dependsOn.map((d) => `#${d}`).join(', ')} xong` : ''}${rework ? ' và bắt đầu ngay' : ', sẽ chạy khi chủ duyệt kế hoạch'}.`;
  }

  finish(task, args) {
    const epic = this.epicOf(task);
    if (epic.status !== 'reviewing') throw new UserError('Không kết thúc được lúc này (đã giao việc làm lại hoặc yêu cầu đã kết thúc).');
    if (epic.verdict) throw new UserError('Bạn đã kết luận rồi.');
    const verdict = String(args.verdict ?? '');
    if (!['accept', 'attention'].includes(verdict)) throw new UserError('verdict phải là "accept" hoặc "attention".');
    const report = String(args.report ?? '').trim();
    if (report.length < 10) throw new UserError('Hãy viết báo cáo cho chủ (ngắn, rõ): đã làm gì, kiểm chứng ra sao, còn gì dang dở.');
    this.update(epic.id, { verdict, final_report: report });
    this.log(epic, 'job', `Giám đốc kết luận: ${verdict === 'accept' ? 'đạt, chờ chủ duyệt' : 'cần chủ xem'}.`);
    return verdict === 'accept' ? 'Đã ghi nhận kết luận. Báo cáo sẽ được gửi cho chủ duyệt.' : 'Đã ghi nhận. Yêu cầu được đánh dấu cần chủ xem.';
  }

  // ---------- Vòng đời ----------

  /** Gọi sau khi một lượt của Giám đốc (lập kế hoạch hoặc kiểm tra) kết thúc hoặc bị dừng. */
  async afterChange(taskId) {
    const task = this.store.getTask(taskId);
    const epic = task?.epic_id ? this.store.getEpic(task.epic_id) : null;
    if (!epic || EPIC_TERMINAL.includes(epic.status)) return;

    if (task.status === 'stopped') {
      await this.stop(epic.id, 'Yêu cầu bị dừng theo yêu cầu.');
      return;
    }
    if (!['done', 'failed'].includes(task.status)) return;

    if (task.kind === 'dplan' && epic.status === 'planning') {
      const drafts = this.store.epicJobs(epic.id).filter((j) => ['draft', 'waiting'].includes(j.status));
      if (task.status === 'failed' && drafts.length === 0) {
        this.finishEpic(epic, { status: 'failed', error: `Giám đốc gặp lỗi khi lập kế hoạch: ${shorten(task.error ?? '', 300)}` });
      } else if (drafts.length === 0) {
        this.finishEpic(epic, { status: 'failed', error: `Giám đốc không chia ra việc nào cho các team. ${shorten(task.result ?? '', 300)}` });
      } else {
        this.update(epic.id, { status: 'awaiting_plan', plan_summary: task.result ?? '' });
        this.log(epic, 'job', `Kế hoạch đã sẵn sàng (${drafts.length} việc cho team). Chờ chủ duyệt.`);
      }
    } else if (task.kind === 'dreview' && epic.status !== 'running') {
      // Nếu Giám đốc đã giao việc làm lại thì trạng thái là "running" và các việc đó đang chạy.
      if (epic.verdict === 'accept') {
        this.update(epic.id, { status: 'awaiting_result' });
        this.log(epic, 'job', 'Giám đốc đã kiểm tra xong. Chờ chủ duyệt kết quả.');
      } else if (epic.verdict === 'attention') {
        this.finishEpic(epic, { status: 'attention', error: `Giám đốc đánh giá chưa đạt: ${shorten(epic.final_report ?? '', 400)}` });
      } else {
        // subject_id của lượt kiểm tra ghi đợt làm lại mà nó thuộc về (xem runner.createDirectorTask).
        const reviews = this.store.epicTasks(epic.id).filter((t) => t.kind === 'dreview' && t.subject_id === epic.round).length;
        if (reviews < 2) {
          this.log(epic, 'warn', 'Lượt kiểm tra của Giám đốc kết thúc mà chưa có kết luận. Thử lại một lần.');
          this.r.createDirectorTask({ kind: 'dreview', epic });
          this.r.schedule();
        } else {
          this.finishEpic(epic, { status: 'attention', error: 'Giám đốc không đưa ra được kết luận sau hai lượt kiểm tra. Cần chủ xem.' });
        }
      }
    }
  }

  /** Chủ duyệt kế hoạch: bắt đầu các việc chưa phụ thuộc, các việc còn lại chờ. */
  async approvePlan(id) {
    const epic = this.store.getEpic(id);
    if (!epic) throw new UserError('Không có yêu cầu này.');
    if (epic.status !== 'awaiting_plan') throw new UserError('Yêu cầu không ở trạng thái chờ duyệt kế hoạch.');
    this.update(id, { status: 'running', plan_feedback: null });
    this.log(epic, 'job', 'Chủ đã duyệt kế hoạch. Các team bắt đầu làm.');
    for (const job of this.store.epicJobs(id)) {
      if (job.status === 'draft') await this.r.jobs.start(job.id);
    }
    return this.store.getEpic(id);
  }

  /** Chủ từ chối kế hoạch kèm nhận xét: Giám đốc lập lại (làm tiếp đúng phiên cũ). */
  rejectPlan(id, feedback) {
    const epic = this.store.getEpic(id);
    if (!epic) throw new UserError('Không có yêu cầu này.');
    if (epic.status !== 'awaiting_plan') throw new UserError('Yêu cầu không ở trạng thái chờ duyệt kế hoạch.');
    const text = String(feedback ?? '').trim();
    if (text.length < 5) throw new UserError('Hãy ghi nhận xét để Giám đốc biết cần sửa kế hoạch thế nào.');
    if (epic.replans >= MAX_REPLANS) throw new UserError(`Kế hoạch đã được lập lại ${MAX_REPLANS} lần. Hãy dừng yêu cầu này và viết lại mô tả rõ hơn.`);
    this.store.deleteUnstartedJobs(id);
    this.update(id, { status: 'planning', plan_feedback: text, replans: epic.replans + 1, contract: null });
    const previous = this.store.epicTasks(id).filter((t) => t.kind === 'dplan').at(-1);
    const plan = this.r.createDirectorTask({ kind: 'dplan', epic: this.store.getEpic(id), feedback: text, session: previous?.session_id ?? null });
    this.log(epic, 'job', `Chủ từ chối kế hoạch: ${shorten(text, 300)}. Giám đốc lập lại (lần ${epic.replans + 1}/${MAX_REPLANS}).`);
    this.r.log(plan.id, 'job', 'Giám đốc lập lại kế hoạch theo nhận xét của chủ.');
    this.r.schedule();
    return this.store.getEpic(id);
  }

  approveResult(id) {
    const epic = this.store.getEpic(id);
    if (!epic) throw new UserError('Không có yêu cầu này.');
    if (epic.status !== 'awaiting_result') throw new UserError('Yêu cầu không ở trạng thái chờ duyệt kết quả.');
    this.log(epic, 'job', 'Chủ đã duyệt kết quả. Yêu cầu hoàn thành.');
    return this.finishEpic(epic, { status: 'done', error: null });
  }

  rejectResult(id, feedback) {
    const epic = this.store.getEpic(id);
    if (!epic) throw new UserError('Không có yêu cầu này.');
    if (epic.status !== 'awaiting_result') throw new UserError('Yêu cầu không ở trạng thái chờ duyệt kết quả.');
    const text = String(feedback ?? '').trim();
    this.log(epic, 'job', `Chủ không duyệt kết quả${text ? `: ${shorten(text, 300)}` : ''}.`);
    return this.finishEpic(epic, { status: 'rejected', result_feedback: text, error: text ? `Chủ không duyệt: ${shorten(text, 300)}` : 'Chủ không duyệt kết quả.' });
  }

  finishEpic(epic, fields) {
    const updated = this.update(epic.id, { ...fields, finished_at: Date.now() });
    this.log(epic, 'job', `Yêu cầu #${epic.id}: ${updated.status}. ${shorten(updated.error ?? '', 300)}`);
    return updated;
  }

  async stop(id, reason) {
    const epic = this.store.getEpic(id);
    if (!epic || EPIC_TERMINAL.includes(epic.status)) return epic;
    this.update(id, { status: 'stopped', error: reason, finished_at: Date.now() });
    for (const t of this.store.epicTasks(id)) {
      if (['queued', 'running', 'paused_quota', 'waiting_answer'].includes(t.status)) this.r.stop(t.id);
    }
    for (const job of this.store.epicJobs(id)) {
      if (!['done', 'attention', 'failed', 'stopped'].includes(job.status)) await this.r.jobs.stop(job.id, reason);
    }
    return this.store.getEpic(id);
  }

  /** Một việc của team vừa kết thúc: mở khóa các việc phụ thuộc, hoặc báo lỗi dây chuyền, rồi xem yêu cầu đã xong chưa. */
  async onJobFinished(job) {
    const epic = job.epic_id ? this.store.getEpic(job.epic_id) : null;
    if (!epic || EPIC_TERMINAL.includes(epic.status)) return;
    const jobs = this.store.epicJobs(epic.id);
    const done = new Set(jobs.filter((j) => j.status === 'done').map((j) => j.id));

    if (job.status === 'done') {
      for (const waiting of jobs.filter((j) => j.status === 'waiting')) {
        const deps = JSON.parse(waiting.depends_on ?? '[]');
        if (deps.every((d) => done.has(d))) await this.r.jobs.start(waiting.id);
      }
    } else {
      for (const waiting of jobs.filter((j) => j.status === 'waiting')) {
        const deps = JSON.parse(waiting.depends_on ?? '[]');
        if (deps.includes(job.id)) {
          this.r.jobs.finishJob(waiting, { status: 'failed', error: `Việc #${job.id} "${job.title}" mà việc này phụ thuộc không hoàn thành (${job.status}).` });
        }
      }
    }
    await this.evaluate(epic.id);
  }

  // ---------- Chủ cứu yêu cầu lỗi ----------

  /**
   * Mở lại yêu cầu để cứu một việc lớn của nó (xử lý việc con lỗi, hoặc cho Trưởng nhóm lập kế hoạch lại).
   * Yêu cầu quay về "đang chạy"; các việc đã bị đánh lỗi dây chuyền chỉ vì phụ thuộc vào việc này (chưa từng chạy) được cho chờ lại.
   * Đồng bộ (không await) để không lọt khe giữa lúc mở lại với lúc một việc khác kết thúc.
   */
  reopenForJob(job) {
    const blocked = epicJobRescueBlock(this.store, job);
    if (blocked) throw new UserError(`Việc lớn #${job.id} ${blocked}`);
    const epic = this.store.getEpic(job.epic_id);
    if (epic.status !== 'running') {
      this.update(epic.id, { status: 'running', error: null, summary: null, conflict_files: null, finished_at: null });
      this.log(epic, 'job', `Chủ mở lại yêu cầu #${epic.id} để cứu việc lớn #${job.id}.`);
    }
    // Việc phụ thuộc (kể cả gián tiếp) bị đánh lỗi dây chuyền thì chưa từng có kế hoạch riêng (plan_task_id rỗng): cho chờ lại.
    const reset = new Set([job.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const other of this.store.epicJobs(epic.id)) {
        if (reset.has(other.id) || other.status !== 'failed' || other.plan_task_id !== null) continue;
        const deps = JSON.parse(other.depends_on ?? '[]');
        if (deps.some((d) => reset.has(d))) {
          reset.add(other.id);
          grew = true;
          this.r.emit('job', this.store.updateJob(other.id, { status: 'waiting', error: null, summary: null, finished_at: null }));
        }
      }
    }
  }

  /** Mở lại yêu cầu để Giám đốc chạy lại một lượt: "dplan" (yêu cầu đang lỗi) hoặc "dreview" (cần xem vì chưa kết luận được). */
  reopenForDirector(epicId, kind) {
    const epic = this.store.getEpic(epicId);
    if (!epic) throw new UserError('Không có yêu cầu này.');
    if (kind === 'dplan') {
      if (epic.status !== 'failed') throw new UserError('Chỉ chạy lại lượt lập kế hoạch khi yêu cầu đang ở trạng thái lỗi.');
      this.update(epicId, { status: 'planning', error: null, finished_at: null });
      this.log(epic, 'job', 'Chủ cho Giám đốc lập kế hoạch lại.');
    } else {
      if (epic.status !== 'attention' || epic.verdict) throw new UserError('Chỉ chạy lại lượt kiểm tra khi Giám đốc chưa kết luận được.');
      this.update(epicId, { status: 'reviewing', error: null, finished_at: null });
      this.log(epic, 'job', 'Chủ cho Giám đốc kiểm tra lại.');
    }
  }

  /**
   * Bỏ phần lỗi, cho Giám đốc kiểm tra phần đã có: ghép các việc đã xong (và phần đã duyệt của việc "cần xem") rồi chuyển Giám đốc.
   * Khác `evaluate` thường ở chỗ không đòi mọi việc đều xong.
   */
  async proceed(id) {
    const epic = this.store.getEpic(id);
    if (!epic) throw new UserError('Không có yêu cầu này.');
    if (!['attention', 'failed'].includes(epic.status)) throw new UserError('Chỉ làm được khi yêu cầu đang ở trạng thái cần xem hoặc lỗi.');
    const jobs = this.store.epicJobs(id);
    if (jobs.some((j) => JOB_OPEN.includes(j.status))) throw new UserError('Vẫn còn việc đang chạy.');
    if (this.usableJobs(epic, jobs).length === 0) throw new UserError('Chưa có việc nào có kết quả để cho Giám đốc kiểm tra.');
    this.update(id, { status: 'running', error: null, summary: null, conflict_files: null, finished_at: null });
    this.log(epic, 'job', 'Chủ quyết định bỏ phần lỗi, cho Giám đốc kiểm tra phần đã có.');
    await this.evaluate(id, { partial: true });
    return this.store.getEpic(id);
  }

  /** Việc của đợt hiện tại có kết quả để ghép: đã xong, hoặc "cần xem" nhưng đã gộp được phần đã duyệt. */
  usableJobs(epic, jobs) {
    return jobs.filter((j) => j.round === epic.round && ['done', 'attention'].includes(j.status) && j.merge_branch);
  }

  /** Mọi việc của team đã kết thúc: không đạt thì báo chủ, đạt thì ghép kết quả và giao Giám đốc kiểm tra. */
  async evaluate(epicId, { partial = false } = {}) {
    const epic = this.store.getEpic(epicId);
    if (!epic || epic.status !== 'running') return;
    const jobs = this.store.epicJobs(epicId);
    if (jobs.some((j) => JOB_OPEN.includes(j.status))) return;

    const bad = jobs.filter((j) => j.status !== 'done');
    if (bad.length && !partial) {
      this.finishEpic(epic, {
        status: 'attention', summary: this.buildSummary(epic, jobs),
        error: `${bad.length} việc của team chưa đạt hoặc bị dừng: ${bad.map((j) => `#${j.id} "${shorten(j.title, 40)}" (${j.status})`).join(', ')}.`,
      });
      return;
    }

    // Đặt trạng thái ngay (đồng bộ) để lần gọi song song khác không ghép lần nữa.
    this.update(epicId, { status: 'integrating' });
    const round = epic.round;
    const name = round === 0 ? `epic${epicId}` : `epic${epicId}-r${round}`;
    let result;
    try {
      const baseCommit = round === 0 ? epic.base_commit : await resolveRef(this.r.cfg.projectRoot, epic.merge_branch);
      result = await integrateBranches({
        projectRoot: this.r.cfg.projectRoot, worktreesDir: this.r.cfg.worktreesDir, name, baseCommit,
        branches: (partial ? this.usableJobs(epic, jobs) : jobs.filter((j) => j.round === round)).map((j) => j.merge_branch).filter(Boolean),
      });
    } catch (err) {
      this.finishEpic(epic, { status: 'attention', summary: this.buildSummary(epic, jobs), error: `Không ghép được kết quả các team: ${err.message}` });
      return;
    }
    const summary = this.buildSummary(epic, jobs);
    if (!result.ok) {
      this.finishEpic(epic, {
        status: 'attention', summary, conflict_files: JSON.stringify(result.conflictFiles),
        error: `Xung đột khi ghép kết quả các team (nhánh ${result.failedBranch}). File xung đột: ${result.conflictFiles.join(', ') || '(không rõ)'}.`,
      });
      return;
    }
    this.update(epicId, { status: 'reviewing', merge_branch: result.branch, merge_worktree: result.dir, summary });
    this.log(epic, 'job', `Đã ghép kết quả các team vào nhánh ${result.branch}. Giám đốc kiểm tra.`);
    this.r.createDirectorTask({ kind: 'dreview', epic: this.store.getEpic(epicId) });
    this.r.schedule();
  }

  buildSummary(epic, jobs) {
    const lines = [`Yêu cầu #${epic.id}: ${epic.title}`, ''];
    for (const j of jobs) {
      lines.push(`- Việc #${j.id} (${j.team}${j.round ? `, làm lại đợt ${j.round}` : ''}): ${j.title} — ${j.status}${j.merge_branch ? `, nhánh ${j.merge_branch}` : ''}`);
    }
    const tasks = [...jobs.flatMap((j) => this.store.jobTasks(j.id)), ...this.store.epicTasks(epic.id)];
    const sum = (key) => tasks.reduce((n, t) => n + (t[key] ?? 0), 0);
    lines.push('', `Tổng cộng ${tasks.length} lượt chạy: token ra ${sum('output_tokens')}, token cache ${sum('cache_read_tokens') + sum('cache_creation_tokens')}, ước tính giá API $${sum('est_cost_usd').toFixed(3)} (bạn dùng gói Pro nên không bị tính khoản này).`);
    return lines.join('\n');
  }

  // ---------- Câu lệnh cho Giám đốc ----------

  buildPlanPrompt(epic, feedback) {
    const lines = [`# Yêu cầu #${epic.id}: ${epic.title}`, `epic_id: ${epic.id}`, '', epic.prompt];
    if (epic.acceptance?.trim()) lines.push('', '## Tiêu chí hoàn thành của cả yêu cầu', epic.acceptance.trim());
    if (feedback) lines.push('', '## Nhận xét của chủ về kế hoạch trước (bắt buộc sửa theo)', feedback);
    lines.push('', 'Hãy đọc code liên quan, gọi get_company_overview, rồi lập kế hoạch: chốt hợp đồng chung bằng set_contract (nếu việc cắt ngang nhiều team) và giao việc cho từng team bằng create_team_job.');
    return lines.join('\n');
  }

  buildReviewPrompt(epic) {
    const jobs = this.store.epicJobs(epic.id);
    const lines = [
      `# Kiểm tra kết quả của yêu cầu #${epic.id}: ${epic.title}`,
      `epic_id: ${epic.id}`,
      `Đợt làm lại đã dùng: ${epic.round} (tối đa ${MAX_REWORK_ROUNDS}).`,
      '',
      '## Yêu cầu gốc của chủ',
      epic.prompt,
      epic.acceptance?.trim() ? `\n### Tiêu chí hoàn thành\n${epic.acceptance.trim()}` : '',
      '',
    ];
    if (epic.contract) lines.push('## Hợp đồng chung đã chốt', epic.contract, '');
    lines.push('## Kết quả từng việc của team');
    for (const j of jobs) {
      const workers = this.store.jobTasks(j.id).filter((t) => t.kind === 'work' && t.status === 'done');
      lines.push(`### Việc #${j.id} (${j.team}${j.round ? `, đợt ${j.round}` : ''}): ${j.title} — ${j.status}`);
      if (j.status !== 'done') {
        lines.push('(Việc này KHÔNG hoàn chỉnh: chủ đã quyết định bỏ phần lỗi để kiểm tra phần còn lại. Chỉ kiểm tra phần đã ghép, và nêu rõ trong báo cáo phần nào còn thiếu.)');
      }
      for (const w of workers) lines.push(`- Báo cáo của ${w.member} cho "${shorten(w.title, 80)}": ${shorten(w.result ?? '(không có)', 700)}`);
    }
    lines.push('', `Mã nguồn đã ghép nằm ở thư mục hiện tại (nhánh ${epic.merge_branch}). Hãy tự đọc code và chạy lệnh test của dự án để kiểm chứng, rồi kết luận.`);
    return lines.join('\n');
  }
}

export function buildDirectorSystemPrompt({ member, team, role, project, kind }) {
  const parts = [`Bạn là ${member.name}, ${role.title} của ${team.name} trong một công ty phần mềm.`];
  if (role.body) parts.push(role.body);
  if (project) {
    const lines = ['## Hồ sơ dự án'];
    if (project.name) lines.push(`- Tên: ${project.name}`);
    if (project.stack.length) lines.push(`- Công nghệ: ${project.stack.join(', ')}`);
    for (const [id, list] of Object.entries(project.folders).filter(([, l]) => l.length)) lines.push(`- Thư mục của ${id}: ${describeFolders(list)}`);
    const commands = Object.entries(project.commands);
    if (commands.length) lines.push(`- Lệnh: ${commands.map(([k, v]) => `${k} = ${v}`).join('; ')}`);
    const failLine = knownFailuresLine(project);
    if (failLine) lines.push(failLine);
    if (project.conventions) lines.push(`- Quy ước:\n${project.conventions}`);
    parts.push(lines.join('\n'));
  }

  if (kind === 'dplan') {
    parts.push(
      [
        '## Cách lập kế hoạch',
        '- Đọc code liên quan, rồi gọi get_company_overview để biết các team và tải của họ.',
        '- Chia yêu cầu thành các việc cho từng TEAM bằng create_team_job. Phạm vi của từng team (và việc nào nên chờ việc nào) nằm trong kết quả get_company_overview: đọc kỹ rồi chỉ giao cho team thật sự cần. Bạn không giao cho từng người: Trưởng nhóm của team sẽ tự chia nhỏ cho nhân viên.',
        '- Nếu yêu cầu cắt ngang Backend và Frontend: TRƯỚC HẾT gọi set_contract với hợp đồng cụ thể (đường dẫn và phương thức của API, dữ liệu vào ra dạng JSON, mã lỗi, quy tắc xác thực, quy ước đặt tên). Backend làm đúng theo hợp đồng; Frontend dùng dữ liệu giả theo hợp đồng nên hai team làm SONG SONG, không phải chờ nhau.',
        '- Việc của team cần kết quả ĐÃ GHÉP của team khác (test tích hợp của Chất lượng, rà soát của Bảo mật, quy trình CI/CD của DevOps nếu phụ thuộc code mới) phải khai "depends_on" là tiêu đề các việc cần chờ (phải tạo các việc đó trước). Ngược lại, việc thiết kế giao diện của team Thiết kế nên làm TRƯỚC, và việc của Frontend khai depends_on nó.',
        '- Mỗi việc cho team phải đủ rõ để Trưởng nhóm chia nhỏ mà không cần hỏi lại: mục tiêu, phạm vi (thư mục/file), ràng buộc, tiêu chí hoàn thành kiểm chứng được. Đừng mô tả quá chi tiết từng dòng code.',
        '- Chỉ tạo việc cho team khi thật sự cần. Mỗi việc đều tốn hạn mức, và tối đa 6 việc.',
        '- Bạn không tự viết code. Khi xong, kết thúc bằng một đoạn tóm tắt kế hoạch ngắn, rõ cho chủ duyệt: hợp đồng chính, team nào làm gì, thứ tự phụ thuộc.',
        '- Không có người trực tiếp để hỏi. Thiếu thông tin thì chọn phương án hợp lý nhất và ghi giả định vào kế hoạch.',
        '- Mỗi lần chỉ chạy MỘT lệnh Bash, không nối bằng &&, ; hay | và không dùng cd.',
      ].join('\n'),
    );
  } else {
    parts.push(
      [
        '## Cách kiểm tra kết quả',
        '- Đọc yêu cầu gốc, hợp đồng, báo cáo của từng team. Mã đã ghép nằm ở thư mục hiện tại: tự đọc code, dùng git diff/log/show/status và chạy lệnh test của dự án để kiểm chứng, đừng chỉ tin báo cáo.',
        '- Nếu đạt: gọi finish_epic với verdict "accept" và báo cáo cho chủ.',
        '- Nếu phát hiện lỗi cụ thể cần sửa và còn lượt làm lại: giao việc sửa bằng create_team_job (nêu rõ lỗi, cách tái hiện, mong đợi). Việc đó bắt đầu ngay trên mã đã ghép. Bạn chỉ có MỘT đợt làm lại, và khi đã giao việc sửa thì KHÔNG gọi finish_epic trong lượt này.',
        '- Nếu chưa đạt mà không còn lượt làm lại: gọi finish_epic với verdict "attention" và nêu rõ lỗi còn lại.',
        '- Báo cáo cho chủ bằng tiếng Việt, ngắn gọn: đã làm gì và team nào làm, kiểm chứng thế nào, điều còn dang dở hoặc rủi ro.',
        '- Bạn không tự sửa code. Mỗi lần chỉ chạy MỘT lệnh Bash, không nối bằng &&, ; hay | và không dùng cd.',
      ].join('\n'),
    );
  }
  parts.push('Trả lời bằng tiếng Việt.');
  return parts.join('\n\n');
}
