import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS, toolsForKind } from './agent-tools.mjs';
import { buildDirectorSystemPrompt, Epics } from './epics.mjs';
import { getEngine } from './engines/index.mjs';
import { UserError } from './errors.mjs';
import { maskSecrets, shorten } from './guard.mjs';
import { describeFolders } from './path-guard.mjs';
import { buildLeadSystemPrompt, Jobs } from './jobs.mjs';
import { looksLikeQuotaText, nextRetryAt, parseRateLimitEvent } from './quota.mjs';
import { ANSWER_MAX_TURNS, Questions } from './questions.mjs';
import { composeSkillPack } from './skills.mjs';
import { knownFailuresLine } from './project.mjs';
import { findMember } from './teams.mjs';
import { nextTier, triageTask } from './triage.mjs';
import { checkRepo, commitWorktree, createWorktree } from './worktree.mjs';

export { UserError };
// Tham số dòng lệnh là việc của engine; giữ các tên cũ ở đây để mã và test hiện có vẫn import được từ runner.
export { buildAllowedTools, buildAnswerArgs, buildClaudeArgs, buildGuardSettings, buildLeadArgs } from './engines/claude.mjs';

/**
 * Độ khó của việc (mục 3.8): việc cần suy nghĩ thì dùng model cao, việc đơn giản dùng model thấp
 * cho nhanh và đỡ tốn hạn mức. "normal" giữ model và mức suy luận của vai trò. Mặc định là "auto":
 * hệ thống tự đánh giá (triage.mjs); người dùng chỉ cần chọn tay khi muốn ép một mức.
 */
export const LEVELS = {
  easy: { model: 'haiku', effort: 'low', label: 'Đơn giản' },
  normal: { model: null, effort: null, label: 'Bình thường' },
  hard: { model: 'opus', effort: 'high', label: 'Khó' },
};

/** Công nghệ trong hồ sơ dự án có khớp với khóa (như "supabase") không? Dùng chung cho skill và ghi chú. */
export function stackMatches(project, key) {
  const wanted = String(key).toLowerCase();
  return (project?.stack ?? []).some((s) => s.toLowerCase().includes(wanted));
}

export function buildSystemPrompt({ member, team, role, project, canAsk = false, skills = [], skillMode = 'tool' }) {
  const parts = [`Bạn là ${member.name}, ${role.title} của ${team.name} trong một công ty phần mềm.`];
  if (role.body) parts.push(role.body);
  const notes = Object.entries(role.stack_notes ?? {})
    .filter(([key]) => stackMatches(project, key))
    .map(([, text]) => String(text).trim())
    .filter(Boolean);
  if (notes.length) {
    parts.push(`## Quy tắc riêng của công ty cho công nghệ của dự án (ưu tiên hơn chỉ dẫn của skill)\n${notes.join('\n\n')}`);
  }

  if (project) {
    const lines = ['## Hồ sơ dự án'];
    if (project.name) lines.push(`- Tên: ${project.name}`);
    if (project.stack.length) lines.push(`- Công nghệ: ${project.stack.join(', ')}`);
    const own = project.folders[team.id];
    if (own?.length) lines.push(`- Thư mục thuộc team của bạn (chỉ sửa trong đây): ${describeFolders(own)}`);
    else if (team.requiresFolders) lines.push('- Hồ sơ chưa khai thư mục cho team của bạn nên bạn KHÔNG ghi được file nào. Nếu việc cần ghi file, hãy dừng và báo lại điều này.');
    const others = Object.entries(project.folders).filter(([id, list]) => id !== team.id && list.length);
    for (const [id, list] of others) lines.push(`- Thư mục của ${id} (không tự ý sửa): ${describeFolders(list)}`);
    const commands = Object.entries(project.commands);
    if (commands.length) lines.push(`- Lệnh: ${commands.map(([k, v]) => `${k} = ${v}`).join('; ')}`);
    const failLine = knownFailuresLine(project);
    if (failLine) lines.push(failLine);
    if (project.conventions) lines.push(`- Quy ước:\n${project.conventions}`);
    parts.push(lines.join('\n'));
  }

  if (skills.length && skillMode === 'native') {
    // Engine tự nạp skill từ thư mục làm việc (không có công cụ Skill để gọi theo tên).
    parts.push(
      [
        '## Skill của bạn',
        'Công ty đã nạp sẵn các skill sau cho bạn. Chúng là cách làm đã được duyệt, không phải gợi ý tùy chọn:',
        ...skills.map((s) => `- ${s}`),
        'Trước khi bắt tay làm, hãy đọc kỹ từng skill liên quan tới việc này rồi làm theo. ' +
          'Trước khi báo xong, dùng lại skill kiểm chứng/kiểm thử nếu có trong danh sách. Quy tắc riêng của công ty ở trên luôn được ưu tiên hơn chỉ dẫn của skill.',
      ].join('\n'),
    );
  } else if (skills.length) {
    parts.push(
      [
        '## Skill của bạn',
        'Công ty đã nạp sẵn các skill sau cho bạn. Chúng là cách làm đã được duyệt, không phải gợi ý tùy chọn:',
        ...skills.map((s) => `- company-skills:${s}`),
        'Trước khi bắt tay làm, hãy gọi công cụ Skill (tham số skill = tên đầy đủ ở trên, gồm cả tiền tố "company-skills:") cho từng skill liên quan tới việc này, đọc kỹ rồi làm theo. ' +
          'Trước khi báo xong, gọi lại skill kiểm chứng/kiểm thử nếu có trong danh sách. Quy tắc riêng của công ty ở trên luôn được ưu tiên hơn chỉ dẫn của skill.',
      ].join('\n'),
    );
  }

  parts.push(
    [
      '## Quy tắc bắt buộc',
      '- Bạn làm việc trong một nhánh git riêng ở thư mục hiện tại. Không push, không đổi nhánh, không thêm hay sửa remote.',
      '- Chỉ làm đúng phạm vi việc được giao. Không đọc, không in nội dung file .env, khóa bí mật hay khóa service_role.',
      '- Chỉ chạy các lệnh đã được cho phép. Nếu một lệnh bị từ chối thì không tìm cách lách, hãy báo lại trong phần "Điều còn dang dở".',
      '- Không tự commit: hệ thống sẽ commit thay đổi của bạn khi bạn xong.',
      canAsk
        ? '- Không có người trực tiếp ngồi cạnh bạn. Thiếu thông tin nhỏ thì chọn phương án hợp lý nhất, tiếp tục làm và ghi giả định vào "Điều còn dang dở". ' +
          'Chỉ khi VƯỚNG THẬT (đề bài mâu thuẫn, quyết định ảnh hưởng người khác, không đoán được từ code) mới dùng công cụ hỏi: ask_lead (Trưởng nhóm), ask_colleague (đồng nghiệp cùng team), call_meeting (họp ngắn) hoặc ask_owner (chính chủ công ty, người thật, chỉ cho quyết định lớn mà team không quyết thay được; kèm 2 đến 4 phương án). ' +
          'Tối đa 2 lần hỏi mỗi việc, câu hỏi tự chứa đủ bối cảnh. Hỏi xong thì KẾT THÚC lượt ngay bằng một câu ngắn: hệ thống gọi lại bạn cùng câu trả lời. Đừng hỏi để xin duyệt hay thăm dò.'
        : '- Không có người trực tiếp để hỏi lúc bạn làm việc. Nếu thiếu thông tin, chọn phương án hợp lý nhất, tiếp tục làm và ghi rõ giả định của bạn trong phần "Điều còn dang dở".',
      '- Khi xong, trả lời bằng tiếng Việt, đúng bốn mục: Đã làm / File thay đổi / Cách kiểm tra / Điều còn dang dở.',
    ].join('\n'),
  );
  return parts.join('\n\n');
}

