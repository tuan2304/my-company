import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { openDb } from '../server/db.mjs';
import { UserError } from '../server/errors.mjs';
import { startServer } from '../server/index.mjs';
import { CATCH_UP_MS, RETRY_AFTER_ERROR_MS, Scheduler, dueTimeToday, nextRunAt, validateSchedule } from '../server/scheduler.mjs';
import { loadTemplates } from '../server/templates.mjs';
import { REPO, makeProject, removeDir, testConfig, tmpDir } from './helpers.mjs';

const { templates: TEMPLATES } = loadTemplates({ dir: path.join(REPO, 'templates') });
const BUILD = TEMPLATES.find((t) => t.id === 'kiem-tra-build');
const BUG = TEMPLATES.find((t) => t.id === 'sua-loi');

// Thứ Sáu 6/11/2026, giờ máy. (getDay() = 5)
const at = (h, m = 0, day = 6) => new Date(2026, 10, day, h, m, 0, 0).getTime();

/** Bộ chạy giả: ghi lại việc được giao và cho phép đổi trạng thái tạm dừng. */
function fixture({ now = at(7, 0) } = {}) {
  const store = openDb(':memory:');
  const clock = { now };
  const made = [];
  const state = { manualPause: false, pausedUntil: 0, failWith: null };
  const runner = {
    snapshot: () => ({ manualPause: state.manualPause, pausedUntil: state.pausedUntil }),
    jobs: {
      create: async (args) => {
        if (state.failWith) throw state.failWith;
        const job = store.createJob({ title: args.title, prompt: args.prompt, acceptance: args.acceptance, team: args.team, lead: 'Phúc' });
        made.push({ kind: 'job', id: job.id, args });
        return job;
      },
    },
    epics: {
      create: async (args) => {
        if (state.failWith) throw state.failWith;
        const epic = store.createEpic({ title: args.title, prompt: args.prompt, acceptance: args.acceptance, director: 'Hòa' });
        made.push({ kind: 'epic', id: epic.id, args });
        return epic;
      },
    },
  };
  const scheduler = new Scheduler({ store, runner, getTemplates: () => TEMPLATES, now: () => clock.now });
  const add = (over = {}, template = BUILD) => {
    const clean = validateSchedule({ name: 'Sáng', at_time: '08:30', params: {}, ...over }, template);
    const s = store.createSchedule({ name: clean.name, template: template.id, params: clean.params, days: clean.days, atTime: clean.atTime, maxPerDay: clean.maxPerDay });
    return s;
  };
  const enable = (s) => store.updateSchedule(s.id, { enabled: 1 });
  return { store, clock, made, state, scheduler, add, enable };
}

test('lịch mới tạo mặc định TẮT và không tự chạy dù đã quá giờ', async () => {
  const f = fixture({ now: at(9, 0) });
  const s = f.add();
  assert.equal(s.enabled, 0);
  assert.deepEqual(await f.scheduler.tick(), []);
  assert.equal(f.made.length, 0);
});

test('đến giờ thì giao đúng một việc, tick lại không giao thêm', async () => {
  const f = fixture();
  const s = f.enable(f.add());
  assert.deepEqual(await f.scheduler.tick(), [], 'chưa tới 08:30');
  f.clock.now = at(8, 30);
  const fired = await f.scheduler.tick();
  assert.equal(fired.length, 1);
  assert.deepEqual(f.made.map((m) => [m.kind, m.args.team, m.args.title]), [['job', 'quality', 'Kiểm tra build và test']]);
  assert.equal(f.store.getSchedule(s.id).runs_today, 1);
  f.clock.now = at(8, 31);
  assert.deepEqual(await f.scheduler.tick(), []);
  assert.equal(f.made.length, 1);
});

