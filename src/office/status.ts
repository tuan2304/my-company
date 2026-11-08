import type { Epic, Job, Task } from '../lib/types';

/**
 * Trạng thái và hoạt động của từng người trong văn phòng. Toàn bộ là hàm thuần suy từ dữ liệu
 * máy chủ, nên kiểm thử được mà không cần WebGL. Giống layout.ts, file này chỉ dùng cú pháp TypeScript "xóa được"
 * và không import mã chạy từ file khác (Node không tự thêm đuôi .ts khi import).
 */

/** Trạng thái hiển thị của một người: đèn trên bàn đổi màu theo đây. */
export type PersonStatus = 'working' | 'waiting' | 'queued' | 'idle';

/** Người đó đang làm động tác gì (quyết định đi đâu và ngồi gõ hay đứng đọc). */
export type Activity = 'idle' | 'typing' | 'reading' | 'command' | 'planning' | 'reviewing' | 'waiting';

/** Chỗ nhân vật đang ở hoặc cần tới. */
export type Place = 'desk' | 'library' | 'server' | 'whiteboard' | 'lounge' | 'pantry' | 'meeting' | 'wc' | 'window';

/** Đèn trên bàn, xếp theo mức ưu tiên: cần bạn > quá tải > đang làm > chờ duyệt > có việc chờ > vừa lỗi > rảnh. */
export type Lamp = 'needs_you' | 'overload' | 'working' | 'waiting' | 'queued' | 'failed' | 'idle';

export interface PersonView {
  status: PersonStatus;
  activity: Activity;
  /** Số việc đang chờ trên bàn (chồng giấy cao theo số này). */
  queued: number;
  /** Đã chạm trần tải của một người (1 đang làm + 2 chờ): đèn cam nhấp nháy, toát mồ hôi. */
  overload: boolean;
  /** Việc gần nhất của người này bị lỗi và họ chưa nhận việc khác: đèn đỏ, gãi đầu. */
  failed: boolean;
  /** Có thứ đang chờ bạn quyết (duyệt kế hoạch, duyệt kết quả, xử lý cảnh báo): đèn vàng, giơ tay. */
  needsYou: boolean;
  /** Việc đang làm theo công cụ gần nhất, ví dụ "Sửa auth.ts" (rỗng nếu chưa rõ). */
  detail: string;
}

export const IDLE_VIEW: PersonView = { status: 'idle', activity: 'idle', queued: 0, overload: false, failed: false, needsYou: false, detail: '' };

export const DEFAULT_OVERLOAD_AT = 3; // max_active_per_member (1) + max_queue_per_member (2)
export const FAILED_VISIBLE_MS = 15 * 60 * 1000; // đèn đỏ sau việc lỗi giữ bấy lâu rồi tắt

const OPEN: Task['status'][] = ['running', 'queued', 'paused_quota', 'waiting_answer', 'submitted'];
const LOAD: Task['status'][] = ['queued', 'running', 'paused_quota', 'waiting_answer']; // khớp openLoad() ở máy chủ
const RANK: Record<PersonStatus, number> = { idle: 0, queued: 1, waiting: 2, working: 3 };

/**
 * Trạng thái của từng người, suy từ các việc đang mở của họ (kể cả lượt lập kế hoạch và duyệt bài của Trưởng nhóm,
 * lượt của Giám đốc): đang làm > chờ duyệt > có việc đang chờ > rảnh. Người không có việc mở thì không có trong kết quả.
 */
export function statusOf(tasks: Pick<Task, 'member' | 'status'>[]): Record<string, PersonStatus> {
  const out: Record<string, PersonStatus> = {};
  for (const t of tasks) {
    if (!OPEN.includes(t.status)) continue;
    const next: PersonStatus = t.status === 'running' ? 'working' : t.status === 'submitted' || t.status === 'waiting_answer' ? 'waiting' : 'queued';
    const current = out[t.member] ?? 'idle';
    if (RANK[next] > RANK[current]) out[t.member] = next;
  }
  return out;
}

const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

/** Từ dòng nhật ký công cụ ("Read: src/a.ts", "Bash: npm test") suy ra động tác: đọc code, chạy lệnh, hay gõ (còn lại). */
export function activityOfTool(summary: string): Activity {
  const name = summary.split(':')[0].trim();
  if (READING_TOOLS.has(name)) return 'reading';
  if (COMMAND_TOOLS.has(name)) return 'command';
  return 'typing';
}

