/**
 * Luồng giấy tờ và đường đi trong văn phòng. Hàm thuần, không dùng WebGL, nên kiểm thử được
 * bằng Node. Chỉ dùng cú pháp TypeScript "xóa được"; import mã chạy từ file khác phải có đuôi `.ts` (như layout.ts).
 */
import type { Epic, Job, Task } from '../lib/types';
import { BODY_RADIUS, OUTER_T, WALL_T, type OfficeLayout, type PersonSpot, type Stand } from './layout.ts';
import type { Place } from './status';

/** Điểm đầu/cuối đặc biệt của một tờ giấy (ngoài tên người). */
export const OWNER = '@owner';
export const CABINET = '@cabinet';

export type FlowKind = 'assign' | 'report' | 'return' | 'file' | 'ask' | 'reply';

/** Một tờ giấy đi từ `from` tới `to`. `from`/`to` là tên người, OWNER hoặc CABINET. */
export interface Flow {
  kind: FlowKind;
  from: string;
  to: string;
}

export interface Snapshot {
  tasks: Task[];
  jobs: Job[];
  epics: Epic[];
}

/** Một lần cập nhật hàng loạt (nối lại sau khi mất kết nối) không được biến thành cơn mưa giấy. */
export const MAX_FLOWS_PER_DIFF = 12;

const byId = <T extends { id: number }>(list: T[]): Map<number, T> => new Map(list.map((x) => [x.id, x]));

/**
 * Những tờ giấy cần bay giữa hai lần cập nhật dữ liệu:
 *  - bạn tạo yêu cầu: Chủ → Giám đốc; Giám đốc giao việc lớn: Giám đốc → Trưởng nhóm; bạn giao thẳng việc lớn: Chủ → Trưởng nhóm;
 *  - Trưởng nhóm chia việc: Trưởng nhóm → nhân viên (việc lẻ bạn giao: Chủ → nhân viên);
 *  - nhân viên nộp bài: nhân viên → Trưởng nhóm; bị trả lại làm lại: Trưởng nhóm → nhân viên (giấy đỏ);
 *  - nhân viên hỏi người khác: giấy vàng từ người hỏi tới người được hỏi, trả lời xong thì giấy tím bay lại;
 *  - xong việc, xong việc lớn, xong yêu cầu: vào tủ hồ sơ; kế hoạch hoặc kết quả chờ bạn duyệt: Giám đốc → Chủ.
 */
export function diffFlows(prev: Snapshot, next: Snapshot): Flow[] {
  const prevTasks = byId(prev.tasks);
  const prevJobs = byId(prev.jobs);
  const prevEpics = byId(prev.epics);
  const nextJobs = byId(next.jobs);
  const nextEpics = byId(next.epics);
  const out: Flow[] = [];

  for (const epic of next.epics) {
    const before = prevEpics.get(epic.id);
    if (!before) {
      out.push({ kind: 'assign', from: OWNER, to: epic.director });
      continue;
    }
    if (before.status === epic.status) continue;
    if (epic.status === 'awaiting_plan' || epic.status === 'awaiting_result') out.push({ kind: 'report', from: epic.director, to: OWNER });
    else if (epic.status === 'done') out.push({ kind: 'file', from: epic.director, to: CABINET });
  }

  for (const job of next.jobs) {
    const before = prevJobs.get(job.id);
    if (!before) {
      const epic = job.epic_id === null ? undefined : nextEpics.get(job.epic_id);
      out.push({ kind: 'assign', from: epic ? epic.director : OWNER, to: job.lead });
    } else if (before.status !== 'done' && job.status === 'done') {
      out.push({ kind: 'file', from: job.lead, to: CABINET });
    }
  }

  const nextTasks = byId(next.tasks);
  for (const task of next.tasks) {
    // Câu hỏi giữa nhân viên: người hỏi → người được hỏi khi có lượt trả lời mới; người trả lời → người hỏi khi trả lời xong.
    if (task.kind === 'answer') {
      const asker = task.subject_id === null ? undefined : nextTasks.get(task.subject_id);
      const before = prevTasks.get(task.id);
      if (asker && !before) out.push({ kind: 'ask', from: asker.member, to: task.member });
      else if (asker && before && before.status !== 'done' && task.status === 'done') out.push({ kind: 'reply', from: task.member, to: asker.member });
      continue;
    }
    if (task.kind !== 'work') continue;
    const job = task.job_id === null ? undefined : nextJobs.get(task.job_id);
    const before = prevTasks.get(task.id);
    if (!before) {
      out.push({ kind: 'assign', from: job ? job.lead : OWNER, to: task.member });
      continue;
    }
    if (job && before.status === 'running' && task.status === 'submitted') out.push({ kind: 'report', from: task.member, to: job.lead });
    if (job && task.revisions > before.revisions) out.push({ kind: 'return', from: job.lead, to: task.member });
    if (before.status !== 'done' && task.status === 'done') out.push({ kind: 'file', from: task.member, to: CABINET });
  }

  return out.slice(0, MAX_FLOWS_PER_DIFF);
}


