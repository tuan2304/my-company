/**
 * Bố cục văn phòng. Hàm thuần: nhận danh sách team từ /api/state và trả về vị trí của mọi thứ,
 * nên kiểm thử được mà không cần WebGL. File này chỉ dùng cú pháp TypeScript "xóa được" (không enum, không tham số thuộc
 * tính) để Node chạy thẳng được trong bài kiểm thử.
 *
 * Tòa nhà có HÌNH DẠNG CỐ ĐỊNH (40 × 26 m, tỉ lệ khoảng 3:2) như một mặt bằng văn phòng thật. Thêm team không làm tòa nhà
 * dài ra: mỗi team (tối đa bốn người một cụm bàn) lấp một ô trống trong khu làm việc mở; hết chỗ thì sang TẦNG MỚI (cùng
 * hình dạng, đủ phòng chức năng). Hệ tọa độ (mét): x sang phải, z hướng về phía camera (xuống màn hình 2D), y hướng lên.
 *
 * Tầng 1 (x từ -20 tới 20, z từ -13 tới 13):
 *
 *   z -13 ┌ Thư viện ┬ Thang ┬ Server ┬ Pantry ┬ WC ┬ Họp 1 ┬ Giám đốc ┐
 *   z  -5 ├──────────┴───────┴────────┴────────┴────┴───────┴──────────┤   ← hành lang giữa, khu nghỉ ở bên trái
 *   z 0.5 ├ Chủ ┬ Hồ sơ ┬ Họp lớn ┬ Sảnh ┬ khu làm việc mở (sáu cụm bàn) ┤
 *   z  13 └─────┴───────┴─────────┴──┬───┴──────────────────────────────┘ (cửa vào ở sảnh)
 *
 * Tầng 2 trở lên: cùng dải trên (phòng Giám đốc thành phòng tập trung), dải dưới chỉ có Hồ sơ, họp và khu làm việc mở rộng
 * (mười cụm bàn). Mỗi tầng tự có thư viện, server, pantry, WC, họp và khu nghỉ nên nhân viên không phải đi giữa các tầng.
 *
 * Người đi bộ tìm đường trên lưới (xem flow.ts) quanh tường, cửa, bàn và đồ đạc do file này mô tả.
 */
import type { Member, TeamSummary } from '../lib/types';
import type { Place } from './status';

// ---------------------------------------------------------------------------------------------------------------
// Hằng số
// ---------------------------------------------------------------------------------------------------------------

export const POD_W = 4.6; // bề ngang một cụm bàn (hai bàn rộng 2,2 m cạnh nhau)
export const POD_D = 4.6; // bề sâu một cụm (hai hàng bàn đối mặt, tính cả ghế)
export const SEAT_DX = 1.2; // chỗ ngồi lệch tâm cụm sang trái/phải
export const SEAT_DZ = 1.7; // chỗ ngồi lệch tâm cụm lên bắc/xuống nam (hai hàng bàn sát nhau ở giữa)
export const SEATS_PER_POD = 4;
export const MAX_PODS_PER_GROUP = 3; // một nhóm tối đa ba cụm liền nhau (mười hai người); đông hơn thì tách nhóm
export const TEAM_COLORS = [0x3b82f6, 0x10b981, 0xf59e0b, 0xa855f7, 0xef4444, 0x06b6d4] as const;

export const X0 = -20;
export const X1 = 20;
export const Z0 = -13;
export const Z1 = 13;
export const TOP_Z = -5; // mép nam của dải phòng phía trên
export const MID_Z = 0.5; // mép bắc của dải phòng phía dưới
export const WALL_T = 0.14; // bề dày tường trong
export const OUTER_T = 0.3; // bề dày tường ngoài
export const DOOR_W = 1.4;
export const BODY_RADIUS = 0.3;

const PODS_PER_ROW = [3, 5]; // tầng 1, các tầng sau

// ---------------------------------------------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------------------------------------------

export interface PersonSpot {
  name: string;
  role: string;
  title: string;
  model: string;
  isLead: boolean;
  isDirector: boolean;
  teamId: string;
  teamName: string;
  colorIndex: number;
  floor: number;
  x: number;
  z: number;
  /** Hướng nhìn (radian quanh trục y): 0 là nhìn về +z (hàng bắc), π là nhìn về -z (hàng nam). */
  facing: number;
  deskX: number;
  deskZ: number;
}

export interface Zone {
  id: string;
  name: string;
  lead: string | null;
  colorIndex: number;
  x: number;
  z: number;
  w: number;
  d: number;
}

export type RoomId =
  | 'owner' | 'director' | 'focus' | 'meeting1' | 'meeting2' | 'library' | 'server' | 'archive'
  | 'wc' | 'pantry' | 'stairs' | 'rest' | 'lobby' | 'hall' | 'openplan';

export interface RoomBox {
  id: RoomId;
  label: string;
  x: number;
  z: number;
  w: number;
  d: number;
}

export type FloorStyle = 'wood' | 'carpet' | 'tile' | 'marble' | 'server' | 'stone' | 'dark';

export type TileKind = 'zone' | 'room' | 'rug';

/** Một mảng sàn: phòng, hành lang, thảm dưới cụm bàn của team. */
export interface Tile {
  id: string;
  kind: TileKind;
  label: string;
  x: number;
  z: number;
  w: number;
  d: number;
  /** Chỉ số màu team, hoặc -1 nếu không thuộc team nào. */
  colorIndex: number;
  floor: FloorStyle;
  color: number;
}