const TOOL_VERB: Record<string, string> = {
  Edit: 'Sửa', MultiEdit: 'Sửa', NotebookEdit: 'Sửa', Write: 'Viết', Read: 'Đọc', NotebookRead: 'Đọc', Grep: 'Tìm', Glob: 'Tìm', LS: 'Xem',
  WebFetch: 'Tra', WebSearch: 'Tra', Bash: 'Chạy', PowerShell: 'Chạy',
};
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write', 'Read', 'NotebookRead']);

/** Dòng ngắn cho bóng nói: "Sửa auth.ts", "Đọc app.ts", "Chạy npm test". Công cụ lạ (công cụ giao việc, Skill...) thì trả chuỗi rỗng. */
export function describeTool(summary: string): string {
  const colon = summary.indexOf(':');
  const name = (colon < 0 ? summary : summary.slice(0, colon)).trim();
  const verb = TOOL_VERB[name];
  if (!verb) return '';
  const rest = colon < 0 ? '' : summary.slice(colon + 1).trim();
  const target = FILE_TOOLS.has(name) ? (rest.split(/[\\/]/).pop() ?? rest) : rest;
  const line = `${verb} ${target}`.trim();
  return line.length > 30 ? `${line.slice(0, 29)}…` : line;
}

/** Chữ trong bóng nói trên đầu nhân vật; rỗng nghĩa là không hiện bóng. */
export function bubbleOf(view: PersonView): string {
  if (view.needsYou) return 'Chờ bạn quyết';
  if (view.failed) return 'Việc bị lỗi';
  if (view.activity === 'idle') return '';
  if (view.detail) return view.detail;
  const fallback: Record<Activity, string> = { idle: '', typing: 'Đang làm', reading: 'Đọc code', command: 'Chạy lệnh', planning: 'Lập kế hoạch', reviewing: 'Duyệt bài', waiting: 'Chờ duyệt bài' };
  return fallback[view.activity];
}

/** "mm:ss", hoặc "h:mm:ss" từ một giờ trở lên; số âm coi như 0. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export interface OwnerRequest {
  kind: 'epic' | 'job' | 'task';
  id: number;
  title: string;
  status: string;
  /** Người đang đợi bạn (Giám đốc của yêu cầu, Trưởng nhóm của việc lớn, hoặc nhân viên có việc bị lỗi). */
  who: string;
}

// Việc lớn đã kết thúc thì không xử lý riêng từng việc con nữa (giống JOB_TERMINAL ở server/jobs.mjs).
const JOB_FINISHED = new Set(['done', 'attention', 'failed', 'stopped']);

/** Những thứ đang chờ chính bạn: duyệt kế hoạch, duyệt kết quả, việc cần bạn xem (xung đột, vượt giới hạn), hoặc việc bị lỗi cần bạn chọn cách xử lý. */
export function ownerRequests(
  epics: Pick<Epic, 'id' | 'title' | 'status' | 'director'>[],
  jobs: Pick<Job, 'id' | 'title' | 'status' | 'lead' | 'epic_id'>[],
  tasks: Pick<Task, 'id' | 'title' | 'status' | 'member' | 'kind' | 'job_id' | 'epic_id' | 'ask_owner_id'>[] = [],
): OwnerRequest[] {
  const out: OwnerRequest[] = [];
  for (const e of epics) {
    if (e.status === 'awaiting_plan' || e.status === 'awaiting_result' || e.status === 'attention' || e.status === 'failed') {
      out.push({ kind: 'epic', id: e.id, title: e.title, status: e.status, who: e.director });
    }
  }
  for (const j of jobs) {
    // Việc lớn lẻ "cần xem" hoặc "lỗi": chủ còn cứu được (xử lý việc con lỗi, hoặc cho Trưởng nhóm lập kế hoạch lại).
    if (j.epic_id === null && (j.status === 'attention' || j.status === 'failed')) out.push({ kind: 'job', id: j.id, title: j.title, status: j.status, who: j.lead });
    // Thi đấu skill: hai bản đã nộp và chụp ảnh xong, chờ chủ chọn (bấm vào Trưởng nhóm).
    if (j.status === 'awaiting_choice') out.push({ kind: 'job', id: j.id, title: j.title, status: j.status, who: j.lead });
  }
  // Việc "làm" cần chủ: bị lỗi (chọn cách xử lý) hoặc đang hỏi chủ một câu (ask_owner). Chỉ tính việc lẻ, hoặc việc con của
  // một việc lớn còn đang chạy (chủ còn kịp cứu trước khi việc lớn kết thúc).
  const openJobs = new Set(jobs.filter((j) => !JOB_FINISHED.has(j.status)).map((j) => j.id));
  for (const t of tasks) {
    if (t.kind !== 'work') continue;
    const status = t.status === 'failed' ? 'failed' : t.status === 'waiting_answer' && t.ask_owner_id != null ? 'asking' : null;
    if (!status) continue;
    const own = t.job_id == null ? t.epic_id == null : openJobs.has(t.job_id);
    if (own) out.push({ kind: 'task', id: t.id, title: t.title, status, who: t.member });
  }
  return out;
}

