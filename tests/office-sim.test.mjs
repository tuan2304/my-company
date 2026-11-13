import assert from 'node:assert/strict';
import test from 'node:test';
import { deskHitBy, obstacleHitBy, wallHitBy } from '../src/office/flow.ts';
import { layoutBuilding, layoutOffice } from '../src/office/layout.ts';
import { dirOf, MAX_OUT_RATIO, OfficeSim, WALK_SPEED } from '../src/office/sim.ts';
import { IDLE_VIEW } from '../src/office/status.ts';
import { compactTeams } from './roster.mjs';

const layout = () => layoutOffice(compactTeams());
const NOW = 1_800_000_000_000;
const view = (over = {}) => ({ ...IDLE_VIEW, ...over });
const WORK = { status: 'working', activity: 'typing' };

/** Chạy mô phỏng `seconds` giây với bước `stepMs`, gọi `each` sau mỗi bước. Trả về thời điểm cuối. */
function run(sim, from, seconds, each = () => {}, stepMs = 50) {
  let ts = from;
  for (let t = 0; t < seconds * 1000; t += stepMs) {
    ts += stepMs;
    sim.step(ts, NOW + ts);
    each(ts);
  }
  return ts;
}
const actor = (sim, name) => sim.actors.find((a) => a.spot.name === name);

test('hướng nhìn đổi thành bốn hướng của hình vẽ', () => {
  assert.equal(dirOf(0), 'down');
  assert.equal(dirOf(Math.PI), 'up');
  assert.equal(dirOf(Math.PI / 2), 'right');
  assert.equal(dirOf(-Math.PI / 2), 'left');
  assert.equal(dirOf(0.3), 'down');
  assert.equal(dirOf(Math.PI - 0.3), 'up');
});

test('ngồi đúng chỗ, đúng hướng lúc đầu: hàng bắc nhìn xuống màn hình, hàng nam nhìn lên', () => {
  const l = layout();
  const sim = new OfficeSim(l);
  for (const a of sim.actors) {
    assert.deepEqual([a.x, a.z, a.place, a.walking], [a.spot.x, a.spot.z, 'desk', false]);
    assert.equal(dirOf(a.heading), a.spot.facing === 0 ? 'down' : 'up');
    assert.equal(sim.seated(a), true);
  }
});

test('đọc code kéo dài thì đi thư viện; thoáng qua thì không; xong việc thì về bàn', () => {
  const sim = new OfficeSim(layout());
  const cuc = actor(sim, 'Cúc');
  // Thoáng qua (1 giây rồi đổi): không đứng dậy.
  sim.setViews({ Cúc: view({ status: 'working', activity: 'reading' }) });
  let ts = run(sim, 0, 1);
  sim.setViews({ Cúc: view(WORK) });
  ts = run(sim, ts, 4);
  assert.equal(cuc.place, 'desk');
  assert.equal(cuc.walking, false);

  // Kéo dài: đi tới thư viện và đứng đó.
  sim.setViews({ Cúc: view({ status: 'working', activity: 'reading' }) });
  const room = sim.layout.rooms.find((r) => r.id === 'library');
  let sawWalking = false;
  ts = run(sim, ts, 25, () => { if (cuc.walking) sawWalking = true; });
  assert.equal(sawWalking, true, 'có đi bộ');
  assert.equal(cuc.place, 'library');
  assert.ok(Math.abs(cuc.x - room.x) < room.w / 2 && Math.abs(cuc.z - room.z) < room.d / 2, 'đứng trong thư viện');
  assert.equal(sim.actionOf(cuc), 'read');

  // Xong việc, đang bận gõ thì về bàn.
  sim.setViews({ Cúc: view(WORK) });
  run(sim, ts, 25);
  assert.equal(cuc.place, 'desk');
  assert.equal(sim.seated(cuc), true);
  assert.ok(Math.hypot(cuc.x - cuc.spot.x, cuc.z - cuc.spot.z) < 1e-6, 'về đúng chỗ ngồi');
  assert.equal(dirOf(cuc.heading), cuc.spot.facing === 0 ? 'down' : 'up', 'về ngồi đúng hướng');
});

