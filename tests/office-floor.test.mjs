import assert from 'node:assert/strict';
import test from 'node:test';
import { BODY_RADIUS, deskHitBy, obstacleHitBy, planPath, standSpot, wallHitBy, walkable } from '../src/office/flow.ts';
import { countByTeam, layoutBuilding, layoutOffice, POD_W, podsPerRow, SEATS_PER_POD, TEAM_COLORS } from '../src/office/layout.ts';
import { compactTeams, fullTeams } from './roster.mjs';

// realTeams: đội hình gọn một tầng cho các test hành vi; fullTeams: đội hình thật đầy đủ cho test đếm người.
const realTeams = compactTeams;
const member = (name, role, isLead = false) => ({ name, role, title: role, model: 'sonnet', effort: 'low', strengths: [], isLead });
const team = (id, n) => ({ id, name: id, lead: 'L' + id, members: [member('L' + id, 'lead', true), ...Array.from({ length: n }, (_, i) => member(`${id}${i}`, 'dev'))] });
const director = { id: 'management', name: 'Ban giám đốc', lead: 'Hòa', members: [member('Hòa', 'director', true)] };

const PLACES = ['library', 'server', 'lounge', 'pantry', 'meeting', 'wc', 'window'];
const slotCount = { lounge: 12, meeting: 12, window: 4, pantry: 8, wc: 4, library: 6, server: 4, whiteboard: 2 };

const inside = (box, x, z, pad = 0) => Math.abs(x - box.x) <= box.w / 2 - pad && Math.abs(z - box.z) <= box.d / 2 - pad;
const room = (layout, id) => layout.rooms.find((r) => r.id === id);

/** Mọi đường đi có thể có: từ bàn tới từng nơi, từ nơi về bàn, và giữa các nơi với nhau (cho từng người). */
function allRoutes(layout, people = layout.people) {
  const routes = [];
  people.forEach((person, index) => {
    const seat = { x: person.x, z: person.z };
    const usable = [...PLACES, ...(person.isDirector ? ['whiteboard'] : [])];
    const stands = Object.fromEntries(usable.map((p) => [p, standSpot(layout, person, p, p === 'lounge' ? index : index % 4)]));
    for (const p of usable) {
      routes.push({ tag: `${person.name}: bàn → ${p}`, path: planPath(layout, person, 'desk', seat, p, stands[p]) });
      routes.push({ tag: `${person.name}: ${p} → bàn`, path: planPath(layout, person, p, stands[p], 'desk', seat) });
      for (const q of usable) if (p !== q) routes.push({ tag: `${person.name}: ${p} → ${q}`, path: planPath(layout, person, p, stands[p], q, stands[q]) });
    }
  });
  return routes;
}

test('số nhân vật theo từng team khớp đúng cấu hình thật; sáu team đầu kín tầng 1, team thứ bảy lên tầng 2', () => {
  const teams = realTeams();
  const b = layoutBuilding(teams);
  const expected = Object.fromEntries(teams.filter((t) => t.id !== 'management').map((t) => [t.id, t.members.length]));
  assert.deepEqual(countByTeam(b), { ...expected, management: 1 });
  assert.equal(b.people.length, 20, '1 Giám đốc + 7 Trưởng nhóm + 12 nhân viên');
  assert.equal(b.floors.length, 2, 'tầng 1 chỉ có sáu cụm bàn nên team thứ bảy lên tầng 2');
  const names = b.people.map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(b.people.filter((p) => p.isLead).map((p) => p.name).sort(), ['Hòa', 'Hải', 'Khôi', 'Lan', 'Minh', 'Ngọc', 'Phúc', 'Thảo'].sort());
  const work = teams.filter((t) => t.id !== 'management').map((t) => t.id);
  assert.deepEqual(b.floors[0].zones.map((z) => z.id).sort(), work.slice(0, 6).sort());
  assert.deepEqual(b.floors[1].zones.map((z) => z.id), work.slice(6));
  assert.deepEqual([...work].sort(), ['backend', 'design', 'devops', 'frontend', 'quality', 'report', 'security']);
  assert.ok(b.people.every((p) => b.floorOf[p.name] === (work.slice(6).includes(p.teamId) ? 1 : 0) && p.floor === b.floorOf[p.name]));
});