export interface ViewInput {
  tasks: Task[];
  jobs: Job[];
  epics: Epic[];
  /** Dòng nhật ký công cụ gần nhất của từng việc đang chạy (mã việc → "Read: src/a.ts"). */
  lastTool: Record<number, string>;
  now: number;
  overloadAt?: number;
}

/** Tình trạng đầy đủ của từng người (đèn, động tác, chồng giấy, quá tải, lỗi, chờ bạn). Người không có gì thì dùng IDLE_VIEW. */
export function viewOf(input: ViewInput): Record<string, PersonView> {
  const { tasks, lastTool, now } = input;
  const overloadAt = input.overloadAt ?? DEFAULT_OVERLOAD_AT;
  const status = statusOf(tasks);
  const waitingOwner = new Set(ownerRequests(input.epics, input.jobs).map((r) => r.who));

  const byMember = new Map<string, Task[]>();
  for (const t of tasks) {
    const list = byMember.get(t.member);
    if (list) list.push(t);
    else byMember.set(t.member, [t]);
  }
  for (const who of waitingOwner) if (!byMember.has(who)) byMember.set(who, []);

  const out: Record<string, PersonView> = {};
  for (const [member, list] of byMember) {
    const open = list.filter((t) => OPEN.includes(t.status));
    const running = open.filter((t) => t.status === 'running').sort((a, b) => b.id - a.id)[0];
    const latest = list.reduce<Task | null>((best, t) => (!best || t.id > best.id ? t : best), null);

    let activity: Activity = 'idle';
    let detail = '';
    if (running) {
      const tool = lastTool[running.id];
      detail = tool ? describeTool(tool) : '';
      const byTool = tool ? activityOfTool(tool) : 'typing';
      if (byTool === 'reading' || byTool === 'command') activity = byTool;
      else if (running.kind === 'plan' || running.kind === 'dplan') activity = 'planning';
      else if (running.kind === 'review' || running.kind === 'dreview') activity = 'reviewing';
      else if (running.kind === 'answer') activity = 'reading';
      else activity = 'typing';
    } else if (open.some((t) => t.status === 'submitted' || t.status === 'waiting_answer')) {
      activity = 'waiting';
    }

    out[member] = {
      status: status[member] ?? 'idle',
      activity,
      queued: list.filter((t) => t.status === 'queued').length,
      overload: list.filter((t) => t.kind === 'work' && LOAD.includes(t.status)).length >= overloadAt,
      failed: open.length === 0 && latest !== null && latest.status === 'failed' && latest.finished_at !== null && now - latest.finished_at < FAILED_VISIBLE_MS,
      needsYou: waitingOwner.has(member),
      detail,
    };
  }
  return out;
}

/** Đèn trên bàn của một người. */
export function lampOf(view: PersonView): Lamp {
  if (view.needsYou) return 'needs_you';
  if (view.overload) return 'overload';
  if (view.status === 'working') return 'working';
  if (view.status === 'waiting') return 'waiting';
  if (view.status === 'queued') return 'queued';
  if (view.failed) return 'failed';
  return 'idle';
}

/**
 * Chỗ người đó muốn tới: nghỉ giải lao thì ra phòng nghỉ; đọc code thì tới thư viện; chạy lệnh thì vào phòng server;
 * Giám đốc lập kế hoạch thì ra bảng trắng; còn lại ngồi ở bàn.
 */
export function placeOf(view: PersonView, isDirector: boolean, onBreak: boolean): Place {
  if (onBreak) return 'lounge';
  if (view.activity === 'reading') return 'library';
  if (view.activity === 'command') return 'server';
  if (view.activity === 'planning' && isDirector) return 'whiteboard';
  return 'desk';
}