test('lần chạy trước chưa xong thì không chồng thêm; xong rồi thì ngày hôm sau chạy tiếp', async () => {
  const f = fixture({ now: at(8, 30) });
  const s = f.enable(f.add());
  await f.scheduler.tick();
  const first = f.made[0];

  // Ngày hôm sau (thứ Bảy 7/11 không nằm trong thứ 2-6) nên chọn thứ Hai 9/11.
  f.clock.now = at(8, 30, 9);
  assert.deepEqual(await f.scheduler.tick(), [], 'việc hôm trước vẫn đang chạy nên không giao thêm');
  assert.equal(f.made.length, 1);

  f.store.updateJob(first.id, { status: 'done' });
  assert.equal((await f.scheduler.tick()).length, 1);
  assert.equal(f.made.length, 2);
  assert.equal(f.store.getSchedule(s.id).runs_today, 1, 'số lần trong ngày tính lại theo ngày mới');
});

test('việc đang cần chủ xem (attention) vẫn tính là đang mở', async () => {
  const f = fixture({ now: at(8, 30) });
  f.enable(f.add());
  await f.scheduler.tick();
  f.store.updateJob(f.made[0].id, { status: 'attention' });
  f.clock.now = at(8, 30, 9);
  assert.deepEqual(await f.scheduler.tick(), []);
});

test('công ty đang tạm dừng (hạn mức hoặc bạn bấm) thì bỏ qua, hết tạm dừng trong thời gian chạy bù thì chạy', async () => {
  const f = fixture({ now: at(8, 30) });
  f.enable(f.add());
  f.state.pausedUntil = at(9, 0);
  assert.deepEqual(await f.scheduler.tick(), []);
  f.state.pausedUntil = 0;
  f.state.manualPause = true;
  f.clock.now = at(8, 45);
  assert.deepEqual(await f.scheduler.tick(), []);
  f.state.manualPause = false;
  f.clock.now = at(9, 15);
  assert.equal((await f.scheduler.tick()).length, 1, 'còn trong 3 giờ chạy bù');
});

test('lỡ giờ quá 3 giờ thì bỏ lượt, không bù dồn; lỡ trong 3 giờ thì chạy bù đúng một lần', async () => {
  const f = fixture({ now: at(8, 30) + CATCH_UP_MS + 60_000 });
  f.enable(f.add());
  assert.deepEqual(await f.scheduler.tick(), [], 'quá hạn chạy bù');
  f.clock.now = at(10, 0);
  assert.equal((await f.scheduler.tick()).length, 1);
  f.clock.now = at(10, 1);
  assert.deepEqual(await f.scheduler.tick(), []);
  assert.equal(f.made.length, 1);
});

test('chỉ chạy vào các thứ đã chọn', async () => {
  const f = fixture({ now: at(8, 30, 7) }); // thứ Bảy
  f.enable(f.add({ days: [1, 2, 3, 4, 5] }));
  assert.deepEqual(await f.scheduler.tick(), []);
  f.clock.now = at(8, 30, 9); // thứ Hai
  assert.equal((await f.scheduler.tick()).length, 1);
});

test('trần số lần chạy tự động mỗi ngày', async () => {
  const f = fixture({ now: at(8, 30) });
  const s = f.enable(f.add({ max_per_day: 1 }));
  await f.scheduler.tick();
  f.store.updateJob(f.made[0].id, { status: 'done' });
  // Lùi last_run_at để mô phỏng "đến hạn lần nữa" trong cùng ngày: trần ngày vẫn phải chặn.
  f.store.updateSchedule(s.id, { last_run_at: at(0, 1) });
  f.clock.now = at(8, 40);
  assert.deepEqual(await f.scheduler.tick(), []);
  assert.equal(f.made.length, 1);
});

test('giao việc lỗi (team không có...) thì ghi lỗi, không tính một lần chạy, và chờ 10 phút mới thử lại', async () => {
  const f = fixture({ now: at(8, 30) });
  const s = f.enable(f.add());
  f.state.failWith = new UserError('Không có team "quality".');
  assert.deepEqual(await f.scheduler.tick(), []);
  assert.match(f.store.getSchedule(s.id).last_error, /Không có team/);
  assert.equal(f.store.getSchedule(s.id).runs_today, 0);

  f.state.failWith = null;
  f.clock.now = at(8, 30) + RETRY_AFTER_ERROR_MS - 1000;
  assert.deepEqual(await f.scheduler.tick(), [], 'chưa đủ 10 phút');
  f.clock.now = at(8, 30) + RETRY_AFTER_ERROR_MS + 1000;
  assert.equal((await f.scheduler.tick()).length, 1);
  assert.equal(f.store.getSchedule(s.id).last_error, null);
});