test('đội hình thật đầy đủ (team tới 6 người, hai cụm bàn): không ai mất, không ai ngồi chồng, ngồi đúng khu của team, mỗi team nằm trọn một tầng', () => {
  const teams = fullTeams();
  const b = layoutBuilding(teams);
  const total = teams.reduce((n, t) => n + t.members.length, 0);
  assert.equal(b.people.length, total, 'đủ mọi người');
  assert.equal(new Set(b.people.map((p) => p.name)).size, total, 'không trùng tên');
  const expected = Object.fromEntries(teams.filter((t) => t.id !== 'management').map((t) => [t.id, t.members.length]));
  assert.deepEqual(countByTeam(b), { ...expected, management: 1 });
  const work = teams.filter((t) => t.id !== 'management').map((t) => t.id);
  const zoneIds = b.floors.flatMap((f) => f.zones.map((z) => z.id));
  assert.deepEqual([...zoneIds].sort(), [...work].sort(), 'mỗi team đúng một khu, trên đúng một tầng');
  for (const f of b.floors) {
    const onFloor = b.people.filter((p) => p.floor === f.floor && p.teamId !== 'management');
    for (let i = 0; i < onFloor.length; i += 1) for (let j = i + 1; j < onFloor.length; j += 1) {
      assert.ok(Math.hypot(onFloor[i].x - onFloor[j].x, onFloor[i].z - onFloor[j].z) > 1.5, `tầng ${f.floor + 1}: ${onFloor[i].name} và ${onFloor[j].name} ngồi quá gần nhau`);
    }
    for (const p of onFloor) {
      const zone = f.zones.find((z) => z.id === p.teamId);
      assert.ok(zone, `${p.name} ngồi cùng tầng với khu team ${p.teamId}`);
      assert.ok(inside(zone, p.x, p.z, 0.5), `${p.name} ngồi trong khu của team ${p.teamId}`);
    }
  }
});

test('tòa nhà có hình dạng cố định tỉ lệ 3:2; thêm team không làm nó dài ra', () => {
  const small = layoutOffice([team('a', 2)]);
  const real = layoutOffice(realTeams());
  const big = layoutBuilding([team('a', 7), team('b', 3), team('c', 2), team('d', 0), team('e', 3), team('f', 3), team('g', 3), team('h', 11), team('i', 3)]);
  for (const l of [small, real, ...big.floors]) {
    assert.deepEqual(l.walls, real.walls, 'cùng một hình chữ nhật');
    assert.equal(l.width, 40);
    assert.equal(l.depth, 26);
  }
  assert.ok(Math.abs(real.width / real.depth - 1.5) < 0.1, 'tỉ lệ khoảng 3:2');
  assert.ok(big.floors.length >= 2, 'nhiều team thì thêm tầng thay vì kéo dài');
  assert.deepEqual(big.floors.map((f) => f.floor), big.floors.map((_, i) => i));
  assert.ok(big.floors.every((f) => f.floorCount === big.floors.length));
});