// ---------------------------------------------------------------------------------------------------------------
// Chỗ đứng và đường đi
// ---------------------------------------------------------------------------------------------------------------

export interface Pt {
  x: number;
  z: number;
}

export type { Stand };
export { BODY_RADIUS };

/** Kích thước chiếc bàn làm việc (nửa rộng, nửa sâu) khi kiểm tra va chạm. */
export const DESK_HALF_W = 1.1;
export const DESK_HALF_D = 0.55;

/**
 * Chỗ đứng của người thứ `slot` ở `place`: do bố cục quy định (quanh bàn họp, trước quầy pantry, trước kệ sách...).
 * Chỗ ngồi thì là chỗ của chính người đó.
 */
export function standSpot(layout: OfficeLayout, person: PersonSpot, place: Place, slot: number): Stand {
  if (place === 'desk') return { x: person.x, z: person.z, face: person.facing };
  const list = layout.stands[place];
  if (!list || list.length === 0) return { x: person.x, z: person.z, face: person.facing };
  return list[slot % list.length];
}

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Mọi vật cản trên mặt bằng (tường, đồ đạc, bàn của từng người), chưa nới theo độ rộng thân người. */
export function blockers(layout: OfficeLayout): Rect[] {
  const out: Rect[] = [];
  for (const w of layout.wallSegs) {
    const t = (w.kind === 'outer' ? OUTER_T : WALL_T) / 2;
    out.push({ x0: Math.min(w.x0, w.x1) - t, x1: Math.max(w.x0, w.x1) + t, z0: Math.min(w.z0, w.z1) - t, z1: Math.max(w.z0, w.z1) + t });
  }
  for (const o of layout.furniture) out.push({ x0: o.x - o.hw, x1: o.x + o.hw, z0: o.z - o.hd, z1: o.z + o.hd });
  for (const p of layout.people) out.push({ x0: p.deskX - DESK_HALF_W, x1: p.deskX + DESK_HALF_W, z0: p.deskZ - DESK_HALF_D, z1: p.deskZ + DESK_HALF_D });
  return out;
}

const CELL = 0.2;

interface Nav {
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  blocked: Uint8Array;
}

const navCache = new WeakMap<OfficeLayout, Nav>();

function navOf(layout: OfficeLayout): Nav {
  const cached = navCache.get(layout);
  if (cached) return cached;
  const { minX, maxX, minZ, maxZ } = layout.walls;
  const cols = Math.ceil((maxX - minX) / CELL);
  const rows = Math.ceil((maxZ - minZ) / CELL);
  const blocked = new Uint8Array(cols * rows);
  const pad = BODY_RADIUS + 0.1; // dư một nửa ô lưới để làm tròn ô không làm thân người chạm vào đồ
  for (const r of blockers(layout)) {
    const c0 = Math.max(Math.floor((r.x0 - pad - minX) / CELL), 0);
    const c1 = Math.min(Math.ceil((r.x1 + pad - minX) / CELL), cols - 1);
    const r0 = Math.max(Math.floor((r.z0 - pad - minZ) / CELL), 0);
    const r1 = Math.min(Math.ceil((r.z1 + pad - minZ) / CELL), rows - 1);
    for (let row = r0; row <= r1; row += 1) {
      const z = minZ + (row + 0.5) * CELL;
      if (z < r.z0 - pad || z > r.z1 + pad) continue;
      for (let col = c0; col <= c1; col += 1) {
        const x = minX + (col + 0.5) * CELL;
        if (x >= r.x0 - pad && x <= r.x1 + pad) blocked[row * cols + col] = 1;
      }
    }
  }
  const nav = { minX, minZ, cols, rows, blocked };
  navCache.set(layout, nav);
  return nav;
}