export type WallKind = 'outer' | 'solid' | 'glass';
type WallSpec = WallKind | 'none';

/** Đoạn tường song song với một trục (x0 = x1 hoặc z0 = z1). Chỗ có cửa đã được cắt chừa khe. */
export interface Wall {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  kind: WallKind;
}

/** Cửa: `axis` là phương của bức tường ('x' là tường nằm ngang trên mặt bằng); (x, z) là tâm khe cửa. */
export interface Door {
  x: number;
  z: number;
  w: number;
  axis: 'x' | 'z';
  room: string;
  /** 'glass' là cửa lối vào bằng kính; 'door' là cửa phòng thường. */
  kind: 'door' | 'glass';
}

export type ObstacleKind =
  | 'plant' | 'sofa' | 'armchair' | 'beanbag' | 'counter' | 'table' | 'bigtable' | 'readtable' | 'cabinet' | 'bookcase' | 'desk'
  | 'easel' | 'cooler' | 'fridge' | 'reception' | 'rack' | 'stairs' | 'stall' | 'printer' | 'bin' | 'foosball' | 'aquarium'
  | 'hedge' | 'lamp' | 'stool';

/** Đồ đạc người đi bộ phải tránh (hình chữ nhật trên mặt bằng, nửa chiều rộng hw theo x và nửa chiều sâu hd theo z). */
export interface Obstacle {
  id: string;
  kind: ObstacleKind;
  x: number;
  z: number;
  hw: number;
  hd: number;
  /** Hướng mặt trước của đồ (radian): 0 nhìn về +z, π/2 nhìn về +x, π nhìn về -z, -π/2 nhìn về -x. */
  facing: number;
  /** Màu chủ đạo (nếu có). */
  color?: number;
}

export type DecorKind = 'clock' | 'frame' | 'tv' | 'board' | 'logo' | 'mat';

/** Đồ trang trí không cản đường: treo tường hoặc dẹt trên sàn. (x, z) là tâm trên mặt bằng, y là độ cao (m) với đồ treo tường. */
export interface Decor {
  id: string;
  kind: DecorKind;
  x: number;
  z: number;
  y: number;
  /** Hướng mặt của đồ (radian): tường phía bắc thì mặt hướng 0 (về +z). */
  facing: number;
  w: number;
  h: number;
  color: number;
}

export interface Stand {
  x: number;
  z: number;
  /** Hướng nhìn (radian). */
  face: number;
}

export interface OfficeLayout {
  /** Tầng này là tầng thứ mấy (0 là tầng 1) và cả tòa có bao nhiêu tầng. */
  floor: number;
  floorCount: number;
  /** Hình chữ nhật tòa nhà (mép ngoài tường). */
  walls: { minX: number; maxX: number; minZ: number; maxZ: number };
  width: number;
  depth: number;
  tiles: Tile[];
  wallSegs: Wall[];
  doors: Door[];
  furniture: Obstacle[];
  decor: Decor[];
  /** Tâm các cụm bàn (bốn bàn đối mặt nhau) của từng khu team. */
  pods: { zoneId: string; x: number; z: number }[];
  zones: Zone[];
  /** Mọi phòng và khu chức năng (không gồm khu team). */
  rooms: RoomBox[];
  /** Khu nghỉ: cả công ty ra đây khi hết hạn mức Pro. */
  lounge: { x: number; z: number; w: number; d: number };
  /** Điểm tờ giấy bay tới khi vào tủ hồ sơ. */
  cabinet: { x: number; z: number };
  /** Điểm giấy của Chủ bay từ đó (bàn Chủ ở tầng 1, chân cầu thang ở các tầng trên). */
  owner: { x: number; z: number };
  /** Máy pha cà phê (nơi hơi nước bay lên). */
  coffee: { x: number; z: number };
  /** Cửa vào tòa nhà (chỉ tầng 1). */
  entrance: { x: number; z: number } | null;
  /** Chỗ đứng ở từng nơi (người thứ `slot` đứng ở phần tử thứ `slot`). */
  stands: Record<Exclude<Place, 'desk'>, Stand[]>;
  people: PersonSpot[];
}

export interface Building {
  floors: OfficeLayout[];
  /** Tên người → số tầng (0 là tầng 1). */
  floorOf: Record<string, number>;
  people: PersonSpot[];
}

const isDirector = (m: Member) => m.role === 'director';

// ---------------------------------------------------------------------------------------------------------------
// Dựng một tầng
// ---------------------------------------------------------------------------------------------------------------

interface Group {
  id: string;
  team: TeamSummary;
  members: Member[];
  colorIndex: number;
  pods: number;
}

interface Placement {
  group: Group;
  row: number;
  col: number;
}

function spot(m: Member, team: TeamSummary, colorIndex: number, floor: number, x: number, z: number, facing: number): PersonSpot {
  return {
    name: m.name,
    role: m.role,
    title: m.title,
    model: m.model,
    isLead: m.isLead,
    isDirector: isDirector(m),
    teamId: team.id,
    teamName: team.name,
    colorIndex,
    floor,
    x,
    z,
    facing,
    deskX: x,
    deskZ: z + 1.15 * Math.cos(facing),
  };
}