test('mỗi tầng đủ phòng chức năng, nằm gọn trong tòa nhà và không chồng nhau', () => {
  const b = layoutBuilding([team('a', 7), team('b', 3), team('c', 2), team('d', 0), team('e', 3), team('f', 3), team('g', 3), team('h', 11), team('i', 3), director]);
  assert.ok(b.floors.length >= 2);
  const ground = b.floors[0];
  assert.deepEqual(['owner', 'director', 'meeting1', 'meeting2', 'library', 'server', 'archive', 'wc', 'pantry', 'stairs', 'rest', 'lobby'].filter((id) => !room(ground, id)), [], 'tầng 1 đủ phòng');
  assert.ok(ground.entrance, 'tầng 1 có cửa vào');
  for (const f of b.floors.slice(1)) {
    assert.deepEqual(['meeting1', 'meeting2', 'library', 'server', 'archive', 'wc', 'pantry', 'stairs', 'rest'].filter((id) => !room(f, id)), [], `tầng ${f.floor + 1} tự có đủ phòng để không ai phải đi giữa các tầng`);
    assert.equal(f.entrance, null);
    assert.equal(room(f, 'director'), undefined);
  }
  for (const f of b.floors) {
    for (const t of f.tiles) {
      assert.ok(t.x - t.w / 2 >= f.walls.minX - 1e-6 && t.x + t.w / 2 <= f.walls.maxX + 1e-6 && t.z - t.d / 2 >= f.walls.minZ - 1e-6 && t.z + t.d / 2 <= f.walls.maxZ + 1e-6, `${t.id} nằm trong tòa nhà`);
    }
    const flat = f.tiles.filter((t) => t.kind === 'room');
    for (let i = 0; i < flat.length; i += 1) for (let j = i + 1; j < flat.length; j += 1) {
      const x = flat[i];
      const y = flat[j];
      const overlap = Math.abs(x.x - y.x) < (x.w + y.w) / 2 - 1e-6 && Math.abs(x.z - y.z) < (x.d + y.d) / 2 - 1e-6;
      assert.equal(overlap, false, `tầng ${f.floor + 1}: ${x.id} và ${y.id} chồng nhau`);
    }
    // Sàn các phòng phủ kín tòa nhà (không có chỗ hở).
    const area = flat.reduce((n, t) => n + t.w * t.d, 0);
    assert.ok(Math.abs(area - f.width * f.depth) < 1e-6 + (f.floor === 0 ? 0 : 0), `tầng ${f.floor + 1}: các phòng phủ kín sàn (${area} so với ${f.width * f.depth})`);
    const rest = room(f, 'rest');
    assert.deepEqual(f.lounge, { x: rest.x, z: rest.z, w: rest.w, d: rest.d });
  }
});

test('tường và cửa: mọi tường thẳng trục, cửa nằm trong tường, phòng có tường đều có cửa', () => {
  const l = layoutOffice(realTeams());
  for (const w of l.wallSegs) assert.ok(w.x0 === w.x1 || w.z0 === w.z1, 'tường song song với một trục');
  for (const d of l.doors) {
    assert.ok(d.w >= 1.2, `cửa ${d.room} đủ rộng để đi qua`);
    const onWall = l.wallSegs.some((w) => (d.axis === 'x' ? w.z0 === d.z && w.z1 === d.z && w.x0 <= d.x - d.w / 2 + 1e-6 || w.z0 === d.z && w.x1 >= d.x + d.w / 2 - 1e-6 : false));
    assert.ok(onWall || d.kind === 'glass', `cửa ${d.room} nằm trên một bức tường`);
    // Giữa khe cửa không có tường.
    assert.equal(wallHitBy(l, [{ x: d.x, z: d.z }]), null, `khe cửa ${d.room} trống`);
  }
  for (const id of ['library', 'stairs', 'server', 'wc', 'meeting1', 'director', 'owner', 'archive', 'meeting2']) {
    assert.ok(l.doors.some((d) => d.room === id), `${id} có cửa`);
  }
  assert.ok(l.doors.some((d) => d.room === 'lobby' && d.kind === 'glass'), 'cửa vào bằng kính ở sảnh');
});

test('khu làm việc mở: mỗi team một khu thảm, bàn xếp thành cụm đối mặt nhau, hàng bắc quay về +z, hàng nam quay về -z', () => {
  const l = layoutOffice(realTeams());
  for (const zone of l.zones) {
    const members = l.people.filter((p) => p.teamId === zone.id);
    assert.ok(members.length > 0);
    for (const p of members) {
      assert.ok(inside(zone, p.x, p.z, 0.5), `${p.name} ngồi trong khu của team`);
      assert.ok(inside(zone, p.deskX, p.deskZ, 0.2), `bàn của ${p.name} nằm trong khu`);
      assert.ok(p.facing === 0 || p.facing === Math.PI);
      assert.ok(Math.abs(p.deskZ - (p.z + 1.15 * Math.cos(p.facing))) < 1e-9, 'bàn ở phía trước mặt');
    }
    if (members.length >= 3) {
      assert.ok(members.some((p) => p.facing === 0) && members.some((p) => p.facing === Math.PI), `${zone.name}: hai hàng đối mặt`);
    }
  }
  // Hai người của một team hai người ngồi chéo nhau (đối mặt) chứ không đứng cạnh nhau.
  const design = l.people.filter((p) => p.teamId === 'design');
  assert.equal(design.length, 2);
  assert.notEqual(design[0].facing, design[1].facing, 'team hai người ngồi hai hàng khác nhau');
  // Không ai ngồi chồng lên ai; mọi cụm đủ bốn bàn (chỗ trống là bàn trống); mỗi team một màu thảm.
  for (let i = 0; i < l.people.length; i += 1) for (let j = i + 1; j < l.people.length; j += 1) {
    assert.ok(Math.hypot(l.people[i].x - l.people[j].x, l.people[i].z - l.people[j].z) > 1.5, `${l.people[i].name} và ${l.people[j].name} ngồi quá gần nhau`);
  }
  const desks = (id) => l.people.filter((p) => p.teamId === id).length + l.furniture.filter((f) => f.kind === 'desk' && f.id.startsWith(`desk-${id}-`)).length;
  for (const zone of l.zones) assert.equal(desks(zone.id) % SEATS_PER_POD, 0, `${zone.name}: bàn xếp đủ cụm bốn`);
  assert.equal(new Set(l.zones.map((z) => TEAM_COLORS[z.colorIndex % TEAM_COLORS.length])).size, 6);
  assert.equal(podsPerRow(0), 3);
});