const cellOf = (nav: Nav, p: Pt) => ({ c: Math.floor((p.x - nav.minX) / CELL), r: Math.floor((p.z - nav.minZ) / CELL) });
const inGrid = (nav: Nav, c: number, r: number) => c >= 0 && r >= 0 && c < nav.cols && r < nav.rows;
const freeCell = (nav: Nav, c: number, r: number) => inGrid(nav, c, r) && nav.blocked[r * nav.cols + c] === 0;

/** Chỗ (x, z) có đi được không (nằm trong ô lưới trống). */
export function walkable(layout: OfficeLayout, x: number, z: number): boolean {
  const nav = navOf(layout);
  const { c, r } = cellOf(nav, { x, z });
  return freeCell(nav, c, r);
}

/** Đi thẳng từ a tới b được không (không qua ô bị chặn). Hai đầu mút được bỏ qua trong 0,4 m đầu để chỗ xuất phát sát bàn vẫn đi được. */
function lineClear(nav: Nav, a: Pt, b: Pt): boolean {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(Math.ceil(len / 0.06), 1);
  for (let i = 0; i <= steps; i += 1) {
    const d = (len * i) / steps;
    if (d < 0.4 || len - d < 0.4) continue;
    const p = { x: a.x + ((b.x - a.x) * i) / steps, z: a.z + ((b.z - a.z) * i) / steps };
    const { c, r } = cellOf(nav, p);
    if (!freeCell(nav, c, r)) return false;
  }
  return true;
}

/** Ô trống gần nhất với p (tìm theo vòng tròn mở rộng dần). */
function nearestFree(nav: Nav, c: number, r: number): { c: number; r: number } | null {
  if (freeCell(nav, c, r)) return { c, r };
  for (let ring = 1; ring < 12; ring += 1) {
    let best: { c: number; r: number } | null = null;
    let bestD = Infinity;
    for (let dr = -ring; dr <= ring; dr += 1) {
      for (let dc = -ring; dc <= ring; dc += 1) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        if (!freeCell(nav, c + dc, r + dr)) continue;
        const d = dc * dc + dr * dr;
        if (d < bestD) {
          bestD = d;
          best = { c: c + dc, r: r + dr };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** Hàng đợi ưu tiên nhị phân nhỏ gọn cho A*. */
class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, val: number) {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0];
    const lastK = k.pop() as number;
    const lastV = v.pop() as number;
    if (k.length > 0) {
      k[0] = lastK;
      v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

const SQRT2 = Math.SQRT2;
const DIRS: [number, number, number][] = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]];

/** Đường ngắn nhất trên lưới (A*) từ ô a tới ô b; null nếu không có đường. */
function search(nav: Nav, a: { c: number; r: number }, b: { c: number; r: number }): { c: number; r: number }[] | null {
  const { cols, rows } = nav;
  const total = cols * rows;
  const g = new Float32Array(total).fill(Infinity);
  const from = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);
  const start = a.r * cols + a.c;
  const goal = b.r * cols + b.c;
  const h = (c: number, r: number) => {
    const dx = Math.abs(c - b.c);
    const dz = Math.abs(r - b.r);
    return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz);
  };
  const open = new Heap();
  g[start] = 0;
  open.push(h(a.c, a.r), start);
  while (open.size > 0) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) {
      const path: { c: number; r: number }[] = [];
      for (let n = cur; n !== -1; n = from[n]) path.push({ c: n % cols, r: Math.floor(n / cols) });
      return path.reverse();
    }
    const cc = cur % cols;
    const cr = Math.floor(cur / cols);
    for (const [dc, dr, cost] of DIRS) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (!freeCell(nav, nc, nr)) continue;
      if (dc !== 0 && dr !== 0 && (!freeCell(nav, cc + dc, cr) || !freeCell(nav, cc, cr + dr))) continue; // không cắt góc
      const id = nr * cols + nc;
      if (closed[id]) continue;
      const ng = g[cur] + cost;
      if (ng < g[id]) {
        g[id] = ng;
        from[id] = cur;
        open.push(ng + h(nc, nr), id);
      }
    }
  }
  return null;
}

