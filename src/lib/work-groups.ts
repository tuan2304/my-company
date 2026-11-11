import type { Epic, EpicStatus, Job, JobStatus, Task, TaskStatus } from './types';

/**
 * Chia việc trong bảng Công việc theo TRẠNG THÁI (không theo loại), để mở bảng ra không thấy việc xong, lỗi, chờ duyệt nằm lẫn với nhau.
 * Bốn thẻ: cần bạn / đang làm / xong / đã dừng; mỗi thẻ chia tiếp thành vài mục nhỏ.
 * Không phụ thuộc React hay mã khác ngoài kiểu dữ liệu, để kiểm thử thẳng bằng node.
 */

export type WorkTab = 'need' | 'active' | 'done' | 'stopped';
export type WorkKind = 'epic' | 'job' | 'task';

export interface WorkItem {
  kind: WorkKind;
  id: number;
  title: string;
  status: string;
  /** Người phụ trách: Giám đốc, Trưởng nhóm hoặc nhân viên. */
  who: string;
  /** Mốc thời gian để xếp (xong lúc nào, hoặc tạo lúc nào). */
  at: number;
  /** Việc con nằm trong một việc lớn/yêu cầu (chỉ có ở thẻ "cần bạn"): mã cha để hiện "thuộc việc lớn #..". */
  parent: { kind: 'epic' | 'job'; id: number } | null;
}

export interface WorkSection {
  key: string;
  label: string;
  items: WorkItem[];
}

export interface WorkGroups {
  tabs: Record<WorkTab, WorkSection[]>;
  counts: Record<WorkTab, number>;
}

/** Thứ đang chờ chính chủ (cùng nghĩa với ownerRequests ở src/office/status.ts). */
export interface NeedRef {
  kind: WorkKind;
  id: number;
  status: string;
}

export const TAB_LABEL: Record<WorkTab, string> = {
  need: 'Cần bạn',
  active: 'Đang làm',
  done: 'Xong',
  stopped: 'Đã dừng',
};

export const KIND_TAG: Record<WorkKind, string> = { epic: 'Yêu cầu', job: 'Việc lớn', task: 'Việc' };

type Lane = { tab: WorkTab; section: string };

const EPIC_LANE: Record<EpicStatus, Lane> = {
  awaiting_plan: { tab: 'need', section: 'approve' },
  awaiting_result: { tab: 'need', section: 'approve' },
  attention: { tab: 'need', section: 'failed' },
  failed: { tab: 'need', section: 'failed' },
  planning: { tab: 'active', section: 'working' },
  running: { tab: 'active', section: 'working' },
  integrating: { tab: 'active', section: 'working' },
  reviewing: { tab: 'active', section: 'reviewing' },
  done: { tab: 'done', section: 'done' },
  stopped: { tab: 'stopped', section: 'stopped' },
  rejected: { tab: 'stopped', section: 'rejected' },
};

const JOB_LANE: Record<JobStatus, Lane> = {
  awaiting_choice: { tab: 'need', section: 'approve' },
  attention: { tab: 'need', section: 'failed' },
  failed: { tab: 'need', section: 'failed' },
  planning: { tab: 'active', section: 'working' },
  running: { tab: 'active', section: 'working' },
  integrating: { tab: 'active', section: 'working' },
  draft: { tab: 'active', section: 'waiting' },
  waiting: { tab: 'active', section: 'waiting' },
  done: { tab: 'done', section: 'done' },
  stopped: { tab: 'stopped', section: 'stopped' },
};

const TASK_LANE: Record<TaskStatus, Lane> = {
  failed: { tab: 'need', section: 'failed' },
  running: { tab: 'active', section: 'working' },
  submitted: { tab: 'active', section: 'reviewing' },
  queued: { tab: 'active', section: 'waiting' },
  paused_quota: { tab: 'active', section: 'waiting' },
  waiting_answer: { tab: 'active', section: 'waiting' },
  done: { tab: 'done', section: 'done' },
  stopped: { tab: 'stopped', section: 'stopped' },
};