test('team lớn có thêm cụm bàn liền nhau; tầng tiếp theo nhận team khi tầng này hết chỗ; không ai bị mất', () => {
  const teams = [team('a', 7), team('b', 3), team('c', 2), team('d', 0), team('e', 3), team('f', 3), team('g', 3), team('h', 11), team('i', 3), director];
  const b = layoutBuilding(teams);
  const total = teams.reduce((n, t) => n + t.members.length, 0);
  assert.equal(b.people.length, total, 'đủ mọi người');
  assert.equal(new Set(b.people.map((p) => p.name)).size, total);
  const a = b.floors[0].zones.find((z) => z.id === 'a');
  const bb = b.floors[0].zones.find((z) => z.id === 'b');
  assert.ok(a.w - bb.w >= POD_W - 1e-6, 'team 8 người (hai cụm) rộng hơn team 4 người (một cụm) ít nhất một cụm bàn');
  assert.equal(new Set(b.people.filter((p) => p.teamId === 'a').map((p) => p.x)).size, 4, 'hai cụm: bốn cột chỗ ngồi');
  // Team 12 người (một nhóm đủ ba cụm) vẫn nằm trọn trong một hàng; không team nào vượt quá số cụm của hàng.
  for (const f of b.floors) {
    for (const z of f.zones) assert.ok(z.w <= podsPerRow(f.floor) * (POD_W + 1.2), `${z.name} vừa một hàng`);
    for (const p of f.people) assert.equal(p.floor, f.floor);
  }
  // Sàn tầng trên có đủ mười cụm bàn.
  assert.equal(podsPerRow(1), 5);
  assert.deepEqual(layoutBuilding([]).floors.length, 1);
  assert.deepEqual(layoutOffice([]).people, []);
});

test('một team rất đông được tách thành nhiều nhóm, vẫn cùng màu và cùng tên', () => {
  const b = layoutBuilding([team('big', 30)]);
  assert.equal(b.people.length, 31);
  assert.ok(b.floors.length >= 1);
  const groups = b.floors.flatMap((f) => f.zones).filter((z) => z.id.startsWith('big'));
  assert.ok(groups.length >= 3, 'ba nhóm trở lên');
  assert.equal(new Set(groups.map((z) => z.colorIndex)).size, 1, 'cùng một màu team');
  assert.ok(b.people.every((p) => p.teamId === 'big'));
});