/** Thứ tự chỗ ngồi trong cụm: hai người đầu ngồi chéo nhau cho đỡ trống. 0 bắc-trái, 1 nam-phải, 2 bắc-phải, 3 nam-trái. */
const SEAT_ORDER = [
  { left: true, north: true },
  { left: false, north: false },
  { left: false, north: true },
  { left: true, north: false },
];

/** Đường tâm của các hàng cụm bàn (z) ở khu mở. */
const ROW_Z = [3.6, 10.3];

function openPlanRect(floor: number): { x0: number; x1: number } {
  return floor === 0 ? { x0: 2, x1: 20 } : { x0: -9, x1: 20 };
}

/** Tâm cụm bàn ở hàng `row`, cột `col` của tầng `floor`. */
export function podCenter(floor: number, row: number, col: number): { x: number; z: number } {
  const { x0, x1 } = openPlanRect(floor);
  const cols = PODS_PER_ROW[Math.min(floor, 1)];
  const margin = 0.7;
  const gap = (x1 - x0 - 2 * margin - cols * POD_W) / (cols - 1);
  return { x: x0 + margin + POD_W / 2 + col * (POD_W + gap), z: ROW_Z[row] };
}

export function podsPerRow(floor: number): number {
  return PODS_PER_ROW[Math.min(floor, 1)];
}

/** Chia các team thành nhóm (một nhóm một khu liền nhau, tối đa MAX_PODS_PER_GROUP cụm) và xếp vào các tầng. */
function planGroups(workTeams: TeamSummary[]): Placement[][] {
  const groups: Group[] = [];
  workTeams.forEach((team, colorIndex) => {
    const ordered = [...team.members.filter((m) => m.isLead), ...team.members.filter((m) => !m.isLead)];
    const chunk = MAX_PODS_PER_GROUP * SEATS_PER_POD;
    for (let i = 0; i < ordered.length; i += chunk) {
      const members = ordered.slice(i, i + chunk);
      groups.push({ id: i === 0 ? team.id : `${team.id}~${i / chunk + 1}`, team, members, colorIndex, pods: Math.ceil(members.length / SEATS_PER_POD) });
    }
  });
  const floors: Placement[][] = [[]];
  let used = [0, 0];
  for (const group of groups) {
    for (;;) {
      const f = floors.length - 1;
      const cols = podsPerRow(f);
      const row = used.findIndex((u) => u + group.pods <= cols);
      if (row >= 0) {
        floors[f].push({ group, row, col: used[row] });
        used[row] += group.pods;
        break;
      }
      floors.push([]);
      used = [0, 0];
    }
  }
  return floors;
}

interface RoomSpec {
  id: RoomId;
  label: string;
  x0: number;
  x1: number;
  doorX: number | null;
  /** Kiểu tường phía nam của phòng; 'none' là mở hẳn ra hành lang (pantry). */
  wall: WallSpec;
  floor: FloorStyle;
  color: number;
}

export function layoutBuilding(teams: TeamSummary[]): Building {
  const directors = teams.filter((t) => t.members.some(isDirector));
  const workTeams = teams.filter((t) => !t.members.some(isDirector) && t.members.length > 0);
  const plan = planGroups(workTeams);
  const floors = plan.map((placements, index) => buildFloor(index, plan.length, placements, index === 0 ? directors : []));
  const people = floors.flatMap((f) => f.people);
  const floorOf: Record<string, number> = {};
  for (const p of people) floorOf[p.name] = p.floor;
  return { floors, floorOf, people };
}

/** Một tầng của tòa nhà (mặc định tầng 1). Giữ lại để dùng gọn khi chỉ cần một tầng. */
export function layoutOffice(teams: TeamSummary[], floor = 0): OfficeLayout {
  const b = layoutBuilding(teams);
  return b.floors[Math.min(Math.max(floor, 0), b.floors.length - 1)];
}