test('lỗi không phải do người dùng (lỗi hệ thống) không bị nuốt', async () => {
  const f = fixture({ now: at(8, 30) });
  f.enable(f.add());
  f.state.failWith = new Error('hỏng thật');
  await assert.rejects(() => f.scheduler.tick(), /hỏng thật/);
  // tick() phải nhả khóa để lần sau còn chạy được.
  f.state.failWith = null;
  assert.equal((await f.scheduler.tick()).length, 1);
});

test('"Chạy ngay" giao việc dù chưa tới giờ, không chồng lên lần đang mở, không tốn trần ngày', async () => {
  const f = fixture({ now: at(7, 0) });
  const s = f.add({ max_per_day: 1 });
  const ref = await f.scheduler.runNow(s.id);
  assert.equal(ref.kind, 'job');
  assert.equal(f.store.getSchedule(s.id).runs_today, 0);
  await assert.rejects(() => f.scheduler.runNow(s.id), /vẫn chưa xong/);
  f.store.updateJob(ref.id, { status: 'done' });
  await f.scheduler.runNow(s.id);
  assert.equal(f.made.length, 2);
});

test('mẫu bị xóa thì lịch ghi lỗi chứ không sập', async () => {
  const f = fixture({ now: at(8, 30) });
  const s = f.enable(f.add());
  f.scheduler.getTemplates = () => [];
  assert.deepEqual(await f.scheduler.tick(), []);
  assert.match(f.store.getSchedule(s.id).last_error, /không còn/);
});

test('lịch dùng mẫu yêu cầu (epic) điền đúng giá trị', async () => {
  const f = fixture({ now: at(8, 30) });
  f.enable(f.add({ params: { mo_ta: 'Trang chủ trắng xóa' } }, BUG));
  await f.scheduler.tick();
  assert.equal(f.made[0].kind, 'epic');
  assert.equal(f.made[0].args.title, 'Sửa lỗi: Trang chủ trắng xóa');
});

test('kiểm tra dữ liệu khi tạo lịch', () => {
  assert.throws(() => validateSchedule({ name: '', at_time: '08:30' }, BUILD), /Thiếu tên/);
  assert.throws(() => validateSchedule({ name: 'a', at_time: '8:30' }, BUILD), /HH:MM/);
  assert.throws(() => validateSchedule({ name: 'a', at_time: '24:00' }, BUILD), /HH:MM/);
  assert.throws(() => validateSchedule({ name: 'a', at_time: '08:30', days: [] }, BUILD), /ít nhất một ngày/);
  assert.throws(() => validateSchedule({ name: 'a', at_time: '08:30', days: [7] }, BUILD), /từ 0/);
  assert.throws(() => validateSchedule({ name: 'a', at_time: '08:30', max_per_day: 99 }, BUILD), /từ 1 đến 10/);
  assert.throws(() => validateSchedule({ name: 'a', at_time: '08:30', params: {} }, BUG), /thiếu "Mô tả lỗi"/, 'thiếu ô bắt buộc của mẫu thì báo ngay lúc tạo');
  assert.deepEqual(validateSchedule({ name: ' a ', at_time: '08:30', days: [5, 1, 1] }, BUILD).days, [1, 5]);
});

test('dueTimeToday và nextRunAt', () => {
  const s = { days: '[1,2,3,4,5]', at_time: '08:30', last_run_at: null };
  assert.equal(dueTimeToday(s, at(12, 0, 6)), at(8, 30, 6));
  assert.equal(dueTimeToday(s, at(12, 0, 7)), null, 'thứ Bảy không chạy');
  assert.equal(nextRunAt(s, at(7, 0, 6)), at(8, 30, 6));
  assert.equal(nextRunAt(s, at(12, 0, 6)), at(8, 30, 9), 'quá hạn chạy bù thì sang thứ Hai');
  assert.equal(nextRunAt(s, at(9, 0, 6)), at(9, 0, 6), 'còn trong thời gian chạy bù: coi như sắp chạy');
  assert.equal(nextRunAt({ ...s, days: '[]' }, at(7, 0, 6)), null);
});