const SECTIONS: Record<WorkTab, { key: string; label: string }[]> = {
  need: [
    { key: 'approve', label: 'Chờ bạn duyệt' },
    { key: 'asking', label: 'Đang hỏi bạn' },
    { key: 'failed', label: 'Bị lỗi, cần bạn xem' },
  ],
  active: [
    { key: 'working', label: 'Đang làm' },
    { key: 'reviewing', label: 'Đang được duyệt' },
    { key: 'waiting', label: 'Đang chờ tới lượt' },
  ],
  done: [
    { key: 'today', label: 'Hôm nay' },
    { key: 'yesterday', label: 'Hôm qua' },
    { key: 'earlier', label: 'Trước đó' },
  ],
  stopped: [
    { key: 'stopped', label: 'Đã dừng' },
    { key: 'rejected', label: 'Bạn không duyệt' },
    { key: 'failed', label: 'Kết thúc với lỗi' },
  ],
};

/** Mục trong thẻ "cần bạn" của một thứ đang chờ chủ. */
function needSection(ref: NeedRef): string {
  if (ref.status === 'asking') return 'asking';
  if (ref.status === 'awaiting_plan' || ref.status === 'awaiting_result' || ref.status === 'awaiting_choice') return 'approve';
  return 'failed';
}

/** Mục "Hôm nay / Hôm qua / Trước đó" theo giờ máy của người xem. */
export function daySection(at: number, now: number): 'today' | 'yesterday' | 'earlier' {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (at >= today) return 'today';
  start.setDate(start.getDate() - 1);
  return at >= start.getTime() ? 'yesterday' : 'earlier';
}

const key = (kind: WorkKind, id: number) => `${kind}:${id}`;

/**
 * Chia danh sách. Chỉ việc CẤP CAO NHẤT (yêu cầu, việc lớn không thuộc yêu cầu, việc lẻ) vào các thẻ; việc con xem trong chi tiết.
 * Riêng thẻ "cần bạn" lấy đúng danh sách `needs` (gồm cả việc con bị lỗi của một việc lớn còn chạy), để khớp với nút "N việc cần bạn quyết".
 * Một việc cấp cao nhất đã nằm ở "cần bạn" thì không lặp lại ở thẻ khác.
 */
export function groupWork({
  epics, jobs, tasks, needs, now, query = '',
}: { epics: Epic[]; jobs: Job[]; tasks: Task[]; needs: NeedRef[]; now: number; query?: string }): WorkGroups {
  const q = query.trim().toLowerCase();
  const match = (item: WorkItem) => !q || `#${item.id} ${item.title} ${item.who}`.toLowerCase().includes(q);
  const buckets: Record<WorkTab, Map<string, WorkItem[]>> = { need: new Map(), active: new Map(), done: new Map(), stopped: new Map() };
  const put = (tab: WorkTab, section: string, item: WorkItem) => {
    if (!match(item)) return;
    const list = buckets[tab].get(section) ?? [];
    list.push(item);
    buckets[tab].set(section, list);
  };

  const epicById = new Map(epics.map((e) => [e.id, e]));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const needKeys = new Set<string>();

  for (const ref of needs) {
    let item: WorkItem | null = null;
    if (ref.kind === 'epic') {
      const e = epicById.get(ref.id);
      if (e) item = { kind: 'epic', id: e.id, title: e.title, status: e.status, who: e.director, at: e.created_at, parent: null };
    } else if (ref.kind === 'job') {
      const j = jobById.get(ref.id);
      if (j) item = { kind: 'job', id: j.id, title: j.title, status: j.status, who: j.lead, at: j.created_at, parent: j.epic_id !== null ? { kind: 'epic', id: j.epic_id } : null };
    } else {
      const t = taskById.get(ref.id);
      if (t) {
        const parent = t.job_id !== null ? { kind: 'job' as const, id: t.job_id } : t.epic_id !== null ? { kind: 'epic' as const, id: t.epic_id } : null;
        item = { kind: 'task', id: t.id, title: t.title, status: ref.status === 'asking' ? 'asking' : t.status, who: t.member, at: t.finished_at ?? t.created_at, parent };
      }
    }
    if (!item || needKeys.has(key(item.kind, item.id))) continue;
    needKeys.add(key(item.kind, item.id));
    put('need', needSection(ref), item);
  }

  const place = (item: WorkItem, lane: Lane, finishedAt: number | null) => {
    if (needKeys.has(key(item.kind, item.id))) return;
    // Lỗi mà ownerRequests không tính là "cần bạn" (không còn gì để cứu): xếp vào thẻ đã dừng, mục riêng,
    // để số trên thẻ "Cần bạn" luôn bằng số trên nút "N việc cần bạn quyết".
    if (lane.tab === 'need') return put('stopped', 'failed', item);
    if (lane.tab === 'done') return put('done', daySection(finishedAt ?? item.at, now), item);
    return put(lane.tab, lane.section, item);
  };

  for (const e of epics) {
    place({ kind: 'epic', id: e.id, title: e.title, status: e.status, who: e.director, at: e.finished_at ?? e.created_at, parent: null }, EPIC_LANE[e.status] ?? { tab: 'active', section: 'working' }, e.finished_at);
  }
  for (const j of jobs) {
    if (j.epic_id !== null) continue;
    place({ kind: 'job', id: j.id, title: j.title, status: j.status, who: j.lead, at: j.finished_at ?? j.created_at, parent: null }, JOB_LANE[j.status] ?? { tab: 'active', section: 'working' }, j.finished_at);
  }
  for (const t of tasks) {
    if (t.job_id !== null || t.epic_id !== null) continue;
    place({ kind: 'task', id: t.id, title: t.title, status: t.status, who: t.member, at: t.finished_at ?? t.created_at, parent: null }, TASK_LANE[t.status] ?? { tab: 'active', section: 'working' }, t.finished_at);
  }

  const tabs = {} as Record<WorkTab, WorkSection[]>;
  const counts = {} as Record<WorkTab, number>;
  for (const tab of Object.keys(SECTIONS) as WorkTab[]) {
    tabs[tab] = SECTIONS[tab]
      .map((s) => ({ ...s, items: (buckets[tab].get(s.key) ?? []).sort((a, b) => b.at - a.at || b.id - a.id) }))
      .filter((s) => s.items.length > 0);
    counts[tab] = tabs[tab].reduce((n, s) => n + s.items.length, 0);
  }
  return { tabs, counts };
}