function buildFloor(floor: number, floorCount: number, placements: Placement[], directors: TeamSummary[]): OfficeLayout {
  const ground = floor === 0;
  const tiles: Tile[] = [];
  const wallSegs: Wall[] = [];
  const doors: Door[] = [];
  const furniture: Obstacle[] = [];
  const decor: Decor[] = [];
  const zones: Zone[] = [];
  const pods: { zoneId: string; x: number; z: number }[] = [];
  const people: PersonSpot[] = [];
  const rooms: RoomBox[] = [];

  const ob = (kind: ObstacleKind, id: string, x: number, z: number, hw: number, hd: number, facing = 0, color?: number) => {
    furniture.push({ id, kind, x, z, hw, hd, facing, color });
  };
  const plant = (id: string, x: number, z: number) => ob('plant', id, x, z, 0.4, 0.4);
  const dec = (kind: DecorKind, id: string, x: number, z: number, y: number, facing: number, w: number, h: number, color = 0xffffff) => {
    decor.push({ id, kind, x, z, y, facing, w, h, color });
  };
  const addRoom = (id: RoomId, label: string, x0: number, x1: number, z0: number, z1: number, floorStyle: FloorStyle, color: number, kind: TileKind = 'room'): RoomBox => {
    const box: RoomBox = { id, label, x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 };
    rooms.push(box);
    tiles.push({ id, kind, label, x: box.x, z: box.z, w: box.w, d: box.d, colorIndex: -1, floor: floorStyle, color });
    return box;
  };
  const rug = (id: string, x: number, z: number, w: number, d: number, color: number, style: FloorStyle = 'carpet') => {
    tiles.push({ id, kind: 'rug', label: '', x, z, w, d, colorIndex: -1, floor: style, color });
  };
  const byId = (id: RoomId) => rooms.find((r) => r.id === id) as RoomBox;

  // ---------- Tường ngoài (cửa vào ở tường nam của sảnh, chỉ tầng 1) ----------
  const ENTRANCE_X = -0.5;
  const ENTRANCE_W = 2.6;
  wallSegs.push({ x0: X0, z0: Z0, x1: X1, z1: Z0, kind: 'outer' });
  wallSegs.push({ x0: X0, z0: Z0, x1: X0, z1: Z1, kind: 'outer' });
  wallSegs.push({ x0: X1, z0: Z0, x1: X1, z1: Z1, kind: 'outer' });
  if (ground) {
    wallSegs.push({ x0: X0, z0: Z1, x1: ENTRANCE_X - ENTRANCE_W / 2, z1: Z1, kind: 'outer' });
    wallSegs.push({ x0: ENTRANCE_X + ENTRANCE_W / 2, z0: Z1, x1: X1, z1: Z1, kind: 'outer' });
    doors.push({ x: ENTRANCE_X, z: Z1, w: ENTRANCE_W, axis: 'x', room: 'lobby', kind: 'glass' });
  } else wallSegs.push({ x0: X0, z0: Z1, x1: X1, z1: Z1, kind: 'outer' });

  /** Tường nằm ngang (z cố định) từ x0 tới x1, chừa khe cửa ở các tâm `gaps` (mỗi khe rộng w). */
  const hwall = (z: number, x0: number, x1: number, kind: WallKind, gaps: { x: number; w: number }[], room: string) => {
    let cur = x0;
    for (const g of [...gaps].sort((a, b) => a.x - b.x)) {
      if (g.x - g.w / 2 > cur) wallSegs.push({ x0: cur, z0: z, x1: g.x - g.w / 2, z1: z, kind });
      cur = g.x + g.w / 2;
      doors.push({ x: g.x, z, w: g.w, axis: 'x', room, kind: 'door' });
    }
    if (x1 > cur) wallSegs.push({ x0: cur, z0: z, x1, z1: z, kind });
  };
  const vwall = (x: number, z0: number, z1: number, kind: WallKind = 'solid') => wallSegs.push({ x0: x, z0, x1: x, z1: z1, kind });

  // ---------- Dải trên: bảy phòng ----------
  const top: RoomSpec[] = [
    { id: 'library', label: 'Thư viện', x0: -20, x1: -12, doorX: -16, wall: 'glass', floor: 'wood', color: 0xd2ad7e },
    { id: 'stairs', label: 'Cầu thang', x0: -12, x1: -7.5, doorX: -9.75, wall: 'solid', floor: 'stone', color: 0xd4d0dc },
    { id: 'server', label: 'Phòng server', x0: -7.5, x1: -3, doorX: -5.25, wall: 'solid', floor: 'server', color: 0x4b4f63 },
    { id: 'pantry', label: 'Pantry', x0: -3, x1: 2.5, doorX: null, wall: 'none', floor: 'tile', color: 0xf3dcb4 },
    { id: 'wc', label: 'WC', x0: 2.5, x1: 6, doorX: 4.25, wall: 'solid', floor: 'tile', color: 0xcfe8ee },
    { id: 'meeting1', label: 'Phòng họp 1', x0: 6, x1: 12.5, doorX: 9.25, wall: 'glass', floor: 'carpet', color: 0xbdd2ea },
    ground
      ? { id: 'director', label: 'Phòng Giám đốc', x0: 12.5, x1: 20, doorX: 13.6, wall: 'glass', floor: 'carpet', color: 0xcbbde3 }
      : { id: 'focus', label: 'Phòng tập trung', x0: 12.5, x1: 20, doorX: 13.6, wall: 'glass', floor: 'carpet', color: 0xd9d2ec },
  ];
  for (const s of top) {
    addRoom(s.id, s.label, s.x0, s.x1, Z0, TOP_Z, s.floor, s.color);
    if (s.wall !== 'none') hwall(TOP_Z, s.x0, s.x1, s.wall, s.doorX === null ? [] : [{ x: s.doorX, w: DOOR_W }], s.id);
    if (s.x0 > X0) vwall(s.x0, Z0, TOP_Z);
  }

  // ---------- Dải dưới: bên trái là phòng, bên phải là khu làm việc mở ----------
  const bottom: RoomSpec[] = ground
    ? [
      { id: 'owner', label: 'Phòng Chủ', x0: -20, x1: -15, doorX: -16.2, wall: 'solid', floor: 'wood', color: 0xe0b57a },
      { id: 'archive', label: 'Hồ sơ', x0: -15, x1: -11, doorX: -13, wall: 'solid', floor: 'carpet', color: 0xe3dad2 },
      { id: 'meeting2', label: 'Phòng họp lớn', x0: -11, x1: -3, doorX: -7, wall: 'glass', floor: 'carpet', color: 0xc9d1e6 },
    ]
    : [
      { id: 'archive', label: 'Hồ sơ', x0: -20, x1: -16, doorX: -18, wall: 'solid', floor: 'carpet', color: 0xe3dad2 },
      { id: 'meeting2', label: 'Phòng họp lớn', x0: -16, x1: -9, doorX: -12.5, wall: 'glass', floor: 'carpet', color: 0xc9d1e6 },
    ];
  for (const s of bottom) {
    addRoom(s.id, s.label, s.x0, s.x1, MID_Z, Z1, s.floor, s.color);
    if (s.wall !== 'none') hwall(MID_Z, s.x0, s.x1, s.wall, s.doorX === null ? [] : [{ x: s.doorX, w: DOOR_W }], s.id);
    if (s.x0 > X0) vwall(s.x0, MID_Z, Z1);
  }
  const lastBottomX = bottom[bottom.length - 1].x1;
  vwall(lastBottomX, MID_Z, Z1);
  if (ground) addRoom('lobby', 'Sảnh lễ tân', lastBottomX, 2, MID_Z, Z1, 'marble', 0xe4dcd4);
  const open = openPlanRect(floor);
  addRoom('openplan', 'Khu làm việc', open.x0, open.x1, MID_Z, Z1, 'wood', 0xe8d9c3);

  // ---------- Hành lang giữa và khu nghỉ ----------
  addRoom('rest', 'Khu nghỉ', X0, -4, TOP_Z, MID_Z, 'wood', 0xe6c9a0);
  addRoom('hall', 'Hành lang', -4, X1, TOP_Z, MID_Z, 'wood', 0xe8d9c3);
  rug('runner-h', 8, -2.25, 24, 2.2, 0x6a6c7a, 'dark');
  if (ground) rug('runner-v', -0.5, 6.5, 2.2, 12.2, 0x6a6c7a, 'dark');

  // ====================== Đồ đạc từng phòng ======================
  // ----- Thư viện: kệ sách sát tường bắc, một bàn đọc dài, kệ bên tường tây -----
  ob('bookcase', 'library-shelf', -16, -12.45, 3.3, 0.35, 0);
  ob('readtable', 'library-table', -14.8, -8.3, 2.2, 0.95, 0);
  plant('plant-library', -19.3, -5.8);
  ob('lamp', 'library-lamp', -19.3, -10.4, 0.2, 0.2);
  dec('frame', 'frame-library', -19.88, -8.0, 1.9, Math.PI / 2, 0.8, 0.6, 0x9b6df0);

  // ----- Cầu thang -----
  ob('stairs', 'stairs', -9.75, -9.6, 1.6, 3.0, 0);

  // ----- Phòng server -----
  ob('rack', 'racks', -5.25, -12.2, 2.0, 0.55, 0);
  ob('bin', 'bin-server', -3.55, -5.7, 0.2, 0.2);

  // ----- Pantry -----
  ob('counter', 'pantry-counter', -0.25, -12.4, 1.4, 0.4, 0);
  ob('cooler', 'pantry-cooler', -2.35, -12.5, 0.3, 0.3, 0);
  ob('fridge', 'pantry-fridge', 1.65, -12.45, 0.45, 0.4, 0);
  ob('table', 'pantry-table', -0.25, -8.6, 0.55, 0.55);
  ob('stool', 'pantry-stool-a', -1.15, -8.6, 0.22, 0.22);
  ob('stool', 'pantry-stool-b', 0.65, -8.6, 0.22, 0.22);
  ob('bin', 'bin-pantry', 2.05, -6.1, 0.2, 0.2);
  const coffee = { x: -0.95, z: -12.4 };
  dec('frame', 'frame-pantry', -0.25, -12.86, 1.8, 0, 0.9, 0.55, 0xf0a44b);

  // ----- WC: hai buồng, bồn rửa tay -----
  ob('stall', 'wc-stall-a', 3.35, -11.9, 0.55, 0.9, 0);
  ob('stall', 'wc-stall-b', 4.7, -11.9, 0.55, 0.9, 0);
  ob('counter', 'wc-sink', 2.9, -8.4, 0.3, 0.9, Math.PI / 2);

  // ----- Phòng họp 1 -----
  ob('bigtable', 'meeting1-table', 9.25, -9.0, 1.5, 2.1, 0);
  dec('tv', 'tv-meeting1', 9.25, -12.9, 1.45, 0, 1.7, 0.95, 0x20242f);
  plant('plant-meeting1', 11.9, -5.8);

  // ----- Phòng Giám đốc (tầng 1) / phòng tập trung (tầng trên) -----
  if (ground) {
    dec('frame', 'frame-director', 16.4, -12.86, 2.0, 0, 1.0, 0.7, 0xf2a6b3);
    ob('easel', 'director-board', 18.3, -12.1, 0.9, 0.2, 0);
    ob('sofa', 'director-sofa-a', 15.3, -7.6, 0.5, 1.1, Math.PI / 2, 0x8c7ae6);
    ob('sofa', 'director-sofa-b', 19.1, -7.6, 0.5, 1.1, -Math.PI / 2, 0x8c7ae6);
    ob('table', 'director-table', 17.2, -7.6, 0.45, 0.45);
    rug('rug-director', 17.2, -7.6, 5.4, 2.8, 0xa592e8);
    plant('plant-director', 19.4, -5.8);
    plant('plant-director-b', 13.15, -12.3);
  } else {
    ob('armchair', 'focus-chair-a', 17.0, -9.0, 0.45, 0.45, Math.PI, 0xf08a4b);
    ob('armchair', 'focus-chair-b', 18.8, -9.0, 0.45, 0.45, Math.PI, 0x4fa7a0);
    ob('table', 'focus-table', 17.9, -11.4, 0.5, 0.5);
    plant('plant-focus', 19.4, -5.8);
    dec('frame', 'frame-focus', 16.4, -12.86, 2.0, 0, 1.0, 0.7, 0x5b9bd5);
  }

  // ----- Khu nghỉ: ghế sofa đối mặt, bàn thấp, bàn bi lắc, túi lười, kệ sách -----
  rug('rug-rest', -15.3, -2.0, 5.6, 3.4, 0xf2b6c0);
  ob('sofa', 'rest-sofa-a', -17.0, -2.0, 0.5, 1.1, Math.PI / 2, 0x4fa7a0);
  ob('sofa', 'rest-sofa-b', -13.6, -2.0, 0.5, 1.1, -Math.PI / 2, 0xe86f8f);
  ob('table', 'rest-table', -15.3, -2.0, 0.35, 0.5);
  ob('foosball', 'rest-foosball', -8.6, -2.2, 1.0, 0.5, 0);
  ob('beanbag', 'rest-bean-a', -18.9, -4.0, 0.4, 0.4, 0, 0xf08a4b);
  ob('bookcase', 'rest-shelf', -19.5, -2.0, 0.35, 1.2, Math.PI / 2);
  plant('plant-rest-a', -4.6, -0.1);
  plant('plant-rest-b', -19.3, -0.2);
  dec('clock', 'clock', -19.88, -2.25, 2.55, Math.PI / 2, 0.7, 0.7, 0xffffff);

  // ----- Hành lang: cây xanh, tranh, bảng thông báo -----
  plant('plant-hall-a', 19.3, -4.4);
  plant('plant-hall-b', 2.1, -0.3);
  dec('frame', 'frame-hall', 20 - 0.12, -3.0, 2.0, -Math.PI / 2, 0.8, 0.6, 0xf2a6b3);

  // ----- Hành lang: máy in dùng chung và hai dải cây ngăn với khu làm việc mở -----
  ob('printer', 'hall-printer', 10.2, -4.55, 0.4, 0.3, 0);
  // Hai dải cây xanh ngăn hành lang với khu làm việc mở (chừa lối giữa), như mặt bằng mẫu.
  ob('hedge', 'hedge-hall-a', 5.5, 0.15, 2.5, 0.3, 0);
  ob('hedge', 'hedge-hall-b', 14.6, 0.15, 2.4, 0.3, 0);

  // ====================== Phần chỉ có ở tầng 1 ======================
  let ownerPoint = { x: -9.75, z: -4.2 };
  let cabinetPoint = { x: -18.85, z: 3.0 };
  if (ground) {
    // Phòng Chủ: góc tiếp khách và bàn làm việc ở phía nam
    ownerPoint = { x: -17.6, z: 9.7 };
    ob('desk', 'desk-owner', ownerPoint.x, ownerPoint.z + 1.15, 1.1, 0.55, 0);
    rug('rug-owner', -18.2, 4.2, 3.4, 3.4, 0xf2b6c0);
    ob('table', 'owner-table', -18.6, 4.2, 0.5, 0.5);
    ob('armchair', 'owner-chair-a', -19.4, 3.2, 0.45, 0.45, Math.PI / 4, 0xf08a4b);
    ob('armchair', 'owner-chair-b', -17.8, 3.2, 0.45, 0.45, -Math.PI / 4, 0xf08a4b);
    ob('armchair', 'owner-chair-c', -19.4, 5.2, 0.45, 0.45, (3 * Math.PI) / 4, 0xf08a4b);
    ob('armchair', 'owner-chair-d', -17.8, 5.2, 0.45, 0.45, (-3 * Math.PI) / 4, 0xf08a4b);
    ob('bookcase', 'owner-shelf', -19.5, 8.2, 0.35, 1.6, Math.PI / 2);
    plant('plant-owner-a', -19.4, 12.2);
    plant('plant-owner-b', -15.6, 12.2);
    dec('frame', 'frame-owner', -19.88, 11.0, 1.9, Math.PI / 2, 0.8, 0.6, 0xf2a6b3);

    // Hồ sơ: hai dãy tủ sát tường, bàn làm việc, máy in
    ob('cabinet', 'cabinet', -14.62, 5.0, 0.3, 3.8, Math.PI / 2);
    ob('cabinet', 'cabinet-b', -11.38, 5.0, 0.3, 3.8, -Math.PI / 2);
    ob('table', 'archive-table', -13, 11.2, 0.6, 0.45);
    ob('printer', 'archive-printer', -13, 12.35, 0.4, 0.3, 0);
    cabinetPoint = { x: -14.35, z: 3.2 };

    // Phòng họp lớn: bàn dài giữa thảm sẫm màu, màn hình trên tường tây
    ob('bigtable', 'meeting2-table', -7, 7.2, 1.5, 3.7, 0);
    rug('runner-meeting2', -7, 7.2, 2.8, 9.6, 0x6a6c7a, 'dark');
    dec('tv', 'tv-meeting2', -10.84, 7.2, 1.45, Math.PI / 2, 2.0, 1.1, 0x20242f);
    dec('board', 'board-meeting2', -3.12, 7.2, 1.4, -Math.PI / 2, 1.8, 1.0, 0x5b9bd5);
    plant('plant-meeting2-a', -10.3, 12.2);
    plant('plant-meeting2-b', -3.7, 12.2);

    // Sảnh lễ tân: quầy, sofa, bể cá, cây, thảm chùi chân
    ob('reception', 'reception', 1.45, 8.4, 0.5, 1.4, -Math.PI / 2);
    ob('sofa', 'lobby-sofa', -2.4, 4.0, 0.5, 1.1, Math.PI / 2, 0xe86f8f);
    ob('table', 'lobby-table', -2.4, 6.0, 0.4, 0.4);
    ob('aquarium', 'lobby-aquarium', -2.55, 9.6, 0.35, 1.2, Math.PI / 2);
    plant('plant-lobby-a', 1.6, 12.2);
    plant('plant-lobby-b', -2.45, 12.2);
    plant('plant-lobby-c', -2.45, 2.2);
    dec('mat', 'door-mat', ENTRANCE_X, 12.5, 0.02, 0, 2.2, 1.0, 0x6b7385);
    dec('logo', 'logo', ENTRANCE_X, 12.88, 2.9, 0, 3.0, 0.5, 0x2a2540);
  } else {
    // Tầng trên: hồ sơ và họp (không có phòng Chủ, sảnh)
    ob('cabinet', 'cabinet', -19.55, 5.0, 0.3, 3.8, Math.PI / 2);
    ob('cabinet', 'cabinet-b', -16.4, 5.0, 0.3, 3.8, -Math.PI / 2);
    ob('printer', 'archive-printer', -18, 12.35, 0.4, 0.3, 0);
    cabinetPoint = { x: -19.35, z: 3.2 };
    ob('bigtable', 'meeting2-table', -12.5, 7.2, 1.5, 3.7, 0);
    rug('runner-meeting2', -12.5, 7.2, 2.8, 9.6, 0x6a6c7a, 'dark');
    dec('tv', 'tv-meeting2', -15.84, 7.2, 1.45, Math.PI / 2, 2.0, 1.1, 0x20242f);
    plant('plant-meeting2-a', -15.3, 12.2);
    plant('plant-meeting2-b', -9.7, 12.2);
  }

  // ====================== Khu làm việc mở: cụm bàn của từng team ======================
  const eastX = open.x1 - 0.55;
  const plantAt = (id: string, x: number, z: number) => plant(id, x, z);

  for (const { group, row, col } of placements) {
    const { team } = group;
    const centers = Array.from({ length: group.pods }, (_, k) => podCenter(floor, row, col + k));
    const first = centers[0];
    const last = centers[centers.length - 1];
    zones.push({ id: group.id, name: team.name, lead: team.lead, colorIndex: group.colorIndex, x: (first.x + last.x) / 2, z: first.z, w: last.x - first.x + POD_W + 0.4, d: POD_D + 0.4 });
    centers.forEach((c, k) => {
      pods.push({ zoneId: group.id, x: c.x, z: c.z });
      tiles.push({ id: k === 0 ? group.id : `${group.id}#${k}`, kind: 'zone', label: k === 0 ? team.name : '', x: c.x, z: c.z, w: POD_W + 0.4, d: POD_D + 0.4, colorIndex: group.colorIndex, floor: 'carpet', color: TEAM_COLORS[group.colorIndex % TEAM_COLORS.length] });
    });
    group.members.forEach((m, i) => {
      const c = centers[Math.floor(i / SEATS_PER_POD)];
      const seat = SEAT_ORDER[i % SEATS_PER_POD];
      const north = seat.north;
      people.push(spot(m, team, group.colorIndex, floor, c.x + (seat.left ? -SEAT_DX : SEAT_DX), c.z + (north ? -SEAT_DZ : SEAT_DZ), north ? 0 : Math.PI));
    });
    // Bàn trống ở các chỗ chưa có người (cụm nào cũng đủ bốn bàn).
    centers.forEach((c, k) => {
      for (let s = 0; s < SEATS_PER_POD; s += 1) {
        if (k * SEATS_PER_POD + s < group.members.length) continue;
        const seat = SEAT_ORDER[s];
        const north = seat.north;
        const facing = north ? 0 : Math.PI;
        const sz = c.z + (north ? -SEAT_DZ : SEAT_DZ);
        ob('desk', `desk-${group.id}-${k}-${s}`, c.x + (seat.left ? -SEAT_DX : SEAT_DX), sz + 1.15 * Math.cos(facing), 1.1, 0.55, facing);
      }
    });
  }

  // Hàng cây ngăn khu mở với sảnh và với tường đông; máy in, nước uống, thùng rác giữa hai hàng cụm bàn.
  const rowMidZ = (ROW_Z[0] + ROW_Z[1]) / 2;
  ob('printer', 'open-printer', eastX - 0.1, rowMidZ - 0.9, 0.4, 0.5, -Math.PI / 2);
  ob('cooler', 'open-cooler', eastX, rowMidZ + 0.5, 0.3, 0.3, -Math.PI / 2);
  ob('bin', 'open-bin', eastX, rowMidZ + 1.3, 0.2, 0.2);
  plantAt('plant-open-a', open.x0 + 0.55, Z1 - 0.7);
  plantAt('plant-open-b', open.x0 + 0.55, rowMidZ);
  plantAt('plant-open-c', eastX, Z1 - 0.7);
  if (!ground) plantAt('plant-open-d', open.x0 + 12, rowMidZ);
  dec('frame', 'frame-open', 12, Z1 - 0.12 * 0 - 0.06, 2.2, Math.PI, 1.4, 0.9, 0x5b9bd5);

  // ---------- Giám đốc ngồi trong phòng riêng ----------
  if (ground) {
    directors.forEach((team) => {
      team.members.filter(isDirector).forEach((m, i) => {
        people.push(spot(m, team, 7, floor, 15.1 + Math.min(i, 3) * 2.6, -11.9, 0));
      });
    });
  }

  // ====================== Chỗ đứng ở từng nơi ======================
  const stands = buildStands(ground, rooms, furniture);

  const lounge = byId('rest');
  return {
    floor,
    floorCount,
    walls: { minX: X0, maxX: X1, minZ: Z0, maxZ: Z1 },
    width: X1 - X0,
    depth: Z1 - Z0,
    tiles,
    wallSegs,
    doors,
    furniture,
    decor,
    pods,
    zones,
    rooms,
    lounge: { x: lounge.x, z: lounge.z, w: lounge.w, d: lounge.d },
    cabinet: cabinetPoint,
    owner: ownerPoint,
    coffee,
    entrance: ground ? { x: ENTRANCE_X, z: Z1 } : null,
    stands,
    people,
  };
}