/** Lời nhắc hệ thống cho lượt trả lời câu hỏi: ngắn, chỉ đọc, không mang vai trò viết code của người trả lời. */
export function buildAnswerSystemPrompt({ member, team, role, project }) {
  const parts = [`Bạn là ${member.name}, ${role.title} của ${team.name}. Một đồng nghiệp cùng team hỏi bạn một câu về công việc họ đang làm.`];
  if (member.strengths?.length) parts.push(`Thế mạnh của bạn: ${member.strengths.join(', ')}.`);
  if (project) {
    const lines = ['## Hồ sơ dự án'];
    if (project.name) lines.push(`- Tên: ${project.name}`);
    if (project.stack.length) lines.push(`- Công nghệ: ${project.stack.join(', ')}`);
    const failLine = knownFailuresLine(project);
    if (failLine) lines.push(failLine);
    if (project.conventions) lines.push(`- Quy ước:\n${project.conventions}`);
    parts.push(lines.join('\n'));
  }
  parts.push('Bạn chỉ đọc code và trả lời bằng tiếng Việt. Không sửa file, không chạy lệnh, không đọc file .env hay khóa bí mật.');
  return parts.join('\n\n');
}

export function buildTaskPrompt(task) {
  const lines = [`# Việc #${task.id}: ${task.title}`, '', task.prompt.trim()];
  if (task.acceptance?.trim()) lines.push('', '## Tiêu chí hoàn thành', task.acceptance.trim());
  return lines.join('\n');
}

export function guardEnv({ root, allow, mode }) {
  return {
    COMPANY_GUARD_ROOT: root,
    COMPANY_GUARD_ALLOW: JSON.stringify(allow ?? []),
    COMPANY_GUARD_MODE: mode,
  };
}

/**
 * Hệ số kéo dài số lượt và thời gian cho một lượt đã được nâng bậc hoặc được chủ cho chạy lại (phiên cũ đã dùng hết phần ban đầu):
 * mỗi lần thêm một nửa, tối đa gấp ba.
 */
export function stretchOf(task) {
  return Math.min(1 + 0.5 * ((task.escalations > 0 ? 1 : 0) + task.recoveries), 3);
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

function toolSummary(block) {
  const input = block.input ?? {};
  const detail = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? JSON.stringify(input);
  return `${block.name}: ${shorten(String(detail), 240)}`;
}

function textOfToolResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join(' ');
  return '';
}

export class Runner extends EventEmitter {
  /**
   * @param {{cfg: object, store: import('./db.mjs').Store, getTeams: () => object[], getProject: () => object|null}} deps
   */
  constructor({ cfg, store, getTeams, getProject }) {
    super();
    this.cfg = cfg;
    // Các engine đã liên kết theo thứ tự ưu tiên; this.engine là engine đầu tiên (mặc định). Mỗi lượt chạy dùng state.engine (xem engineFor).
    this.engines = (cfg.engines ?? [cfg.engine]).map((id) => getEngine({ engine: id }));
    this.engine = this.engines[0];
    this.engineBlocked = {}; // mã engine -> giờ (ms) engine đó hết hạn mức hoặc không dùng được tới lúc nào
    this.store = store;
    this.getTeams = getTeams;
    this.getProject = getProject;
    this.running = new Map();
    this.pausedUntil = 0;
    this.pauseReason = null;
    this.manualPause = false;
    this.wakeTimer = null;
    this.stopped = false;
    this.agentRuns = new Map(); // mã thông báo của một lượt chạy → số việc (xác thực công cụ MCP)
    this.apiUrl = null; // do máy chủ HTTP đặt sau khi nghe cổng; cầu nối MCP dùng để gọi lại
    this.jobs = new Jobs(this);
    this.epics = new Epics(this);
    this.questions = new Questions(this);
  }

  /** Gọi một lần khi khởi động: việc đang chạy dở (do máy chủ tắt) được xếp hàng lại. */
  recover() {
    for (const task of this.store.tasksByStatus('running')) {
      this.store.updateTask(task.id, { status: 'queued' });
      this.log(task.id, 'system', 'Máy chủ khởi động lại, việc được xếp hàng lại và sẽ làm tiếp.');
    }
    // Việc đang chờ câu trả lời: khớp với các lượt trả lời đã kết thúc trong lúc máy chủ tắt.
    this.questions.reconcile();
    // Danh sách engine do chủ chọn trên giao diện (nếu có) đè lên cấu hình; id không còn tồn tại thì bỏ qua.
    const saved = this.store.getState('engines', null);
    if (Array.isArray(saved) && saved.length) {
      try {
        this.applyEngines(saved);
      } catch {
        /* giữ danh sách theo cấu hình */
      }
    }
    const blocked = this.store.getState('engine_blocked', {});
    for (const [id, until] of Object.entries(blocked ?? {})) if (until > Date.now()) this.engineBlocked[id] = until;
    const resumeAt = this.store.getState('paused_until', 0);
    if (resumeAt > Date.now()) {
      this.pausedUntil = resumeAt;
      this.pauseReason = 'quota';
    }
  }

  start() {
    this.recover();
    this.schedule();
  }