// ---- Qua HTTP với máy chủ thật ----

async function bootHttp() {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg = testConfig(root, project, local);
  const app = await startServer({ cfg, withUi: false, log: () => {} });
  app.runner.setManualPause(true); // chỉ kiểm tra việc được tạo, không chạy agent
  const call = async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${app.port}${url}`, {
      method,
      headers: { host: `localhost:${app.port}`, 'content-type': 'application/json', origin: `http://localhost:${app.port}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  return { root, app, call, cleanup: async () => { await app.close(); removeDir(root); } };
}

test('API: liệt kê mẫu, điền thử, chạy mẫu thành việc lớn và yêu cầu', async () => {
  const ctx = await bootHttp();
  try {
    const list = await ctx.call('GET', '/api/templates');
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.errors, []);
    assert.equal(list.data.templates.length, 4);
    assert.ok(!('prompt' in list.data.templates[0]), 'danh sách không kèm nội dung mẫu');

    const render = await ctx.call('POST', '/api/templates/sua-loi/render', { values: { mo_ta: 'Lỗi X' } });
    assert.equal(render.data.filled.title, 'Sửa lỗi: Lỗi X');
    assert.equal((await ctx.call('POST', '/api/templates/sua-loi/render', { values: {} })).status, 400);
    assert.equal((await ctx.call('POST', '/api/templates/khong-co/render', {})).status, 404);

    const run = await ctx.call('POST', '/api/templates/kiem-tra-build/run', { values: {} });
    assert.equal(run.status, 201, JSON.stringify(run.data));
    assert.equal(run.data.kind, 'job');
    assert.equal(run.data.job.team, 'quality');
  } finally {
    await ctx.cleanup();
  }
});

test('API: tạo lịch (tắt sẵn), bật, chạy ngay, không chồng, tắt, xóa', async () => {
  const ctx = await bootHttp();
  try {
    assert.equal((await ctx.call('POST', '/api/schedules', { name: 'Sáng', template: 'khong-co', at_time: '08:30' })).status, 400);
    assert.equal((await ctx.call('POST', '/api/schedules', { name: 'Sáng', template: 'kiem-tra-build', at_time: 'sáng' })).status, 400);

    const created = await ctx.call('POST', '/api/schedules', { name: 'Sáng', template: 'kiem-tra-build', at_time: '08:30' });
    assert.equal(created.status, 201);
    const id = created.data.schedule.id;
    assert.equal(created.data.schedule.enabled, false);
    assert.deepEqual(created.data.schedule.days, [1, 2, 3, 4, 5]);
    assert.equal(created.data.schedule.next_run_at, null, 'tắt thì không có lần chạy kế tiếp');

    // Chạy test trong cửa sổ chạy bù (08:30–11:30 ngày thường) thì next_run_at là "bây giờ" của máy chủ, nên so với mốc lấy TRƯỚC khi gọi.
    const before = Date.now();
    const on = await ctx.call('POST', `/api/schedules/${id}/enable`);
    assert.equal(on.data.schedule.enabled, true);
    assert.ok(on.data.schedule.next_run_at >= before, `next_run_at=${on.data.schedule.next_run_at} < ${before}`);

    const now = await ctx.call('POST', `/api/schedules/${id}/run-now`);
    assert.equal(now.status, 200, JSON.stringify(now.data));
    assert.equal(now.data.ref.kind, 'job');
    assert.equal(now.data.schedule.open_run.id, now.data.ref.id);
    const again = await ctx.call('POST', `/api/schedules/${id}/run-now`);
    assert.equal(again.status, 400);
    assert.match(again.data.error, /vẫn chưa xong/);

    assert.equal((await ctx.call('POST', `/api/schedules/${id}/disable`)).data.schedule.enabled, false);
    assert.equal((await ctx.call('GET', '/api/schedules')).data.schedules.length, 1);
    assert.equal((await ctx.call('POST', `/api/schedules/${id}/delete`)).data.ok, true);
    assert.equal((await ctx.call('GET', '/api/schedules')).data.schedules.length, 0);
    assert.equal((await ctx.call('POST', '/api/schedules/999/enable')).status, 404);
  } finally {
    await ctx.cleanup();
  }
});