/** Thẻ nên mở khi vào bảng: có việc chờ bạn thì vào đó, không thì đang làm, không nữa thì xong. */
export function defaultTab(counts: Record<WorkTab, number>): WorkTab {
  if (counts.need > 0) return 'need';
  if (counts.active > 0) return 'active';
  if (counts.done > 0) return 'done';
  return counts.stopped > 0 ? 'stopped' : 'active';
}

/** Thẻ chứa một việc cụ thể (để khi mở việc từ văn phòng thì bảng tự chuyển sang đúng thẻ). */
export function tabOf(groups: WorkGroups, kind: WorkKind, id: number): WorkTab | null {
  for (const tab of Object.keys(groups.tabs) as WorkTab[]) {
    if (groups.tabs[tab].some((s) => s.items.some((i) => i.kind === kind && i.id === id))) return tab;
  }
  return null;
}

/** Nhóm việc con trong chi tiết (việc lớn, yêu cầu): đang cần bạn / đang chạy / xong / dừng. Mục "xong" thường được gập lại. */
export type ChildPhase = 'problem' | 'active' | 'done' | 'stopped';

export const CHILD_PHASE_LABEL: Record<ChildPhase, string> = {
  problem: 'Bị lỗi hoặc cần xem',
  active: 'Đang làm hoặc đang chờ',
  done: 'Đã xong',
  stopped: 'Đã dừng',
};

export function taskPhase(status: TaskStatus): ChildPhase {
  if (status === 'failed') return 'problem';
  if (status === 'done') return 'done';
  if (status === 'stopped') return 'stopped';
  return 'active';
}

export function jobPhase(status: JobStatus): ChildPhase {
  if (status === 'failed' || status === 'attention' || status === 'awaiting_choice') return 'problem';
  if (status === 'done') return 'done';
  if (status === 'stopped') return 'stopped';
  return 'active';
}

export function splitByPhase<T>(items: T[], phaseOf: (item: T) => ChildPhase): { phase: ChildPhase; items: T[] }[] {
  const order: ChildPhase[] = ['problem', 'active', 'done', 'stopped'];
  return order.map((phase) => ({ phase, items: items.filter((i) => phaseOf(i) === phase) })).filter((g) => g.items.length > 0);
}

/** Dòng nhật ký "kỹ thuật" (kết quả công cụ, dòng thô): ẩn mặc định cho dễ đọc. */
export function isTechnicalEvent(kind: string): boolean {
  return kind === 'tool_result' || kind === 'raw';
}