  /** Dừng mọi tiến trình con và chờ chúng thoát hẳn (tối đa vài giây) trước khi đóng cơ sở dữ liệu. */
  async shutdown() {
    this.stopped = true;
    clearTimeout(this.wakeTimer);
    const states = [...this.running.values()];
    for (const state of states) {
      state.stopRequested = true;
      killTree(state.child);
    }
    const exits = Promise.all(states.map((s) => s.exited));
    const timeout = new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      timer.unref?.();
    });
    await Promise.race([exits, timeout]);
  }

  snapshot() {
    const queued = this.store.tasksByStatus('queued', 'paused_quota').length;
    return {
      maxConcurrent: this.cfg.maxConcurrent,
      running: [...this.running.keys()],
      queued,
      pausedUntil: this.pausedUntil > Date.now() ? this.pausedUntil : 0,
      pauseReason: this.pausedUntil > Date.now() ? this.pauseReason : null,
      manualPause: this.manualPause,
      engines: this.engines.map((e) => ({ id: e.id, label: e.label, blockedUntil: this.blockedUntil(e.id) })),
      rateLimit: this.store.getState('rate_limit'),
    };
  }

  log(taskId, kind, summary, raw = null) {
    const event = this.store.addEvent(taskId, kind, maskSecrets(summary), raw ? maskSecrets(raw).slice(0, 4000) : null);
    this.emit('event', event);
    return event;
  }

  update(taskId, fields) {
    const task = this.store.updateTask(taskId, fields);
    this.emit('task', task);
    return task;
  }

  emitState() {
    this.emit('state', this.snapshot());
  }

  /** Nhân viên còn chỗ nhận thêm việc không? Quá giới hạn tải thì báo lỗi (mục 3.3). */
  checkCapacity(found) {
    if (found.isLead) return;
    const { team, member } = found;
    const cap = team.limits.max_active_per_member + team.limits.max_queue_per_member;
    const open = this.store.openLoad(member.name);
    if (open.length >= cap) {
      throw new UserError(`${member.name} đang có ${open.length}/${cap} việc (đang làm hoặc chờ), không nhận thêm được.`);
    }
  }

  /** Bộ skill riêng của một bài dự thi (và các skill phải bỏ khỏi mặc định để hai bên chỉ khác nhau ở bộ skill). Việc thường thì rỗng. */
  contestSkills(task) {
    if (!task.skill_set) return {};
    let skillSet;
    try {
      skillSet = JSON.parse(task.skill_set);
    } catch {
      return {};
    }
    const sets = task.job_id ? JSON.parse(this.store.getJob(task.job_id)?.contest ?? 'null')?.sets : null;
    return { skillSet, excludeSkills: Object.values(sets ?? {}).flat() };
  }

  /** Tạo một việc "làm" cho nhân viên: dùng cho việc lẻ do bạn giao và việc con do Trưởng nhóm giao. */
  createWork({ found, title, prompt, acceptance = '', level = 'auto', jobId = null, files = null, skillSet = null }) {
    const auto = level === 'auto';
    const task = this.store.createTask({
      title,
      prompt,
      acceptance,
      team: found.team.id,
      member: found.member.name,
      role: found.role.id,
      // Với "auto", model tạm là mặc định của vai trò; bước đánh giá sẽ chọn lại trước khi làm việc.
      model: auto ? found.role.model : (LEVELS[level].model ?? found.role.model),
      effort: auto ? found.role.effort : (LEVELS[level].effort ?? found.role.effort),
      level,
      levelSource: auto ? 'auto' : 'user',
      jobId,
      files,
      skillSet,
    });
    this.log(
      task.id,
      'system',
      auto
        ? `Giao việc cho ${found.member.name} (${found.role.title}). Độ khó sẽ được hệ thống tự đánh giá.`
        : `Giao việc cho ${found.member.name} (${found.role.title}), độ khó ${LEVELS[level].label}: ${task.model}, suy luận ${task.effort}.`,
    );
    this.emit('task', task);
    return task;
  }

  /** Tạo lượt làm việc của Trưởng nhóm: "plan" (chia việc) hoặc "review" (duyệt một bài nộp). */
  createLeadTask({ kind, job, subject = null }) {
    const found = findMember(this.getTeams(), job.lead);
    if (!found) throw new UserError(`Không tìm thấy Trưởng nhóm "${job.lead}" trong cấu hình.`);
    const review = kind === 'review';
    const task = this.store.createTask({
      title: review ? `Duyệt bài #${subject.id}: ${subject.title}` : `Lập kế hoạch: ${job.title}`,
      prompt: review ? subject.prompt : job.prompt,
      acceptance: review ? subject.acceptance : job.acceptance,
      team: found.team.id,
      member: found.member.name,
      role: found.role.id,
      model: review ? found.role.review_model : found.role.model,
      effort: review ? found.role.review_effort : found.role.effort,
      level: 'normal',
      levelSource: 'user',
      kind,
      jobId: job.id,
      subjectId: subject?.id ?? null,
    });
    this.log(task.id, 'system', review ? `${found.member.name} sẽ duyệt bài của ${subject.member}.` : `${found.member.name} sẽ lập kế hoạch cho việc lớn.`);
    this.emit('task', task);
    return task;
  }

  /** Lượt làm việc của Giám đốc: "dplan" (lập kế hoạch cho yêu cầu) hoặc "dreview" (kiểm tra kết quả đã ghép). */
  createDirectorTask({ kind, epic, feedback = null, session = null }) {
    const found = findMember(this.getTeams(), epic.director);
    if (!found) throw new UserError(`Không tìm thấy Giám đốc "${epic.director}" trong cấu hình.`);
    const review = kind === 'dreview';
    let task = this.store.createTask({
      title: review ? `Kiểm tra kết quả: ${epic.title}` : `Giám đốc lập kế hoạch: ${epic.title}`,
      prompt: epic.prompt,
      acceptance: epic.acceptance,
      team: found.team.id,
      member: found.member.name,
      role: found.role.id,
      model: review ? found.role.review_model : found.role.model,
      effort: review ? found.role.review_effort : found.role.effort,
      level: 'normal',
      levelSource: 'user',
      kind,
      epicId: epic.id,
      // Ghi số đợt (kiểm tra) hoặc số lần lập lại (kế hoạch) để biết lượt này thuộc đợt nào.
      subjectId: review ? epic.round : epic.replans,
    });
    // Lập lại kế hoạch: làm tiếp đúng phiên cũ của Giám đốc kèm nhận xét của chủ.
    if (feedback || session) task = this.store.updateTask(task.id, { review_feedback: feedback, session_id: session });
    this.log(task.id, 'system', review ? `${found.member.name} sẽ kiểm tra kết quả đã ghép.` : `${found.member.name} sẽ lập kế hoạch cho yêu cầu.`);
    this.emit('task', task);
    return task;
  }

  /** Nhận một việc lẻ cho một nhân viên. Báo lỗi ngay nếu tên, dự án hoặc tải không hợp lệ. */
  async submit({ title, prompt, acceptance = '', member, level = 'auto' }) {
    if (level !== 'auto' && !Object.hasOwn(LEVELS, level)) {
      throw new UserError(`Độ khó "${level}" không hợp lệ. Chọn auto (tự đánh giá), easy, normal hoặc hard.`);
    }
    const cleanTitle = String(title ?? '').trim();
    const cleanPrompt = String(prompt ?? '').trim();
    if (!cleanTitle) throw new UserError('Thiếu tiêu đề việc.');
    if (!cleanPrompt) throw new UserError('Thiếu mô tả việc.');
    if (cleanTitle.length > 200 || cleanPrompt.length > 20_000 || String(acceptance).length > 10_000) {
      throw new UserError('Nội dung việc quá dài.');
    }
    const found = findMember(this.getTeams(), member);
    if (!found) throw new UserError(`Không có nhân viên tên "${member}".`);
    if (found.isLead) {
      throw new UserError(`${found.member.name} là Trưởng nhóm, chỉ nhận việc lớn của cả team (Trưởng nhóm không tự viết code). Hãy giao việc lớn cho team, hoặc giao việc lẻ cho một nhân viên.`);
    }
    try {
      await checkRepo(this.cfg.projectRoot);
    } catch (err) {
      throw new UserError(err.message, { cause: err });
    }
    this.checkCapacity(found);
    const task = this.createWork({ found, title: cleanTitle, prompt: cleanPrompt, acceptance: String(acceptance), level });
    this.schedule();
    return task;
  }

  /** Thực thi một lệnh gọi công cụ MCP của Trưởng nhóm. Trả về null nếu mã thông báo không hợp lệ. */
  async callAgentTool(token, name, args) {
    const taskId = this.agentRuns.get(token);
    const task = taskId ? this.store.getTask(taskId) : null;
    if (!task) return null;
    const def = TOOLS[name];
    if (!def || !def.kinds.includes(task.kind)) {
      return { isError: true, text: `Công cụ "${name}" không dùng được trong lượt làm việc này.` };
    }
    try {
      return { isError: false, text: await def.run({ jobs: this.jobs, epics: this.epics, questions: this.questions }, task, args ?? {}) };
    } catch (err) {
      if (err instanceof UserError || err.constructor?.name === 'JobError') return { isError: true, text: err.message };
      throw err;
    }
  }

  setManualPause(value) {
    this.manualPause = Boolean(value);
    this.emitState();
    if (!this.manualPause) this.schedule();
  }

  // ---- Nhiều engine (xoay vòng) ----

  applyEngines(ids) {
    const engines = ids.map((id) => getEngine({ engine: id }));
    this.engines = engines;
    this.engine = engines[0];
    this.cfg.engines = engines.map((e) => e.id);
    this.cfg.engine = this.engine.id;
  }

  /** Chủ đổi danh sách engine đã liên kết (và thứ tự ưu tiên) trên giao diện. Việc đang chạy giữ engine của nó tới khi xong. */
  setEngines(ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
    if (list.length === 0) throw new UserError('Phải liên kết ít nhất một engine.');
    try {
      this.applyEngines(list);
    } catch (err) {
      throw new UserError(err.message);
    }
    this.store.setState('engines', list);
    this.emitState();
    this.schedule();
  }

  /** Engine này có làm được loại lượt này không? Lượt của Trưởng nhóm/Giám đốc cần công cụ MCP của công ty. */
  engineCanRun(engine, task) {
    return task.kind === 'work' || task.kind === 'answer' || engine.capabilities.mcp;
  }

  blockedUntil(id, now = Date.now()) {
    const until = this.engineBlocked[id] ?? 0;
    return until > now ? until : 0;
  }

  blockEngine(id, until) {
    this.engineBlocked[id] = until;
    const live = Object.fromEntries(Object.entries(this.engineBlocked).filter(([, t]) => t > Date.now()));
    this.store.setState('engine_blocked', live);
  }

  /** Giờ sớm nhất mà có engine dùng lại được, nếu MỌI engine đã liên kết đều đang bị chặn; không thì 0. */
  allBlockedUntil(now = Date.now()) {
    const times = this.engines.map((e) => this.blockedUntil(e.id, now));
    return times.every((t) => t > 0) ? Math.min(...times) : 0;
  }

  /**
   * Engine sẽ chạy một việc. Việc đã có phiên trên engine nào thì ưu tiên engine đó (làm tiếp được); engine đó đang bị chặn
   * thì chuyển sang engine kế còn hạn mức. Không engine nào làm được loại lượt này thì trả engine mặc định để launch báo lỗi rõ.
   * Có engine làm được nhưng tất cả đang bị chặn thì trả { engine: null, waitUntil } để việc chờ.
   */
  engineFor(task, now = Date.now()) {
    const capable = this.engines.filter((e) => this.engineCanRun(e, task));
    if (capable.length === 0) return { engine: this.engine, waitUntil: 0 };
    const free = capable.filter((e) => !this.blockedUntil(e.id, now));
    if (free.length === 0) return { engine: null, waitUntil: Math.min(...capable.map((e) => this.blockedUntil(e.id, now))) };
    const sticky = task.session_id && task.engine ? free.find((e) => e.id === task.engine) : null;
    return { engine: sticky ?? free[0], waitUntil: 0 };
  }

  pauseCompany({ until, reason }) {
    this.pausedUntil = until;
    this.pauseReason = reason;
    this.store.setState('paused_until', until);
    this.emitState();
  }

  schedule() {
    if (this.stopped) return;
    clearTimeout(this.wakeTimer);
    const now = Date.now();
    if (this.manualPause) return this.emitState();

    let wakeAt = 0;
    if (this.pausedUntil > now) {
      wakeAt = this.pausedUntil;
    } else {
      if (this.pausedUntil) {
        this.pausedUntil = 0;
        this.pauseReason = null;
        this.store.setState('paused_until', 0);
      }
      const busy = new Set([...this.running.values()].map((s) => s.member));
      // Lượt của Trưởng nhóm (lập kế hoạch, duyệt bài) được ưu tiên để việc không bị tắc ở khâu duyệt.
      const priority = (t) => (t.kind === 'work' ? 1 : 0);
      const candidates = this.store.tasksByStatus('queued', 'paused_quota').sort((a, b) => priority(a) - priority(b) || a.id - b.id);
      for (const task of candidates) {
        if (this.running.size >= this.cfg.maxConcurrent) break;
        // Lượt trả lời câu hỏi ngắn và chỉ đọc nên không phải chờ người được hỏi rảnh tay (nếu không, người hỏi sẽ chờ cả một việc dài).
        const answering = task.kind === 'answer';
        if (this.running.has(task.id) || (!answering && busy.has(task.member))) continue;
        if (task.resume_at && task.resume_at > now) {
          wakeAt = wakeAt ? Math.min(wakeAt, task.resume_at) : task.resume_at;
          continue;
        }
        const pick = this.engineFor(task, now);
        if (!pick.engine) {
          wakeAt = wakeAt ? Math.min(wakeAt, pick.waitUntil) : pick.waitUntil;
          continue;
        }
        if (!answering) busy.add(task.member);
        this.launch(task).catch((err) => this.fail(task.id, `Lỗi nội bộ: ${err.message}`));
      }
    }
    if (wakeAt) {
      const delay = Math.min(Math.max(wakeAt - Date.now() + 500, 1000), 2 ** 31 - 1);
      this.wakeTimer = setTimeout(() => this.schedule(), delay);
      this.wakeTimer.unref?.();
    }
    this.emitState();
  }

  fail(taskId, message, code = 'internal') {
    const state = this.running.get(taskId);
    if (state) {
      clearTimeout(state.timer);
      if (state.token) this.agentRuns.delete(state.token);
      state.resolveExit?.();
    }
    this.running.delete(taskId);
    this.update(taskId, { status: 'failed', error: maskSecrets(message), failure_code: code, finished_at: Date.now() });
    this.log(taskId, 'error', message);
    this.notifyJobs(taskId);
    this.schedule();
  }

  /** Báo cho bộ điều phối việc lớn biết một việc vừa đổi trạng thái (không chặn luồng gọi). */
  notifyJobs(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) return Promise.resolve();
    // Câu hỏi giữa nhân viên: lượt trả lời kết thúc thì ghi kết cục; người hỏi kết thúc hẳn thì hủy câu hỏi còn mở.
    try {
      if (task.kind === 'answer') this.questions.afterAnswerEnds(task);
      else if (task.kind === 'work' && ['done', 'failed', 'stopped'].includes(task.status)) this.questions.cancelFor(task.id);
    } catch (err) {
      this.log(taskId, 'error', `Lỗi khi xử lý câu hỏi giữa nhân viên: ${err.message}`);
    }
    let run = Promise.resolve();
    if (task.epic_id) run = this.epics.afterChange(taskId);
    else if (task.job_id) run = this.jobs.afterChange(taskId);
    return run.catch((err) => this.log(taskId, 'error', `Lỗi khi cập nhật việc lớn hoặc yêu cầu: ${err.message}`));
  }

  async launch(task) {
    const found = findMember(this.getTeams(), task.member);
    if (!found) return this.fail(task.id, `Không còn nhân viên "${task.member}" trong cấu hình team.`, 'no_member');
    const { team, member, role } = found;
    const project = this.getProject();
    const pick = this.engineFor(task);
    if (!pick.engine) {
      // Mọi engine làm được việc này đều đang hết hạn mức: chờ (schedule sẽ thử lại khi một engine hồi).
      this.update(task.id, { status: 'paused_quota', resume_at: pick.waitUntil });
      this.schedule();
      return undefined;
    }
    const state = {
      engine: pick.engine, member: member.name, child: null, stopRequested: false, timedOut: false, quota: null, result: null,
      stderrTail: '', timer: null, token: null,
    };
    state.exited = new Promise((resolve) => {
      state.resolveExit = resolve;
    });
    this.running.set(task.id, state);

    // Việc chuyển từ engine khác sang (hết hạn mức): phiên cũ không dùng lại được giữa hai hãng, nên bắt đầu phiên mới
    // trên cùng thư mục làm việc và dặn bàn giao trong lời nhắc.
    const previous = task.handoff_from || task.engine;
    const switched = Boolean(previous) && previous !== state.engine.id;
    const resume = Boolean(task.session_id) && !switched;
    task = this.update(task.id, {
      engine: state.engine.id,
      handoff_from: null,
      ...(switched ? { session_id: null } : {}),
      status: 'running',
      attempts: task.attempts + 1,
      resume_at: null,
      started_at: task.started_at ?? Date.now(),
      model: task.model || role.model,
      effort: task.effort || role.effort,
    });
    this.emitState();

    const runDir = path.join(this.cfg.dataDir, 'runs', String(task.id));
    fs.mkdirSync(runDir, { recursive: true });

    if (task.kind === 'answer') return this.launchAnswer({ task, found, project, state, resume, runDir });
    if (task.kind !== 'work') return this.launchLead({ task, found, project, state, resume, runDir });

    // Tự đánh giá độ khó một lần cho việc chưa có độ khó (xem triage.mjs).
    if (task.level === 'auto') {
      this.log(task.id, 'system', 'Đang tự đánh giá độ khó của việc...');
      const verdict = await triageTask({
        cfg: this.cfg, engine: state.engine, task, role, project, cwd: runDir,
        onChild: (child) => {
          state.child = child;
        },
      });
      state.child = null;
      const chosen = LEVELS[verdict.level];
      const u = verdict.usage ?? {};
      task = this.update(task.id, {
        level: verdict.level,
        level_reason: verdict.reason,
        model: chosen.model ?? role.model,
        effort: chosen.effort ?? role.effort,
        input_tokens: task.input_tokens + (u.input_tokens ?? 0),
        output_tokens: task.output_tokens + (u.output_tokens ?? 0),
        cache_read_tokens: task.cache_read_tokens + (u.cache_read_input_tokens ?? 0),
        cache_creation_tokens: task.cache_creation_tokens + (u.cache_creation_input_tokens ?? 0),
        est_cost_usd: task.est_cost_usd + verdict.costUsd,
      });
      this.log(task.id, 'triage', `Độ khó: ${chosen.label} → ${task.model} (suy luận ${task.effort}). ${verdict.reason}`);
    }
    if (this.abortIfStopped(task.id, state)) return undefined;
    // Model và mức suy luận của riêng việc này đè lên mặc định của vai trò. Việc đã được nâng bậc hoặc được chủ
    // cho làm tiếp thì cho thêm số lượt và thời gian (mỗi lần thêm một nửa, tối đa gấp ba) vì phiên cũ đã dùng hết phần ban đầu.
    const stretch = stretchOf(task);
    const runRole = {
      ...role,
      model: task.model,
      effort: task.effort,
      max_turns: Math.ceil(role.max_turns * stretch),
      timeout_minutes: Math.ceil(role.timeout_minutes * stretch),
    };

    if (!task.worktree) {
      const wt = await createWorktree({
        projectRoot: this.cfg.projectRoot,
        worktreesDir: this.cfg.worktreesDir,
        member: member.name,
        taskId: task.id,
        links: project?.worktreeLinks,
        baseCommit: task.job_id ? this.store.getJob(task.job_id)?.base_commit ?? undefined : undefined,
      });
      task = this.update(task.id, { worktree: wt.dir, branch: wt.branch, base_commit: wt.baseCommit });
      this.log(task.id, 'system', `Tạo nhánh riêng ${wt.branch} tại ${wt.dir}${wt.linked.length ? ` (nối ${wt.linked.join(', ')} từ dự án)` : ''}`);
    }

    // Công cụ hỏi người khác (qua MCP). Không có địa chỉ API (chạy ngoài máy chủ) thì nhân viên làm việc như cũ, không hỏi được.
    const canAsk = Boolean(this.apiUrl) && state.engine.capabilities.mcp;
    let mcpConfigFile = null;
    const askTools = canAsk ? toolsForKind('work').map((t) => t.name) : [];
    if (canAsk) {
      const token = crypto.randomBytes(24).toString('hex');
      state.token = token;
      this.agentRuns.set(token, task.id);
      mcpConfigFile = path.join(runDir, 'mcp.json');
      fs.writeFileSync(
        mcpConfigFile,
        JSON.stringify({
          mcpServers: {
            company: {
              command: process.execPath,
              args: [path.join(this.cfg.toolDir, 'server', 'mcp-bridge.mjs')],
              env: { COMPANY_API_URL: this.apiUrl, COMPANY_RUN_TOKEN: token },
            },
          },
        }, null, 2),
      );
    }

    // Hook chặn cứng file ngoài phạm vi: nhân viên chỉ sửa được trong thư mục của team (nếu hồ sơ có khai).
    const settingsFile = path.join(runDir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(state.engine.guardSettings(path.join(this.cfg.toolDir, 'server', 'path-guard.mjs')), null, 2));
    const allow = project?.folders?.[team.id] ?? [];
    // Team chỉ ghi tài liệu (requires_folders): chưa khai thư mục thì không ghi được gì, thay vì ghi được mọi nơi.
    const guardMode = team.requiresFolders ? 'scoped' : 'worker';

    const pack = composeSkillPack({
      libraryDir: path.join(this.cfg.skillsDir, 'library'),
      lockFile: path.join(this.cfg.toolDir, 'skills.lock'),
      role,
      project,
      outDir: path.join(runDir, 'plugin'),
      ...this.contestSkills(task),
    });
    if (pack.loaded.length) this.log(task.id, 'system', `Skill nạp: ${pack.loaded.join(', ')}`);
    for (const s of pack.skipped) this.log(task.id, 'system', `Bỏ qua skill ${s.name}: ${s.reason}`);

    // Viết system prompt sau khi biết skill nào thật sự được nạp, để dặn agent dùng đúng các skill đó.
    const systemFile = path.join(runDir, 'system.md');
    fs.writeFileSync(systemFile, buildSystemPrompt({ member, team, role, project, canAsk, skills: pack.loaded, skillMode: state.engine.skillMode }), 'utf8');

    const args = state.engine.taskArgs({
      task, role: runRole, project, systemFile, pluginDir: pack.dir, resume, settingsFile, mcpConfigFile, mcpTools: askTools,
    });
    const feedback = task.review_feedback?.trim();
    let prompt;
    if (feedback && resume) {
      prompt = `Trưởng nhóm đã xem bài nộp của bạn và trả lại để sửa. Nhận xét:\n\n${feedback}\n\nHãy sửa đúng các điểm này, chạy lại test và lint, rồi báo cáo lại theo đúng bốn mục (Đã làm / File thay đổi / Cách kiểm tra / Điều còn dang dở).`;
    } else if (resume) {
      prompt = 'Hãy tiếp tục công việc đang làm dở và hoàn thành nó theo đúng yêu cầu ban đầu.';
    } else if (feedback) {
      prompt = `${buildTaskPrompt(task)}\n\n## Nhận xét của Trưởng nhóm về lần nộp trước (cần sửa)\n${feedback}`;
    } else {
      prompt = buildTaskPrompt(task);
    }
    if (feedback) this.update(task.id, { review_feedback: null });
    if (switched && task.worktree) {
      const from = this.engines.find((e) => e.id === previous)?.label ?? previous;
      prompt = `${prompt}

## Bàn giao từ engine khác
Lần chạy trước do ${from} làm nhưng bị dừng vì hết hạn mức. Phần đang dở có thể đã nằm sẵn trong thư mục làm việc hiện tại (file đã sửa, chưa commit). Hãy xem hiện trạng thư mục (đọc các file liên quan; nếu được phép chạy git status thì dùng) rồi làm tiếp phần còn thiếu, không làm lại từ đầu.`;
      this.log(task.id, 'system', `Chuyển từ ${from} sang ${state.engine.label}: làm tiếp trên cùng thư mục làm việc (phiên cũ không dùng lại được giữa hai engine).`);
    }
    // Lời dặn của chủ khi cho làm tiếp hoặc làm lại một việc đã lỗi.
    const guidance = task.owner_guidance?.trim();
    if (guidance) {
      prompt = `${prompt}\n\n## Lời dặn của chủ công ty (lần làm trước của việc này bị dừng vì lỗi, hãy làm theo lời dặn)\n${guidance}`;
      this.update(task.id, { owner_guidance: null });
    }

    if (this.abortIfStopped(task.id, state)) return undefined;
    // Câu trả lời cho câu hỏi đã gửi (nếu có) đi kèm lời nhắc. Chỉ đánh dấu "đã giao" sau khi chắc chắn sắp chạy.
    const answers = this.questions.deliveryPrompt(task.id);
    if (answers) {
      prompt = resume && !feedback ? answers : `${prompt}\n\n${answers}`;
      this.log(task.id, 'system', 'Làm tiếp cùng câu trả lời cho câu hỏi đã gửi.');
    }
    this.log(task.id, 'system', feedback ? `Làm lại theo nhận xét của Trưởng nhóm (lần ${task.revisions}).` : resume ? 'Làm tiếp phiên trước (--resume).' : 'Bắt đầu làm việc.');
    // Engine không có cờ dòng lệnh cho hook chặn file, skill, lời nhắc hệ thống... thì tự đặt chúng vào thư mục làm việc (prepare).
    const prepared = state.engine.prepare?.({
      cwd: task.worktree, runDir, readonly: false, guardMode, root: task.worktree, allow, prompt,
      commands: role.tools.includes('Bash') ? project?.allowedCommands ?? [] : [],
      systemText: fs.readFileSync(systemFile, 'utf8'), skillsDir: pack.dir,
    });
    this.track(task, state, {
      cwd: prepared?.cwd ?? task.worktree,
      args: [...args, ...(prepared?.args ?? [])],
      prompt: prepared ? '' : prompt,
      env: { ...state.engine.env(), ...guardEnv({ root: task.worktree, allow, mode: guardMode }) },
      timeoutMinutes: runRole.timeout_minutes,
      maxTurns: state.engine.capabilities.maxTurns ? null : runRole.max_turns,
    });
    return undefined;
  }

  /**
   * Nếu trong lúc đang chuẩn bị (đánh giá độ khó, tạo worktree, dựng câu lệnh) mà có yêu cầu dừng hoặc tắt máy
   * chủ thì hủy ngay, không khởi động tiến trình `claude`. Trả về true nếu đã hủy.
   */
  abortIfStopped(taskId, state) {
    if (!state.stopRequested) return false;
    if (state.token) this.agentRuns.delete(state.token);
    this.running.delete(taskId);
    this.update(taskId, this.stopped ? { status: 'queued' } : { status: 'stopped', error: 'Đã dừng theo yêu cầu.', finished_at: Date.now() });
    if (!this.stopped) {
      this.log(taskId, 'stopped', 'Đã dừng theo yêu cầu.');
      this.notifyJobs(taskId);
    }
    state.resolveExit();
    this.schedule();
    return true;
  }

  /** Lượt làm việc của Trưởng nhóm: chỉ đọc, và chỉ có công cụ của công ty qua MCP (mục 4.1). */
  async launchLead({ task, found, project, state, resume, runDir }) {
    const { team, member, role } = found;
    const director = task.kind === 'dplan' || task.kind === 'dreview';
    const epic = director ? this.store.getEpic(task.epic_id) : null;
    const job = director ? null : this.store.getJob(task.job_id);
    if (director ? !epic : !job) return this.fail(task.id, 'Không tìm thấy việc lớn hoặc yêu cầu của lượt này.');
    if (!state.engine.capabilities.mcp) {
      return this.fail(task.id, `Engine ${state.engine.id} chưa chạy được lượt của Trưởng nhóm hoặc Giám đốc (cần công cụ MCP của công ty). Dùng engine claude cho lượt này.`, 'engine_unsupported');
    }
    if (!this.apiUrl) return this.fail(task.id, 'Máy chủ chưa sẵn sàng nhận công cụ của Trưởng nhóm (thiếu địa chỉ API).');
    const review = task.kind === 'review' || task.kind === 'dreview';

    let cwd = this.cfg.projectRoot;
    let prompt = 'Hãy tiếp tục công việc đang làm dở và hoàn thành nó theo đúng yêu cầu ban đầu.';
    if (task.kind === 'review') {
      const subject = this.store.getTask(task.subject_id);
      if (!subject) return this.fail(task.id, 'Không tìm thấy bài nộp cần duyệt.');
      cwd = subject.worktree || this.cfg.projectRoot;
      if (!resume) prompt = await this.jobs.buildReviewPrompt(job, subject);
    } else if (task.kind === 'plan') {
      // Việc có phụ thuộc đọc code đã ghép của các việc kia, không phải mã gốc ban đầu.
      cwd = job.base_dir || this.cfg.projectRoot;
      if (!resume) prompt = this.jobs.buildPlanPrompt(job, team);
    } else if (task.kind === 'dplan') {
      const feedback = task.review_feedback?.trim();
      if (!resume) prompt = this.epics.buildPlanPrompt(epic, feedback);
      else if (feedback) prompt = `Chủ đã xem kế hoạch và yêu cầu sửa. Nhận xét của chủ:\n\n${feedback}\n\nHãy lập lại kế hoạch theo nhận xét này (chốt lại hợp đồng nếu cần, rồi giao lại các việc cho team), và kết thúc bằng tóm tắt kế hoạch mới.`;
    } else {
      cwd = epic.merge_worktree || this.cfg.projectRoot;
      if (!resume) prompt = this.epics.buildReviewPrompt(epic);
    }

    const mcpTools = toolsForKind(task.kind).map((t) => t.name);
    const token = crypto.randomBytes(24).toString('hex');
    state.token = token;
    this.agentRuns.set(token, task.id);

    const systemFile = path.join(runDir, 'system.md');
    fs.writeFileSync(
      systemFile,
      director
        ? buildDirectorSystemPrompt({ member, team, role, project, kind: task.kind })
        : buildLeadSystemPrompt({ member, team, role, project, kind: task.kind }),
      'utf8',
    );
    const mcpConfigFile = path.join(runDir, 'mcp.json');
    fs.writeFileSync(
      mcpConfigFile,
      JSON.stringify({
        mcpServers: {
          company: {
            command: process.execPath,
            args: [path.join(this.cfg.toolDir, 'server', 'mcp-bridge.mjs')],
            env: { COMPANY_API_URL: this.apiUrl, COMPANY_RUN_TOKEN: token },
          },
        },
      }, null, 2),
    );
    const settingsFile = path.join(runDir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(state.engine.guardSettings(path.join(this.cfg.toolDir, 'server', 'path-guard.mjs')), null, 2));

    // Lượt đã được chủ cho chạy lại thì có thêm lượt và thời gian (giống việc của nhân viên).
    const stretch = stretchOf(task);
    const args = state.engine.leadArgs({
      model: task.model, effort: task.effort, maxTurns: Math.ceil((review ? role.review_max_turns : role.max_turns) * stretch),
      systemFile, mcpConfigFile, settingsFile, mcpTools, session: resume ? task.session_id : null,
      // Duyệt bài được chạy lệnh test của dự án để kiểm chứng báo cáo của nhân viên; lập kế hoạch thì không cần.
      extraBash: review && project?.commands?.test ? [project.commands.test] : [],
    });
    // Lời dặn của chủ khi cho chạy lại lượt này sau lỗi.
    const guidance = task.owner_guidance?.trim();
    if (guidance) {
      prompt = `${prompt}\n\n## Lời dặn của chủ công ty (lần chạy trước của lượt này bị dừng vì lỗi, hãy làm theo lời dặn)\n${guidance}`;
      this.update(task.id, { owner_guidance: null });
    }
    if (this.abortIfStopped(task.id, state)) return undefined;
    this.log(task.id, 'system', resume ? 'Làm tiếp phiên trước (--resume).' : review ? 'Bắt đầu duyệt bài.' : 'Bắt đầu lập kế hoạch.');
    this.track(task, state, {
      cwd,
      args,
      prompt,
      env: { ...state.engine.env(), ...guardEnv({ root: cwd, allow: [], mode: 'readonly' }) },
      timeoutMinutes: Math.ceil(role.timeout_minutes * stretch),
    });
    return undefined;
  }

  /** Lượt trả lời câu hỏi của đồng nghiệp: chỉ đọc trong thư mục làm việc của người hỏi, ngắn, câu trả lời là kết quả cuối. */
  async launchAnswer({ task, found, project, state, resume, runDir }) {
    const { team, member, role } = found;
    const asker = this.store.getTask(task.subject_id);
    const cwd = asker?.worktree || this.cfg.projectRoot;
    const systemFile = path.join(runDir, 'system.md');
    fs.writeFileSync(systemFile, buildAnswerSystemPrompt({ member, team, role, project }), 'utf8');
    const settingsFile = path.join(runDir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(state.engine.guardSettings(path.join(this.cfg.toolDir, 'server', 'path-guard.mjs')), null, 2));
    const args = state.engine.answerArgs({
      model: task.model, effort: task.effort, maxTurns: ANSWER_MAX_TURNS, systemFile, settingsFile, session: resume ? task.session_id : null,
    });
    if (this.abortIfStopped(task.id, state)) return undefined;
    this.log(task.id, 'system', resume ? 'Làm tiếp phiên trước (--resume).' : 'Bắt đầu trả lời câu hỏi.');
    const prompt = resume ? 'Hãy tiếp tục và trả lời câu hỏi theo đúng yêu cầu ban đầu.' : task.prompt;
    const prepared = state.engine.prepare?.({
      cwd, runDir, readonly: true, root: cwd, allow: [], prompt, systemText: fs.readFileSync(systemFile, 'utf8'),
    });
    this.track(task, state, {
      cwd: prepared?.cwd ?? cwd,
      args: [...args, ...(prepared?.args ?? [])],
      prompt: prepared ? '' : prompt,
      env: { ...state.engine.env(), ...guardEnv({ root: cwd, allow: [], mode: 'readonly' }) },
      timeoutMinutes: this.cfg.answerTimeoutMinutes ?? 5,
      maxTurns: state.engine.capabilities.maxTurns ? null : ANSWER_MAX_TURNS,
    });
    return undefined;
  }

  /** Chạy tiến trình `claude`, đọc luồng sự kiện và gọi finalize khi nó kết thúc. */
  track(task, state, { cwd, args, prompt, env, timeoutMinutes, maxTurns = null }) {
    const { bin, prefix } = state.engine.command(this.cfg);
    const child = spawn(bin, [...prefix, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    state.child = child;
    state.maxTurns = maxTurns;
    state.timer = setTimeout(() => {
      state.timedOut = true;
      killTree(child);
    }, timeoutMinutes * 60_000);
    state.timer.unref?.();

    child.stdin.on('error', () => {});
    child.stdin.end(prompt);

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.handleLine(task.id, state, line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      state.stderrTail = (state.stderrTail + chunk).slice(-4000);
    });
    child.on('error', (err) => {
      if (state.closed) return;
      state.closed = true;
      if (err.code === 'ENOENT' && this.rerouteMissing(task, state)) return;
      const hint = err.code === 'ENOENT' ? state.engine.missingHint(this.cfg) : '';
      this.fail(task.id, `Không chạy được ${state.engine.id}: ${err.message}.${hint}`, err.code === 'ENOENT' ? 'no_claude' : 'internal');
      state.resolveExit();
    });
    child.on('close', (code, signal) => {
      if (buffer.trim()) this.handleLine(task.id, state, buffer.trim());
      if (state.closed) return;
      state.closed = true;
      this.finalize(task.id, state, code, signal)
        .catch((err) => this.fail(task.id, `Lỗi khi kết thúc việc: ${err.message}`))
        .finally(() => state.resolveExit());
    });
  }

  /**
   * Lệnh của engine không có trên máy: nếu còn engine khác làm được việc này thì coi engine đó "không dùng được" một lúc
   * (10 phút, rồi thử lại phòng khi bạn vừa cài) và xếp việc lại để chạy bằng engine khác. Trả về true nếu đã xếp lại.
   */
  rerouteMissing(task, state) {
    if (this.engines.length < 2 || this.stopped) return false;
    this.blockEngine(state.engine.id, Date.now() + 10 * 60_000);
    const current = this.store.getTask(task.id);
    const next = this.engineFor({ ...current, session_id: null, engine: null });
    if (!next.engine || next.engine === state.engine) return false;
    clearTimeout(state.timer);
    if (state.token) this.agentRuns.delete(state.token);
    this.running.delete(task.id);
    this.update(task.id, { status: 'queued', engine: null, resume_at: null });
    this.log(task.id, 'warn', `Không tìm thấy lệnh của ${state.engine.label} trên máy này. Chuyển việc sang ${next.engine.label}.`);
    state.resolveExit();
    this.schedule();
    return true;
  }

  /** Một dòng đầu ra của CLI: engine đổi nó thành các sự kiện dạng Claude, rồi runner xử lý từng sự kiện. */
  handleLine(taskId, state, line) {
    const messages = state.engine.parseLine(line, (state.parseState ??= {}));
    if (!messages) {
      this.log(taskId, 'raw', shorten(line, 200));
      return;
    }
    for (const msg of messages) this.handleMessage(taskId, state, msg, line);
  }

  handleMessage(taskId, state, msg, line) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.update(taskId, { session_id: msg.session_id ?? null });
          const skills = Array.isArray(msg.skills) ? msg.skills.length : null;
          this.log(
            taskId,
            'start',
            `Phiên ${shorten(String(msg.session_id ?? ''), 12)}, model ${msg.model ?? '?'}${skills === null ? '' : `, ${skills} skill`}`,
            line,
          );
        } else if (msg.subtype === 'api_retry' || msg.subtype === 'error') {
          this.log(taskId, 'warn', shorten(JSON.stringify(msg), 240), line);
        }
        break;
      case 'assistant': {
        const task = this.store.getTask(taskId);
        this.update(taskId, { turns: (task?.turns ?? 0) + 1 });
        this.enforceTurnLimit(state);
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) this.log(taskId, 'say', shorten(block.text, 600));
          else if (block.type === 'tool_use') this.log(taskId, 'tool', toolSummary(block));
        }
        break;
      }
      case 'user':
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_result') {
            const text = shorten(textOfToolResult(block.content), 200);
            this.log(taskId, block.is_error ? 'tool_error' : 'tool_result', text || '(trống)');
          }
        }
        break;
      case 'rate_limit_event': {
        const info = parseRateLimitEvent(msg);
        if (info) {
          this.store.setState('rate_limit', { ...info, seenAt: Date.now() });
          this.store.recordQuotaSample(info);
          if (info.blocked) {
            state.quota = info;
            this.log(taskId, 'quota', `Bị chặn bởi giới hạn (${info.status}).`, line);
          }
          this.emitState();
        }
        break;
      }
      case 'result':
        if (!state.turnLimitHit) state.result = msg;
        break;
      default:
        break;
    }
  }

  /**
   * CLI không có --max-turns (agy): runner tự đếm lượt trả lời của lần chạy này và dừng khi vượt, rồi coi như "hết số lượt"
   * để luồng nâng bậc model và làm tiếp hoạt động y như với Claude.
   */
  enforceTurnLimit(state) {
    if (!state.maxTurns || state.turnLimitHit) return;
    const scratch = state.parseState ?? {};
    state.turnCount = (state.turnCount ?? 0) + 1;
    if (state.turnCount <= state.maxTurns) return;
    state.turnLimitHit = true;
    state.result = {
      type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: state.maxTurns,
      result: `Đã vượt ${state.maxTurns} lượt cho phép.`, usage: scratch.usage ?? {}, total_cost_usd: 0,
    };
    killTree(state.child);
  }

  async finalize(taskId, state, code, signal) {
    clearTimeout(state.timer);
    if (state.token) this.agentRuns.delete(state.token);
    this.running.delete(taskId);
    const task = this.store.getTask(taskId);
    const project = this.getProject();
    const res = state.result;
    const now = Date.now();
    const leadRun = task.kind !== 'work';

    const usage = res?.usage ?? {};
    const totals = {
      duration_ms: task.duration_ms + (res?.duration_ms ?? 0),
      input_tokens: task.input_tokens + (usage.input_tokens ?? 0),
      output_tokens: task.output_tokens + (usage.output_tokens ?? 0),
      cache_read_tokens: task.cache_read_tokens + (usage.cache_read_input_tokens ?? 0),
      cache_creation_tokens: task.cache_creation_tokens + (usage.cache_creation_input_tokens ?? 0),
      est_cost_usd: task.est_cost_usd + (res?.total_cost_usd ?? 0),
    };

    const succeeded = res && res.subtype === 'success' && !res.is_error;
    if (!succeeded && !state.quota) {
      // Engine không phát sự kiện rate_limit_event thì tự nhận ra hết hạn mức từ lỗi.
      const detected = state.engine.detectQuota?.({ res, stderrTail: state.stderrTail, code });
      if (detected) state.quota = detected;
    }
    const quotaHit =
      !succeeded &&
      (Boolean(state.quota?.blocked) ||
        (res?.is_error && looksLikeQuotaText(String(res.result ?? ''))) ||
        (!res && looksLikeQuotaText(state.stderrTail)));

    if (state.stopRequested && !this.stopped) {
      this.update(taskId, { ...totals, status: 'stopped', error: 'Đã dừng theo yêu cầu.', finished_at: now });
      this.log(taskId, 'stopped', 'Đã dừng theo yêu cầu.');
    } else if (this.stopped) {
      this.update(taskId, { ...totals, status: 'queued' });
    } else if (quotaHit) {
      const resumeAt = nextRetryAt({
        resetsAt: state.quota?.resetsAt ?? null,
        attempt: task.attempts - 1,
        now,
        marginMs: this.cfg.quotaMarginMs,
      });
      // Engine này hết hạn mức tới `resumeAt`. Còn engine khác làm được việc này thì chuyển ngay sang đó (xoay vòng),
      // không thì việc chờ; cả công ty chỉ nghỉ khi MỌI engine đã liên kết đều hết.
      this.blockEngine(state.engine.id, resumeAt);
      const name = state.engine.id === 'claude' ? 'Pro' : state.engine.label;
      const when = new Date(resumeAt).toLocaleTimeString('vi-VN');
      const next = this.engineFor({ ...task, session_id: null, engine: null }, now);
      if (next.engine && next.engine !== state.engine) {
        this.update(taskId, { ...totals, status: 'queued', resume_at: null, handoff_from: state.engine.id, error: null });
        this.log(taskId, 'quota', `Hết hạn mức ${name} (hồi lúc ${when}). Chuyển việc sang ${next.engine.label} và làm tiếp.`);
      } else {
        this.update(taskId, { ...totals, status: 'paused_quota', resume_at: resumeAt, error: null });
        const allUntil = this.allBlockedUntil(now);
        if (allUntil) {
          this.pauseCompany({ until: allUntil, reason: 'quota' });
          this.log(taskId, 'quota', `Hết hạn mức ${name}. Cả công ty tạm nghỉ, sẽ làm tiếp lúc ${new Date(allUntil).toLocaleTimeString('vi-VN')}.`);
        } else {
          this.log(taskId, 'quota', `Hết hạn mức ${name}. Việc này cần engine ${state.engine.label}, sẽ làm tiếp lúc ${when} (các engine khác vẫn chạy việc khác).`);
        }
      }
    } else if (succeeded && leadRun) {
      // Lượt của Trưởng nhóm không sửa file nên không có gì để commit.
      this.update(taskId, {
        ...totals, status: 'done', result: maskSecrets(String(res.result ?? '')), turns: res.num_turns ?? task.turns, error: null, finished_at: now,
      });
      this.log(taskId, 'done', { review: 'Đã duyệt xong.', dreview: 'Đã kiểm tra xong.', answer: 'Đã trả lời xong.' }[task.kind] ?? 'Đã lập kế hoạch xong.');
    } else if ((succeeded || res?.subtype === 'error_max_turns') && task.kind === 'work' && this.store.questionsOf(taskId).some((q) => !q.delivered)) {
      // Nhân viên đã hỏi người khác trong lượt này: chưa nộp bài, chưa commit. Chờ trả lời rồi làm tiếp bằng --resume.
      // (Kiểm tra và cập nhật trạng thái cùng một nhịp, không có await xen giữa, nên không lỡ câu trả lời đến sát lúc này.)
      const open = this.store.openQuestions(taskId).length;
      this.update(taskId, { ...totals, status: open ? 'waiting_answer' : 'queued', turns: res?.num_turns ?? task.turns, error: null });
      this.log(taskId, 'question', open ? `Đang chờ ${open} câu trả lời, chưa nộp bài.` : 'Câu trả lời đã có sẵn, xếp hàng làm tiếp.');
    } else if (succeeded) {
      let changedFiles = [];
      try {
        const committed = await commitWorktree({
          dir: task.worktree,
          message: `company: ${task.title}\n\nViệc #${task.id} do ${task.member} (${task.role}) làm.`,
          exclude: [...(project?.worktreeLinks ?? []), ...state.engine.workspaceExcludes],
        });
        changedFiles = committed.changedFiles;
      } catch (err) {
        this.log(taskId, 'warn', `Không commit được thay đổi: ${err.message}`);
      }
      // Việc con của một việc lớn không "xong" ngay: phải nộp bài và chờ Trưởng nhóm duyệt.
      const submitted = Boolean(task.job_id);
      this.update(taskId, {
        ...totals,
        status: submitted ? 'submitted' : 'done',
        result: maskSecrets(String(res.result ?? '')),
        changed_files: JSON.stringify(changedFiles),
        turns: res.num_turns ?? task.turns,
        error: null,
        finished_at: now,
      });
      this.log(taskId, 'done', submitted ? `Đã nộp bài (${changedFiles.length} file thay đổi), chờ Trưởng nhóm duyệt.` : `Xong. ${changedFiles.length} file thay đổi.`);
    } else if (this.escalationFor(task, res)) {
      // Việc hết số lượt mà chưa xong: có thể đánh giá độ khó đã quá thấp, nâng một bậc và làm tiếp.
      const next = this.escalationFor(task, res);
      this.update(taskId, { ...totals, status: 'queued', model: next.model, effort: next.effort, escalations: task.escalations + 1 });
      this.log(
        taskId,
        'escalate',
        `Chưa xong sau ${res.num_turns ?? '?'} lượt bằng ${task.model}. Nâng lên ${next.model} (suy luận ${next.effort}) và làm tiếp.`,
      );
    } else {
      let reason;
      let failureCode;
      if (state.timedOut) {
        reason = `Quá thời gian cho phép (${this.timeoutLabel(task)}).`;
        failureCode = 'timeout';
      } else if (res) {
        reason = `Kết thúc không thành công (${res.subtype ?? 'lỗi'}${res.terminal_reason ? `, ${res.terminal_reason}` : ''}): ${shorten(String(res.result ?? ''), 300)}`;
        failureCode = res.subtype === 'error_max_turns' ? 'max_turns' : 'error_result';
      } else {
        reason = `Tiến trình ${state.engine.id} thoát bất thường (mã ${code ?? '?'}${signal ? `, tín hiệu ${signal}` : ''}). ${shorten(state.stderrTail, 300)}`;
        failureCode = 'crash';
      }
      // Tiến trình tự thoát (mạng chập chờn, máy ngủ đông...) thường qua khỏi nếu thử lại: tự làm tiếp đúng phiên cũ MỘT lần,
      // sau một lúc. Lần nữa vẫn lỗi thì mới đến tay chủ. (Lỗi khác như hết lượt, quá giờ, Claude báo lỗi thì không tự thử: dễ tốn hạn mức vô ích.)
      if (this.canAutoRetry(task, failureCode, leadRun)) {
        const delay = this.cfg.autoRetryDelayMs ?? 30_000;
        this.update(taskId, { ...totals, status: 'queued', auto_retries: task.auto_retries + 1, resume_at: now + delay, turns: res?.num_turns ?? task.turns });
        this.log(taskId, 'warn', `${reason} Tự thử lại một lần (làm tiếp phiên cũ) sau ${Math.round(delay / 1000)} giây.`);
        if (!this.stopped) await this.notifyJobs(taskId);
        this.schedule();
        return;
      }
      let changedFiles = [];
      if (!leadRun) {
        try {
          changedFiles = (await commitWorktree({
            dir: task.worktree,
            message: `company (chưa xong): ${task.title}\n\nViệc #${task.id}`,
            exclude: [...(project?.worktreeLinks ?? []), ...state.engine.workspaceExcludes],
          })).changedFiles;
        } catch {
          /* giữ nguyên worktree để người dùng xem */
        }
      }
      this.update(taskId, {
        ...totals,
        status: 'failed',
        error: maskSecrets(reason),
        failure_code: failureCode,
        changed_files: leadRun ? null : JSON.stringify(changedFiles),
        turns: res?.num_turns ?? task.turns,
        finished_at: now,
      });
      this.log(taskId, 'error', reason);
    }
    if (!this.stopped) await this.notifyJobs(taskId);
    this.schedule();
  }

  canAutoRetry(task, failureCode, leadRun) {
    return !leadRun && failureCode === 'crash' && task.auto_retries < 1 && Boolean(task.session_id) && Boolean(task.worktree) && fs.existsSync(task.worktree);
  }

  /**
   * Bậc model cao hơn để thử lại một lần khi việc hết số lượt. Không nâng khi người dùng tự chọn
   * độ khó (tôn trọng lựa chọn của họ) hoặc khi không còn phiên để làm tiếp.
   */
  escalationFor(task, res) {
    if (res?.subtype !== 'error_max_turns') return null;
    if (task.level_source === 'user' || task.escalations >= 1 || !task.session_id) return null;
    return nextTier(task.model);
  }

  timeoutLabel(task) {
    const found = findMember(this.getTeams(), task.member);
    if (!found) return '? phút';
    return `${Math.ceil(found.role.timeout_minutes * stretchOf(task))} phút`;
  }

  stop(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) return false;
    const state = this.running.get(taskId);
    if (state) {
      state.stopRequested = true;
      killTree(state.child);
      return true;
    }
    if (task.status === 'queued' || task.status === 'paused_quota' || task.status === 'waiting_answer') {
      this.update(taskId, { status: 'stopped', error: 'Đã dừng theo yêu cầu.', finished_at: Date.now() });
      this.log(taskId, 'stopped', 'Đã dừng theo yêu cầu.');
      this.emitState();
      this.notifyJobs(taskId);
      return true;
    }
    return false;
  }

  stopAll() {
    let count = 0;
    for (const task of this.store.tasksByStatus('running', 'queued', 'paused_quota', 'waiting_answer')) {
      if (this.stop(task.id)) count += 1;
    }
    return count;
  }
}