const hit = (list: Obstacle[], x: number, z: number, pad: number) =>
  list.some((o) => Math.abs(x - o.x) < o.hw + pad && Math.abs(z - o.z) < o.hd + pad);

function buildStands(ground: boolean, rooms: RoomBox[], furniture: Obstacle[]): OfficeLayout['stands'] {
  const row = (xs: number[], z: number, face: number): Stand[] => xs.map((x) => ({ x, z, face }));
  const seq = (from: number, step: number, n: number) => Array.from({ length: n }, (_, i) => from + i * step);
  const room = (id: RoomId) => rooms.find((r) => r.id === id) as RoomBox;

  // Thư viện: đứng đọc sách ở kệ phía bắc.
  const library = row(seq(-18.4, 0.9, 6), -11.35, Math.PI);
  // Phòng server: đứng trước dãy tủ máy.
  const server = row(seq(-6.6, 0.8, 4), -10.85, Math.PI);
  // Bảng trắng của Giám đốc (chỉ tầng 1): đứng quay mặt vào bảng.
  const whiteboard = ground ? row([17.6, 19.0], -10.9, Math.PI) : [];
  // Pantry: hai hàng trước quầy.
  const pantry = [...row(seq(-1.9, 0.9, 4), -11.3, Math.PI), ...row(seq(-1.9, 0.9, 4), -10.2, Math.PI)];
  // WC: đứng trong phòng (không hiện hình khi ở trong).
  const wc = [{ x: 4.0, z: -8.2, face: 0 }, { x: 5.1, z: -8.2, face: 0 }, { x: 4.0, z: -7.0, face: 0 }, { x: 5.1, z: -7.0, face: 0 }];
  // Họp: quanh bàn họp 1 (bốn chỗ), sau đó phòng họp lớn (tám chỗ).
  const m1 = [
    { x: 7.0, z: -10.4, face: Math.PI / 2 }, { x: 11.5, z: -10.4, face: -Math.PI / 2 },
    { x: 7.0, z: -7.7, face: Math.PI / 2 }, { x: 11.5, z: -7.7, face: -Math.PI / 2 },
  ];
  const m2 = room('meeting2');
  const tx = m2.x;
  const m2stands: Stand[] = [];
  for (let i = 0; i < 4; i += 1) {
    m2stands.push({ x: tx - 2.35, z: m2.z - 2.4 + i * 1.6, face: Math.PI / 2 }, { x: tx + 2.35, z: m2.z - 2.4 + i * 1.6, face: -Math.PI / 2 });
  }
  const meeting = [...m1, ...m2stands];
  // Ngắm cửa sổ: đứng sát tường đông của hành lang nhìn ra phố.
  const window = [-3.2, -2.4, -1.6, -0.8].map((z) => ({ x: 19.0, z, face: Math.PI / 2 }));
  // Khu nghỉ: lưới chỗ đứng trống quanh khu nghỉ, ưu tiên chỗ gần giữa.
  const rest = room('rest');
  const cells: Stand[] = [];
  for (let z = rest.z - rest.d / 2 + 0.8; z <= rest.z + rest.d / 2 - 0.7; z += 0.95) {
    for (let x = rest.x - rest.w / 2 + 1.0; x <= rest.x + rest.w / 2 - 0.9; x += 0.95) {
      if (hit(furniture, x, z, 0.6)) continue;
      cells.push({ x, z, face: 0 });
    }
  }
  const cx = rest.x + 1.5;
  const cz = rest.z;
  cells.sort((a, b) => Math.hypot(a.x - cx, (a.z - cz) * 1.6) - Math.hypot(b.x - cx, (b.z - cz) * 1.6));
  return { library, server, whiteboard, pantry, wc, meeting, window, lounge: cells };
}

/** Số nhân vật theo từng team (kể cả Trưởng nhóm), dùng để đối chiếu với cấu hình. */
export function countByTeam(layoutOrBuilding: { people: PersonSpot[] }): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of layoutOrBuilding.people) out[p.teamId] = (out[p.teamId] ?? 0) + 1;
  return out;
}