test('tốc độ đi bộ đúng và đường đi không cắt qua bàn, đồ đạc hay tường (theo từng bước mô phỏng)', () => {
  const l = layout();
  const sim = new OfficeSim(l);
  sim.setViews({
    Cúc: view({ status: 'working', activity: 'reading' }), Giang: view({ status: 'working', activity: 'command' }),
    'Hòa': view({ status: 'working', activity: 'planning' }), An: view({ status: 'working', activity: 'reading' }),
  });
  let maxStep = 0;
  const lastPos = new Map(sim.actors.map((a) => [a.spot.name, { x: a.x, z: a.z }]));
  run(sim, 0, 40, () => {
    for (const a of sim.actors) {
      const p = { x: a.x, z: a.z };
      const prev = lastPos.get(a.spot.name);
      maxStep = Math.max(maxStep, Math.hypot(p.x - prev.x, p.z - prev.z));
      lastPos.set(a.spot.name, p);
      // Người ngồi ở bàn của chính mình thì sát bàn đó; chỉ kiểm tra khi đang đi hoặc đứng ngoài bàn.
      if (!a.walking && a.place === 'desk') continue;
      const own = obstacleHitBy(l, [p, p]);
      assert.equal(own, null, `${a.spot.name} đứng đè ${own} tại (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
      const desk = deskHitBy(l, [p, p]);
      assert.ok(desk === null || a.walking === false, `${a.spot.name} đi xuyên bàn của ${desk}`);
      assert.equal(wallHitBy(l, [p]), null, `${a.spot.name} xuyên tường tại (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
    }
  });
  assert.ok(maxStep <= WALK_SPEED * 0.1 + 1e-9, `mỗi bước không đi quá tốc độ (${maxStep.toFixed(3)} m)`);
  assert.ok(maxStep > 0.05, 'có người di chuyển');
  assert.equal(actor(sim, 'Hòa').place, 'whiteboard', 'Giám đốc lập kế hoạch thì ra bảng trắng');
  assert.equal(actor(sim, 'Giang').place, 'server');
});

test('nghỉ giải lao: mọi người ra khu nghỉ ngay, hết giờ thì về bàn', () => {
  const l = layout();
  const sim = new OfficeSim(l);
  sim.setBreak(NOW + 70_000, NOW);
  let ts = run(sim, 0, 45);
  const rest = l.lounge;
  for (const a of sim.actors) {
    assert.equal(a.place, 'lounge', `${a.spot.name} ở khu nghỉ`);
    assert.ok(Math.abs(a.x - rest.x) <= rest.w / 2 && Math.abs(a.z - rest.z) <= rest.d / 2);
  }
  // Hết giờ (giờ thật đã qua mốc nghỉ): về bàn.
  ts = run(sim, ts, 60);
  const sim2 = sim;
  sim2.setBreak(null);
  run(sim2, ts, 40);
  for (const a of sim2.actors) assert.notEqual(a.place, 'lounge', `${a.spot.name} đã rời khu nghỉ`);
});

test('rảnh thì không ngồi yên: tự vươn vai, nhấp cà phê, đi pha cà phê, họp, ngắm cửa sổ...; không quá 40% ra ngoài; không kẹt ở nơi làm việc', () => {
  const l = layout();
  const sim = new OfficeSim(l);
  const placesSeen = new Set();
  const animsSeen = new Set();
  let maxOut = 0;
  const allowed = new Set(['desk', 'pantry', 'window', 'meeting', 'wc', 'library', 'lounge']);
  run(sim, 0, 300, () => {
    const out = sim.actors.filter((a) => a.idlePlace !== null).length;
    maxOut = Math.max(maxOut, out);
    for (const a of sim.actors) {
      assert.ok(allowed.has(a.place), `${a.spot.name} ở nơi làm việc khi rảnh: ${a.place}`);
      if (!a.walking) placesSeen.add(a.place);
      if (a.anim !== 'none') animsSeen.add(a.anim);
      const p = { x: a.x, z: a.z };
      if (!(a.place === 'desk' && !a.walking)) {
        assert.equal(obstacleHitBy(l, [p, p]), null, `${a.spot.name} đè đồ đạc`);
        assert.equal(wallHitBy(l, [p]), null, `${a.spot.name} xuyên tường`);
      }
    }
  }, 100);
  assert.ok(maxOut >= 1 && maxOut <= Math.max(1, Math.floor(sim.actors.length * MAX_OUT_RATIO)), `số người ra ngoài cùng lúc: ${maxOut}`);
  assert.ok(placesSeen.size >= 5, `đi nhiều nơi khác nhau: ${[...placesSeen].join(', ')}`);
  assert.deepEqual([...animsSeen].sort(), ['look', 'sip', 'stretch'], 'đủ ba động tác tại bàn');
});

test('có việc thì bỏ dở việc rảnh và về bàn; chờ bạn quyết hay bị lỗi thì ngồi tại bàn, không đi chơi', () => {
  const l = layout();
  const sim = new OfficeSim(l);
  // Chạy tới khi An đang đi chơi.
  let ts = 0;
  for (let i = 0; i < 6000 && actor(sim, 'An').idlePlace === null; i += 1) ts = run(sim, ts, 0.1);
  const an = actor(sim, 'An');
  assert.notEqual(an.idlePlace, null, 'An đã đi chơi');
  sim.setViews({ An: view(WORK) });
  ts = run(sim, ts, 0.1);
  assert.equal(an.idlePlace, null, 'có việc thì bỏ dở');
  ts = run(sim, ts, 40);
  assert.equal(an.place, 'desk');
  assert.equal(sim.actionOf(an), 'type');

  sim.setViews({ Cúc: view({ needsYou: true }), Dũng: view({ failed: true }) });
  ts = run(sim, ts, 200);
  for (const name of ['Cúc', 'Dũng']) {
    assert.equal(actor(sim, name).place, 'desk', `${name} không đi chơi`);
    assert.equal(actor(sim, name).idlePlace, null);
  }
  assert.equal(sim.actionOf(actor(sim, 'Cúc')), 'wave');
  assert.equal(sim.actionOf(actor(sim, 'Dũng')), 'scratch');
});

test('chế độ giảm chuyển động: không đi chơi, dịch chuyển tức thì khi cần', () => {
  const sim = new OfficeSim(layout(), false);
  let ts = run(sim, 0, 120);
  for (const a of sim.actors) assert.deepEqual([a.place, a.idlePlace, a.anim], ['desk', null, 'none']);
  sim.setViews({ Cúc: view({ status: 'working', activity: 'reading' }) });
  run(sim, ts, 5);
  const cuc = actor(sim, 'Cúc');
  assert.equal(cuc.place, 'library');
  assert.equal(cuc.walking, false);
});

test('văn phòng yên thì mô phỏng báo ngủ tới giờ hẹn tiếp theo (không vẽ liên tục)', () => {
  const sim = new OfficeSim(layout());
  const busy = sim.step(100, NOW);
  assert.equal(busy, false, 'không ai làm gì thì không bận');
  assert.ok(Number.isFinite(sim.nextWake) && sim.nextWake > 100, `có giờ hẹn thức dậy (${sim.nextWake})`);
  sim.setViews({ An: view(WORK) });
  assert.equal(sim.nextWake, 0, 'dữ liệu đổi thì thức ngay');
  assert.equal(sim.step(200, NOW), true, 'có người đang gõ phím thì bận');
});

test('bộ mô phỏng dùng chung cho 2D và 3D: nhiều bên cùng bước, thời gian lùi nhẹ cũng không làm ai nhảy chỗ hay hỏng số', () => {
  const l = layout();
  const sim = new OfficeSim(l);
  sim.setViews({ Cúc: view({ status: 'working', activity: 'reading' }) });
  // Bộ vẽ đang mở bước theo đồng hồ khung hình; bộ đếm nền (hoặc bộ vẽ kia sau khi đổi 2D/3D) bước chen vào với mốc cũ hơn một chút.
  let ts = run(sim, 0, 8);
  const cuc = actor(sim, 'Cúc');
  assert.equal(cuc.walking, true, 'đang đi tới thư viện');
  const at = { x: cuc.x, z: cuc.z };
  sim.step(ts - 400, NOW + ts); // mốc lùi
  assert.deepEqual({ x: cuc.x, z: cuc.z }, at, 'mốc lùi không làm ai đi lùi hay nhảy');
  for (const a of sim.actors) assert.ok(Number.isFinite(a.x) && Number.isFinite(a.z));
  // Hai bên bước xen kẽ vẫn cho cùng quãng đường như một bên bước đều: không đi nhanh gấp đôi.
  const sim2 = new OfficeSim(l);
  sim2.setViews({ Cúc: view({ status: 'working', activity: 'reading' }) });
  let t2 = 0;
  for (let i = 0; i < 160; i += 1) {
    t2 += 50;
    sim2.step(t2, NOW + t2);
    sim2.step(t2 - 20, NOW + t2); // bên kia bước xen kẽ với mốc cũ hơn
  }
  const a1 = actor(sim, 'Cúc');
  const a2 = actor(sim2, 'Cúc');
  assert.ok(Math.hypot(a1.x - a2.x, a1.z - a2.z) < WALK_SPEED * 0.6, 'cùng một chỗ (sai khác dưới nửa giây đi bộ)');
  ts = run(sim, ts, 20);
  assert.equal(cuc.place, 'library', 'vẫn tới nơi bình thường');
});

test('mỗi tầng một bộ mô phỏng độc lập; người ở tầng khác không ảnh hưởng nhau, giữ nguyên trạng thái khi không ai xem', () => {
  const teams = [];
  for (let i = 0; i < 8; i += 1) teams.push({ id: `t${i}`, name: `t${i}`, lead: `L${i}`, members: [{ name: `L${i}`, role: 'lead', title: 'lead', model: 'sonnet', effort: 'low', strengths: [], isLead: true }, { name: `A${i}`, role: 'dev', title: 'dev', model: 'sonnet', effort: 'low', strengths: [], isLead: false }, { name: `B${i}`, role: 'dev', title: 'dev', model: 'sonnet', effort: 'low', strengths: [], isLead: false }] });
  const b = layoutBuilding(teams);
  assert.ok(b.floors.length >= 2);
  const sims = b.floors.map((f) => new OfficeSim(f));
  const upper = sims[1];
  const who = upper.actors[0].spot.name;
  assert.equal(sims[0].actors.some((a) => a.spot.name === who), false, 'mỗi người chỉ có mặt ở một tầng');
  upper.setViews({ [who]: view({ status: 'working', activity: 'reading' }) });
  // Tầng 1 chạy 20 giây, tầng 2 chạy ngầm: người ở tầng 2 vẫn tới thư viện của tầng 2 (không có đường xuyên tầng).
  let ts = 0;
  for (let i = 0; i < 600; i += 1) {
    ts += 50;
    upper.step(ts, NOW + ts);
  }
  const person = upper.actors.find((a) => a.spot.name === who);
  const library = b.floors[1].rooms.find((r) => r.id === 'library');
  assert.equal(person.place, 'library');
  assert.ok(Math.abs(person.x - library.x) < library.w / 2 && Math.abs(person.z - library.z) < library.d / 2);
  assert.ok(sims[0].actors.every((a) => a.place === 'desk' && !a.walking), 'tầng 1 không ai chạy khi không được bước');
});