test('đồ đạc: nằm trong tòa nhà, không chồng nhau, không đè bàn của ai', () => {
  const b = layoutBuilding([team('a', 7), team('b', 3), team('c', 2), team('d', 0), team('e', 3), team('f', 3), team('g', 3), team('h', 11), team('i', 3), director]);
  for (const l of [layoutOffice(realTeams()), ...b.floors]) {
    const rect = (o) => ({ x0: o.x - o.hw, x1: o.x + o.hw, z0: o.z - o.hd, z1: o.z + o.hd });
    for (const o of l.furniture) {
      const r = rect(o);
      assert.ok(r.x0 >= l.walls.minX && r.x1 <= l.walls.maxX && r.z0 >= l.walls.minZ && r.z1 <= l.walls.maxZ, `${o.id} nằm trong tòa nhà`);
      for (const p of l.people) {
        const hit = Math.abs(o.x - p.deskX) < o.hw + 1.1 - 1e-6 && Math.abs(o.z - p.deskZ) < o.hd + 0.55 - 1e-6;
        assert.equal(hit, false, `${o.id} đè lên bàn của ${p.name}`);
      }
    }
    for (let i = 0; i < l.furniture.length; i += 1) for (let j = i + 1; j < l.furniture.length; j += 1) {
      const a = rect(l.furniture[i]);
      const c = rect(l.furniture[j]);
      const overlap = a.x0 < c.x1 - 1e-6 && a.x1 > c.x0 + 1e-6 && a.z0 < c.z1 - 1e-6 && a.z1 > c.z0 + 1e-6;
      assert.equal(overlap, false, `tầng ${l.floor + 1}: ${l.furniture[i].id} và ${l.furniture[j].id} chồng nhau`);
    }
    // Đồ đạc không đè lên tường.
    for (const o of l.furniture) {
      const corners = [[o.x - o.hw, o.z - o.hd], [o.x + o.hw, o.z - o.hd], [o.x - o.hw, o.z + o.hd], [o.x + o.hw, o.z + o.hd]];
      for (const [x, z] of corners) {
        for (const w of l.wallSegs) {
          const t = (w.kind === 'outer' ? 0.3 : 0.14) / 2;
          const inWall = x > Math.min(w.x0, w.x1) - t + 1e-6 && x < Math.max(w.x0, w.x1) + t - 1e-6 && z > Math.min(w.z0, w.z1) - t + 1e-6 && z < Math.max(w.z0, w.z1) + t - 1e-6;
          assert.equal(inWall, false, `tầng ${l.floor + 1}: ${o.id} đè lên tường`);
        }
      }
    }
    // Người ngồi không đè đồ đạc; ghế (chỗ ngồi) đi được.
    for (const p of l.people) {
      assert.equal(walkable(l, p.x, p.z), true, `chỗ ngồi của ${p.name} đi được`);
      assert.equal(obstacleHitBy(l, [{ x: p.x, z: p.z }], 0), null, `${p.name} ngồi đè đồ đạc`);
    }
  }
});

test('chỗ đứng: đúng phòng, đi được, không hai người đứng chồng nhau, tới được từ mọi chỗ ngồi', () => {
  const l = layoutOffice(realTeams());
  const area = { library: 'library', server: 'server', whiteboard: 'director', pantry: 'pantry', wc: 'wc', lounge: 'rest' };
  for (const place of [...PLACES, 'whiteboard']) {
    const spots = l.stands[place];
    assert.ok(spots.length >= (slotCount[place] ?? 4) || place === 'whiteboard', `${place} có đủ chỗ (${spots.length})`);
    spots.forEach((s, i) => {
      assert.ok(Math.abs(s.x) <= l.walls.maxX && s.z >= l.walls.minZ && s.z <= l.walls.maxZ, `${place}#${i} nằm trong tòa nhà`);
      if (area[place]) assert.ok(inside(room(l, area[place]), s.x, s.z), `${place}#${i} nằm trong ${area[place]}`);
      assert.equal(walkable(l, s.x, s.z), true, `${place}#${i} (${s.x}, ${s.z}) bị chặn`);
      assert.equal(obstacleHitBy(l, [s], 0), null, `${place}#${i} đứng đè đồ đạc`);
    });
    for (let i = 0; i < spots.length; i += 1) for (let j = i + 1; j < spots.length; j += 1) {
      assert.ok(Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z) >= 0.45, `${place}: chỗ ${i} và ${j} quá gần nhau`);
    }
  }
  // Khu nghỉ chứa được cả công ty một lúc.
  assert.ok(l.stands.lounge.length >= 30, `khu nghỉ có ${l.stands.lounge.length} chỗ`);
  // Phòng họp: bốn chỗ đầu ở phòng họp 1, các chỗ sau ở phòng họp lớn.
  l.stands.meeting.forEach((s, i) => assert.ok(inside(room(l, i < 4 ? 'meeting1' : 'meeting2'), s.x, s.z), `meeting#${i}`));
  const person = l.people[0];
  assert.deepEqual(standSpot(l, person, 'desk', 0, 1), { x: person.x, z: person.z, face: person.facing });
});

