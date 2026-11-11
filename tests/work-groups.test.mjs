// Bảng Công việc chia theo trạng thái (src/lib/work-groups.ts). Mục tiêu: không việc nào nằm sai thẻ, lặp hai nơi hay biến mất,
// và số trên thẻ "Cần bạn" luôn bằng số trên nút "N việc cần bạn quyết".
import assert from 'node:assert/strict';
import test from 'node:test';
import { ownerRequests } from '../src/office/status.ts';
import { daySection, defaultTab, groupWork, splitByPhase, tabOf, taskPhase } from '../src/lib/work-groups.ts';

const NOW = new Date(2026, 10, 11, 15, 0, 0).getTime();
const HOUR = 3600_000;

const epic = (id, status, over = {}) => ({ id, title: `Yêu cầu ${id}`, status, director: 'An', created_at: NOW - 10 * HOUR, finished_at: null, ...over });
const job = (id, status, over = {}) => ({ id, title: `Việc lớn ${id}`, status, lead: 'Minh', epic_id: null, created_at: NOW - 5 * HOUR, finished_at: null, ...over });
const task = (id, status, over = {}) => ({
  id, title: `Việc ${id}`, status, member: 'Bình', kind: 'work', job_id: null, epic_id: null, ask_owner_id: null, created_at: NOW - 2 * HOUR, finished_at: null, ...over,
});

function build({ epics = [], jobs = [], tasks = [], query = '' }) {
  const needs = ownerRequests(epics, jobs, tasks);
  return { groups: groupWork({ epics, jobs, tasks, needs, now: NOW, query }), needs };
}
const where = (groups) => {
  const out = {};
  for (const [tab, sections] of Object.entries(groups.tabs)) for (const s of sections) for (const i of s.items) (out[`${i.kind}:${i.id}`] ??= []).push(`${tab}/${s.key}`);
  return out;
};

test('mỗi trạng thái vào đúng thẻ và mục; việc xong, lỗi, chờ duyệt không nằm chung', () => {
  const { groups } = build({
    epics: [epic(1, 'awaiting_plan'), epic(2, 'running'), epic(3, 'done', { finished_at: NOW - HOUR }), epic(4, 'rejected'), epic(5, 'failed'), epic(6, 'reviewing')],
    jobs: [job(10, 'awaiting_choice'), job(11, 'draft'), job(12, 'stopped'), job(13, 'attention')],
    tasks: [task(20, 'running'), task(21, 'submitted'), task(22, 'paused_quota'), task(23, 'failed'), task(24, 'waiting_answer', { ask_owner_id: 7 }), task(25, 'waiting_answer'), task(26, 'done', { finished_at: NOW - 30 * HOUR })],
  });
  assert.deepEqual(where(groups), {
    'epic:1': ['need/approve'], 'epic:2': ['active/working'], 'epic:3': ['done/today'], 'epic:4': ['stopped/rejected'], 'epic:5': ['need/failed'], 'epic:6': ['active/reviewing'],
    'job:10': ['need/approve'], 'job:11': ['active/waiting'], 'job:12': ['stopped/stopped'], 'job:13': ['need/failed'],
    'task:20': ['active/working'], 'task:21': ['active/reviewing'], 'task:22': ['active/waiting'], 'task:23': ['need/failed'],
    'task:24': ['need/asking'], 'task:25': ['active/waiting'], 'task:26': ['done/yesterday'],
  });
});

test('số trên thẻ "Cần bạn" luôn bằng số việc chờ bạn (ownerRequests), kể cả việc con lỗi trong việc lớn còn chạy', () => {
  const { groups, needs } = build({
    epics: [epic(1, 'running')],
    jobs: [job(10, 'running'), job(11, 'failed', { epic_id: 1 }), job(12, 'done')],
    tasks: [
      task(20, 'failed', { job_id: 10 }), // việc lớn còn chạy: còn cứu được -> cần bạn
      task(21, 'failed', { job_id: 12 }), // việc lớn đã xong: không còn cần bạn
      task(22, 'running', { job_id: 10 }), // việc con bình thường: không hiện ở thẻ nào
      task(23, 'failed', { kind: 'plan', job_id: 10 }),
    ],
  });
  assert.equal(groups.counts.need, needs.length);
  const at = where(groups);
  assert.deepEqual(at['task:20'], ['need/failed']);
  const item = groups.tabs.need[0].items.find((i) => i.id === 20);
  assert.deepEqual(item.parent, { kind: 'job', id: 10 });
  for (const hidden of ['task:21', 'task:22', 'task:23', 'job:11']) assert.equal(at[hidden], undefined, `${hidden} là việc con, chỉ xem trong chi tiết`);
  assert.deepEqual(at['job:10'], ['active/working']);
});

