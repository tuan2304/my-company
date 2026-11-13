import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { startServer } from '../server/index.mjs';
import { makeProject, removeDir, testConfig, tmpDir, waitFor } from './helpers.mjs';

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* không phải JSON */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function boot() {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const cfg = testConfig(root, project, local);
  const log = [];
  const app = await startServer({ cfg, withUi: false, log: (m) => log.push(m) });
  const hostHeader = { host: `localhost:${app.port}` };
  return { root, app, hostHeader, log, cleanup: async () => { await app.close(); removeDir(root); } };
}

const json = { 'content-type': 'application/json' };

test('GET /api/state trả về dự án, team và trạng thái công ty', async () => {
  const { app, hostHeader, cleanup } = await boot();
  try {
    const res = await request(app.port, { path: '/api/state', headers: hostHeader });
    assert.equal(res.status, 200);
    assert.equal(res.json.project.hasProfile, true);
    assert.deepEqual(res.json.project.stack, ['Node']);
    const backend = res.json.teams.find((t) => t.id === 'backend');
    assert.deepEqual(backend.members.map((m) => `${m.name}:${m.model}`), ['Minh:opus', 'An:sonnet', 'Bình:sonnet', 'Hương:sonnet', 'Khang:sonnet', 'Nam:sonnet']);
    assert.deepEqual(backend.members.filter((m) => m.isLead).map((m) => m.name), ['Minh']);
    assert.equal(backend.lead, 'Minh');
    assert.equal(res.json.company.maxConcurrent, 6);
    assert.equal(res.json.configError, null);
  } finally {
    await cleanup();
  }
});

test('chặn Host lạ, Origin lạ và Content-Type sai (chống CSRF, DNS rebinding)', async () => {
  const { app, hostHeader, cleanup } = await boot();
  try {
    const body = JSON.stringify({ title: 'x', prompt: 'y', member: 'An' });
    const badHost = await request(app.port, { path: '/api/state', headers: { host: 'evil.example.com' } });
    assert.equal(badHost.status, 403);

    const badOrigin = await request(app.port, { method: 'POST', path: '/api/tasks', body, headers: { ...hostHeader, ...json, origin: 'https://evil.example.com' } });
    assert.equal(badOrigin.status, 403);

    const badType = await request(app.port, { method: 'POST', path: '/api/tasks', body, headers: { ...hostHeader, 'content-type': 'text/plain' } });
    assert.equal(badType.status, 415);

    const sameOrigin = await request(app.port, { method: 'POST', path: '/api/tasks', body: JSON.stringify({ title: 'x', prompt: 'y', member: 'Không ai' }), headers: { ...hostHeader, ...json, origin: `http://localhost:${app.port}` } });
    assert.equal(sameOrigin.status, 400, 'đi qua kiểm tra nguồn rồi mới bị từ chối vì tên không có');
    assert.match(sameOrigin.json.error, /Không có nhân viên/);

    const tooBig = await request(app.port, { method: 'POST', path: '/api/tasks', body: 'x'.repeat(200 * 1024), headers: { ...hostHeader, ...json } });
    assert.equal(tooBig.status === 400 || tooBig.status === 0, true);
  } catch (err) {
    // Máy chủ có thể cắt kết nối ngay khi thân yêu cầu quá lớn.
    if (!/socket hang up|ECONNRESET|EPIPE/.test(err.message)) throw err;
  } finally {
    await cleanup();
  }
});

test('luồng đầy đủ qua HTTP: giao việc, theo dõi qua SSE, đọc chi tiết, dừng', async () => {
  const { app, hostHeader, cleanup } = await boot();
  try {
    const received = [];
    const sse = http.get({ host: '127.0.0.1', port: app.port, path: '/api/stream', headers: hostHeader }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => received.push(chunk));
    });

    const created = await request(app.port, {
      method: 'POST', path: '/api/tasks', headers: { ...hostHeader, ...json },
      body: JSON.stringify({ title: 'Tạo hello', prompt: 'Tạo file hello.txt', member: 'An' }),
    });
    assert.equal(created.status, 201);
    const id = created.json.task.id;

    await waitFor(async () => (await request(app.port, { path: `/api/tasks/${id}`, headers: hostHeader })).json.task.status === 'done', { label: 'việc xong qua HTTP' });
    const detail = await request(app.port, { path: `/api/tasks/${id}`, headers: hostHeader });
    assert.ok(detail.json.events.length >= 4);
    assert.match(detail.json.task.result, /hello\.txt/);

    const list = await request(app.port, { path: '/api/tasks', headers: hostHeader });
    assert.equal(list.json.tasks[0].id, id);

    const stream = received.join('');
    assert.match(stream, /event: state/);
    assert.match(stream, /event: task/);
    assert.match(stream, /event: event/);
    assert.doesNotMatch(stream, /sk-ant-abcdefghijklmnop/, 'SSE không được lộ secret');
    sse.destroy();

    assert.equal((await request(app.port, { path: '/api/tasks/9999', headers: hostHeader })).status, 404);
    assert.equal((await request(app.port, { method: 'POST', path: '/api/tasks/9999/stop', headers: { ...hostHeader, ...json }, body: '{}' })).status, 404);
    assert.equal((await request(app.port, { method: 'POST', path: '/api/stop-all', headers: { ...hostHeader, ...json }, body: '{}' })).json.stopped, 0);
    assert.equal((await request(app.port, { path: '/khong-co', headers: hostHeader })).status, 404, 'không bật giao diện thì đường dẫn khác là 404');
  } finally {
    await cleanup();
  }
});

test('/api/doctor chạy được với claude giả', async () => {
  const { app, hostHeader, cleanup } = await boot();
  try {
    const res = await request(app.port, { path: '/api/doctor', headers: hostHeader });
    assert.equal(res.status, 200);
    const byId = Object.fromEntries(res.json.checks.map((c) => [c.id, c]));
    assert.equal(byId.claude.level, 'ok');
    assert.equal(byId.project.level, 'ok');
    assert.equal(byId.profile.level, 'ok');
    assert.equal(byId.teams.level, 'ok');
  } finally {
    await cleanup();
  }
});