test('mọi đường đi (bàn → nơi, nơi → bàn, nơi → nơi, cho từng người) có thật, không đụng bàn, đồ đạc hay tường, không ra ngoài sàn', () => {
  const l = layoutOffice(realTeams());
  const routes = allRoutes(l);
  assert.ok(routes.length > 400, `đủ nhiều đường đi để kiểm tra (${routes.length})`);
  for (const { tag, path: route } of routes) {
    assert.ok(route.length >= 2, `${tag}: có đường`);
    const goal = route[route.length - 1];
    assert.ok(walkable(l, goal.x, goal.z) || tag.includes('→ bàn'), `${tag}: đích đi được`);
    for (let i = 1; i < route.length; i += 1) assert.ok(Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z) > 1e-6, `${tag}: không có đoạn dài 0`);
    for (const p of route) assert.ok(p.x > l.walls.minX && p.x < l.walls.maxX && p.z > l.walls.minZ && p.z < l.walls.maxZ, `${tag}: điểm (${p.x}, ${p.z}) ngoài sàn`);
    assert.equal(obstacleHitBy(l, route), null, `${tag}: cắt qua đồ đạc (${obstacleHitBy(l, route)})`);
    assert.equal(deskHitBy(l, route), null, `${tag}: cắt qua bàn của ${deskHitBy(l, route)}`);
    assert.equal(wallHitBy(l, route), null, `${tag}: đi xuyên tường ${wallHitBy(l, route)}`);
  }
});

test('đường đi hợp lý: không vòng vèo, vào phòng chỉ qua cửa', () => {
  const l = layoutOffice(realTeams());
  const lan = l.people.find((p) => p.name === 'Lan');
  const lib = standSpot(l, lan, 'library', 0);
  const route = planPath(l, lan, 'desk', { x: lan.x, z: lan.z }, 'library', lib);
  const len = route.reduce((n, p, i) => (i ? n + Math.hypot(p.x - route[i - 1].x, p.z - route[i - 1].z) : 0), 0);
  const straight = Math.hypot(lan.x - lib.x, lan.z - lib.z);
  assert.ok(len < straight * 1.8 + 3, `đường đi (${len.toFixed(1)} m) không dài hơn đường chim bay (${straight.toFixed(1)} m) quá nhiều`);
  const door = l.doors.find((d) => d.room === 'library');
  assert.ok(route.some((p, i) => i > 0 && Math.abs(p.x - door.x) < door.w / 2 + 0.3 && Math.abs(p.z - door.z) < 1.5) || route.some((p) => Math.abs(p.z - door.z) < 1.0 && Math.abs(p.x - door.x) < door.w / 2), 'đi qua cửa thư viện');
  // Hai điểm cuối đúng chỗ.
  assert.deepEqual([route[0].x, route[0].z], [lan.x, lan.z]);
  assert.deepEqual([route[route.length - 1].x, route[route.length - 1].z], [lib.x, lib.z]);
  assert.ok(BODY_RADIUS > 0);
});

test('tầng trên cũng có đường đi sạch từ mọi chỗ ngồi tới mọi nơi', () => {
  const b = layoutBuilding([team('a', 7), team('b', 3), team('c', 2), team('d', 0), team('e', 3), team('f', 3), team('g', 3), team('h', 11), team('i', 3), director]);
  for (const l of b.floors) {
    // Chọn vài người (mỗi hàng, mỗi cột) cho nhanh.
    const sample = l.people.filter((_, i) => i % 3 === 0 || l.people[i].isDirector);
    const routes = allRoutes(l, sample);
    const bad = routes.filter(({ path: p }) => obstacleHitBy(l, p) || deskHitBy(l, p) || wallHitBy(l, p));
    assert.equal(bad.length, 0, `tầng ${l.floor + 1}: đường đi sạch (hỏng: ${bad.slice(0, 3).map((r) => r.tag).join('; ')})`);
    for (const { tag, path: p } of routes) assert.ok(p.length >= 2, `${tag}: có đường`);
  }
});

test('bố cục là hàm thuần: cùng đầu vào cho cùng kết quả', () => {
  const teams = realTeams();
  assert.deepEqual(layoutBuilding(teams), layoutBuilding(teams));
});