test('không lặp: việc cấp cao nhất ở "Cần bạn" không xuất hiện thêm ở thẻ khác; danh sách needs trùng hoặc trỏ tới việc không có thì bỏ qua', () => {
  const epics = [epic(1, 'awaiting_result')];
  const tasks = [task(5, 'failed')];
  const needs = [...ownerRequests(epics, [], tasks), { kind: 'epic', id: 1, status: 'awaiting_result' }, { kind: 'task', id: 999, status: 'failed' }];
  const groups = groupWork({ epics, jobs: [], tasks, needs, now: NOW });
  assert.deepEqual(where(groups), { 'epic:1': ['need/approve'], 'task:5': ['need/failed'] });
  assert.equal(groups.counts.need, 2);
});

test('việc lỗi mà không còn gì để cứu (không nằm trong needs) vào thẻ Đã dừng, mục riêng, không biến mất', () => {
  // Việc lẻ kiểu khác "work" bị lỗi: ownerRequests bỏ qua.
  const tasks = [task(7, 'failed', { kind: 'answer' })];
  const groups = groupWork({ epics: [], jobs: [], tasks, needs: [], now: NOW });
  assert.deepEqual(where(groups), { 'task:7': ['stopped/failed'] });
  assert.equal(groups.counts.need, 0);
});

test('Hôm nay / Hôm qua / Trước đó tính theo nửa đêm giờ máy, không theo 24 giờ trước', () => {
  const midnight = new Date(2026, 10, 11, 0, 0, 0).getTime();
  assert.equal(daySection(midnight, NOW), 'today');
  assert.equal(daySection(midnight - 1, NOW), 'yesterday');
  assert.equal(daySection(midnight - 24 * HOUR, NOW), 'yesterday');
  assert.equal(daySection(midnight - 24 * HOUR - 1, NOW), 'earlier');
  // Việc xong chưa có finished_at (dữ liệu cũ): dùng lúc tạo, vẫn vào thẻ Xong.
  const groups = groupWork({ epics: [], jobs: [], tasks: [task(1, 'done', { finished_at: null, created_at: midnight - 100 * HOUR })], needs: [], now: NOW });
  assert.deepEqual(where(groups), { 'task:1': ['done/earlier'] });
});

test('trong mỗi mục, việc mới xong/mới tạo nằm trên cùng', () => {
  const tasks = [task(1, 'done', { finished_at: NOW - 3 * HOUR }), task(2, 'done', { finished_at: NOW - HOUR }), task(3, 'done', { finished_at: NOW - 2 * HOUR })];
  const groups = groupWork({ epics: [], jobs: [], tasks, needs: [], now: NOW });
  assert.deepEqual(groups.tabs.done[0].items.map((i) => i.id), [2, 3, 1]);
});

test('tìm kiếm lọc theo mã, tiêu đề, người phụ trách (không phân biệt hoa thường); số đếm theo kết quả lọc', () => {
  const tasks = [task(1, 'running', { title: 'Sửa API ảnh' }), task(2, 'running', { title: 'Trang chủ', member: 'Chi' }), task(3, 'failed', { title: 'Khác' })];
  const q = (query) => {
    const { groups } = build({ tasks, query });
    return Object.keys(where(groups)).sort();
  };
  assert.deepEqual(q('api'), ['task:1']);
  assert.deepEqual(q('CHI'), ['task:2']);
  assert.deepEqual(q('#3'), ['task:3']);
  assert.deepEqual(q('   '), ['task:1', 'task:2', 'task:3']);
  assert.equal(build({ tasks, query: 'không có' }).groups.counts.need, 0);
});

test('trạng thái lạ (máy chủ mới hơn giao diện) vẫn hiện ở thẻ Đang làm, không làm hỏng bảng', () => {
  const groups = groupWork({ epics: [epic(1, 'teleporting')], jobs: [], tasks: [], needs: [], now: NOW });
  assert.deepEqual(where(groups), { 'epic:1': ['active/working'] });
});

test('thẻ mặc định và tìm thẻ chứa một việc', () => {
  assert.equal(defaultTab({ need: 1, active: 5, done: 3, stopped: 0 }), 'need');
  assert.equal(defaultTab({ need: 0, active: 0, done: 3, stopped: 0 }), 'done');
  assert.equal(defaultTab({ need: 0, active: 0, done: 0, stopped: 0 }), 'active');
  const { groups } = build({ tasks: [task(1, 'done', { finished_at: NOW })] });
  assert.equal(tabOf(groups, 'task', 1), 'done');
  assert.equal(tabOf(groups, 'task', 2), null);
});

test('việc con trong chi tiết chia theo giai đoạn, lỗi đứng đầu, bỏ nhóm rỗng', () => {
  const list = [task(1, 'done'), task(2, 'failed'), task(3, 'running'), task(4, 'submitted'), task(5, 'stopped')];
  assert.deepEqual(splitByPhase(list, (t) => taskPhase(t.status)).map((g) => [g.phase, g.items.map((t) => t.id)]), [
    ['problem', [2]], ['active', [3, 4]], ['done', [1]], ['stopped', [5]],
  ]);
  assert.deepEqual(splitByPhase([], (t) => taskPhase(t.status)), []);
});