/**
 * Đường đi (các điểm gấp khúc) từ `start` (chỗ đang đứng) tới `target`: tìm đường ngắn nhất trên lưới quanh tường, cửa,
 * bàn và đồ đạc của tầng rồi kéo thẳng các đoạn thừa. Điểm đầu là `start`, điểm cuối là `target`. Trả về chỉ [start, target]
 * nếu không có đường đi (không nên xảy ra; bài kiểm thử bảo đảm mọi chỗ ngồi tới được mọi chỗ đứng).
 */
export function planPath(layout: OfficeLayout, _person: PersonSpot, _from: Place, start: Pt, _to: Place, target: Pt): Pt[] {
  const nav = navOf(layout);
  const sc = cellOf(nav, start);
  const tc = cellOf(nav, target);
  const a = nearestFree(nav, sc.c, sc.r);
  const b = nearestFree(nav, tc.c, tc.r);
  if (!a || !b) return [start, target];
  const cells = search(nav, a, b);
  if (!cells) return [start, target];
  const pts: Pt[] = cells.map((cell) => ({ x: nav.minX + (cell.c + 0.5) * CELL, z: nav.minZ + (cell.r + 0.5) * CELL }));
  // Thay hai đầu bằng điểm thật, rồi kéo thẳng bằng cách nhảy tới điểm xa nhất nhìn thấy được.
  pts[0] = start;
  pts[pts.length - 1] = target;
  const out: Pt[] = [start];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !lineClear(nav, pts[i], pts[j])) j -= 1;
    out.push(pts[j]);
    i = j;
  }
  // Bỏ các điểm trùng nhau.
  return out.filter((p, k) => k === 0 || Math.hypot(p.x - out[k - 1].x, p.z - out[k - 1].z) > 1e-6);
}

function firstHit<T>(path: Pt[], test: (p: Pt) => T | null): T | null {
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    const steps = Math.max(Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.05), 1);
    for (let s = 0; s <= steps; s += 1) {
      const found = test({ x: a.x + ((b.x - a.x) * s) / steps, z: a.z + ((b.z - a.z) * s) / steps });
      if (found !== null) return found;
    }
  }
  if (path.length === 1) return test(path[0]);
  return null;
}

/** Đồ đạc nào mà đường đi cắt qua (nới `pad` quanh đồ), hoặc null. Dùng để kiểm thử. */
export function obstacleHitBy(layout: OfficeLayout, path: Pt[], pad = BODY_RADIUS * 0.7): string | null {
  return firstHit(path, (p) => {
    for (const o of layout.furniture) if (Math.abs(p.x - o.x) < o.hw + pad && Math.abs(p.z - o.z) < o.hd + pad) return o.id;
    return null;
  });
}

/** Bàn nào (của người khác hoặc của chính mình) mà đường đi cắt qua, hoặc null. Dùng để kiểm thử. */
export function deskHitBy(layout: OfficeLayout, path: Pt[], pad = BODY_RADIUS * 0.7): string | null {
  return firstHit(path, (p) => {
    for (const q of layout.people) if (Math.abs(p.x - q.deskX) < DESK_HALF_W + pad && Math.abs(p.z - q.deskZ) < DESK_HALF_D + pad) return q.name;
    return null;
  });
}

/** Đoạn tường nào mà đường đi cắt qua, hoặc null. Dùng để kiểm thử. */
export function wallHitBy(layout: OfficeLayout, path: Pt[]): string | null {
  return firstHit(path, (p) => {
    for (const w of layout.wallSegs) {
      const t = (w.kind === 'outer' ? OUTER_T : WALL_T) / 2;
      if (p.x > Math.min(w.x0, w.x1) - t && p.x < Math.max(w.x0, w.x1) + t && p.z > Math.min(w.z0, w.z1) - t && p.z < Math.max(w.z0, w.z1) + t) {
        return `${w.x0},${w.z0}→${w.x1},${w.z1}`;
      }
    }
    return null;
  });
}
