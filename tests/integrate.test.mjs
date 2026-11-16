import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { openDb } from '../server/db.mjs';
import { startServer } from '../server/index.mjs';
import { inspect, integrate, parseMergeTreeConflicts } from '../server/integrate.mjs';
import { git, makeProject, removeDir, testConfig, tmpDir } from './helpers.mjs';

/** Tạo nhánh company/<name> có một commit sửa/ thêm file, rồi quay về main. */
function makeBranch(project, name, files) {
  git(project, 'checkout', '-q', '-b', `company/${name}`, 'main');
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(project, file), content);
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', `work ${name}`);
  git(project, 'checkout', '-q', 'main');
}

function setup() {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const store = openDb(':memory:');
  const doneTask = (branch, extra = {}) => {
    const task = store.createTask({ title: `Việc ${branch}`, prompt: 'p', team: 'backend', member: 'An', role: 'dev', ...extra });
    return store.updateTask(task.id, { status: 'done', branch });
  };
  return { root, project, local, store, doneTask, cleanup: () => { store.close(); removeDir(root); } };
}

const status = (project) => git(project, 'status', '--porcelain');

test('đưa việc lẻ đã xong vào dự án: có file, có commit gộp, ghi nhận lại, lần sau báo đã có', async () => {
  const s = setup();
  try {
    makeBranch(s.project, 'an-task1', { 'feature.txt': 'hello\n' });
    const task = s.doneTask('company/an-task1');
    const before = await inspect({ store: s.store, projectRoot: s.project, kind: 'task', id: task.id });
    assert.equal(before.state, 'ready');
    assert.equal(before.target, 'main');
    assert.deepEqual(before.files, ['feature.txt']);
    assert.equal(fs.existsSync(path.join(s.project, 'feature.txt')), false, 'xem trước không được đụng thư mục dự án');

    const result = await integrate({ store: s.store, projectRoot: s.project, kind: 'task', id: task.id });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(s.project, 'feature.txt'), 'utf8').replace(/\r\n/g, '\n'), 'hello\n');
    assert.equal(git(s.project, 'rev-parse', 'HEAD'), result.commit);
    assert.match(git(s.project, 'log', '-1', '--format=%s'), /company: đưa company\/an-task1 vào dự án/);
    assert.equal(git(s.project, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'là commit gộp (hai cha)');
    assert.equal(status(s.project), '');

    const after = await inspect({ store: s.store, projectRoot: s.project, kind: 'task', id: task.id });
    assert.equal(after.state, 'integrated');
    assert.equal(after.integration.commit_id, result.commit);

    const again = await integrate({ store: s.store, projectRoot: s.project, kind: 'task', id: task.id });
    assert.equal(again.ok, false, 'bấm lần hai không gộp thêm');
    assert.equal(again.state, 'integrated');
  } finally {
    s.cleanup();
  }
});

test('thư mục dự án đang có thay đổi chưa commit thì từ chối và không đụng vào file nào', async () => {
  const s = setup();
  try {
    makeBranch(s.project, 'an-task1', { 'feature.txt': 'x\n' });
    const task = s.doneTask('company/an-task1');
    fs.writeFileSync(path.join(s.project, 'README.md'), '# sửa dở\n');
    const head = git(s.project, 'rev-parse', 'HEAD');

    const info = await inspect({ store: s.store, projectRoot: s.project, kind: 'task', id: task.id });
    assert.equal(info.state, 'blocked');
    assert.deepEqual(info.dirtyFiles, ['README.md']);

    const result = await integrate({ store: s.store, projectRoot: s.project, kind: 'task', id: task.id });
    assert.equal(result.ok, false);
    assert.equal(git(s.project, 'rev-parse', 'HEAD'), head);
    assert.equal(fs.readFileSync(path.join(s.project, 'README.md'), 'utf8'), '# sửa dở\n', 'code đang viết dở của người dùng còn nguyên');
    assert.equal(fs.existsSync(path.join(s.project, 'feature.txt')), false);
  } finally {
    s.cleanup();
  }
});

test('xung đột: báo trước các file, từ chối gộp, thư mục dự án sạch và không kẹt trạng thái gộp dở', async () => {
  const s = setup();
  try {
    makeBranch(s.project, 'an-task1', { 'README.md': '# từ nhân viên\n' });
    fs.writeFileSync(path.join(s.project, 'README.md'), '# từ người dùng\n');
    git(s.project, 'commit', '-q', '-am', 'người dùng sửa README');
    const task = s.doneTask('company/an-task1');
    const head = git(s.project, 'rev-parse', 'HEAD');

    const info = await inspect({ store: s.store, projectRoot: s.project, kind: 'task', id: task.id });
    assert.equal(info.state, 'conflict');
    assert.deepEqual(info.conflictFiles, ['README.md']);

    const result = await integrate({ store: s.store, projectRoot: s.project, kind: 'task', id: task.id });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'conflict');
    assert.equal(git(s.project, 'rev-parse', 'HEAD'), head);
    assert.equal(status(s.project), '');
    assert.equal(fs.existsSync(path.join(s.project, '.git', 'MERGE_HEAD')), false);
    assert.equal(fs.readFileSync(path.join(s.project, 'README.md'), 'utf8'), '# từ người dùng\n');
    assert.equal(s.store.lastIntegration('task', task.id), null, 'gộp hỏng thì không ghi nhận');
  } finally {
    s.cleanup();
  }
});

test('không đưa được: việc chưa xong, việc con của việc lớn, nhánh đã mất, nhánh tên lạ, đang detached HEAD', async () => {
  const s = setup();
  try {
    const running = s.store.createTask({ title: 'a', prompt: 'p', team: 'backend', member: 'An', role: 'dev' });
    s.store.updateTask(running.id, { status: 'running', branch: 'company/an-task1' });
    assert.equal((await inspect({ store: s.store, projectRoot: s.project, kind: 'task', id: running.id })).state, 'not_ready');

    const job = s.store.createJob({ title: 'J', prompt: 'p', team: 'backend', lead: 'Minh' });
    const child = s.doneTask('company/an-task2', { kind: 'work', jobId: job.id });
    const childInfo = await inspect({ store: s.store, projectRoot: s.project, kind: 'task', id: child.id });
    assert.equal(childInfo.state, 'not_ready');
    assert.match(childInfo.reason, /việc lớn/);

    const gone = s.doneTask('company/an-task3');
    assert.equal((await inspect({ store: s.store, projectRoot: s.project, kind: 'task', id: gone.id })).state, 'missing');

    const weird = s.doneTask('main');
    const weirdInfo = await inspect({ store: s.store, projectRoot: s.project, kind: 'task', id: weird.id });
    assert.equal(weirdInfo.state, 'missing', 'chỉ chấp nhận nhánh company/...: không bao giờ gộp "main" hay tên có ký tự lạ');
    const injected = s.doneTask('company/x --upload-pack=evil');
    assert.equal((await inspect({ store: s.store, projectRoot: s.project, kind: 'task', id: injected.id })).state, 'missing');

    assert.equal((await inspect({ store: s.store, projectRoot: s.project, kind: 'job', id: 999 })).state, 'not_ready');
    assert.equal((await inspect({ store: s.store, projectRoot: s.project, kind: 'rm', id: 1 })).state, 'not_ready');

    makeBranch(s.project, 'an-task4', { 'f.txt': '1\n' });
    const ok = s.doneTask('company/an-task4');
    git(s.project, 'checkout', '-q', '--detach');
    assert.equal((await inspect({ store: s.store, projectRoot: s.project, kind: 'task', id: ok.id })).state, 'blocked');
  } finally {
    s.cleanup();
  }
});

test('việc lớn và yêu cầu: dùng nhánh gộp; việc lớn trong yêu cầu chỉ đưa riêng được khi yêu cầu đã đóng', async () => {
  const s = setup();
  try {
    makeBranch(s.project, 'job1', { 'a.txt': 'a\n' });
    makeBranch(s.project, 'epic1', { 'b.txt': 'b\n' });
    const job = s.store.createJob({ title: 'J', prompt: 'p', team: 'backend', lead: 'Minh' });
    s.store.updateJob(job.id, { status: 'running', merge_branch: 'company/job1' });
    assert.equal((await inspect({ store: s.store, projectRoot: s.project, kind: 'job', id: job.id })).state, 'not_ready', 'chưa xong thì chưa đưa');
    s.store.updateJob(job.id, { status: 'done' });
    const r1 = await integrate({ store: s.store, projectRoot: s.project, kind: 'job', id: job.id });
    assert.equal(r1.ok, true);
    assert.ok(fs.existsSync(path.join(s.project, 'a.txt')));

    // Việc lớn trong yêu cầu: yêu cầu còn chạy thì không đưa riêng; yêu cầu đã đóng (kể cả "cần xem", lỗi) thì đưa riêng được,
    // khỏi phải cứu tay bằng git như vụ epic #1 của web96.
    makeBranch(s.project, 'job2', { 'c.txt': 'c\n' });
    const epic = s.store.createEpic({ title: 'E', prompt: 'p', director: 'Lan' });
    s.store.updateEpic(epic.id, { status: 'running' });
    const inEpic = s.store.createJob({ title: 'J2', prompt: 'p', team: 'backend', lead: 'Minh', epicId: epic.id });
    s.store.updateJob(inEpic.id, { status: 'done', merge_branch: 'company/job2' });
    const open = await inspect({ store: s.store, projectRoot: s.project, kind: 'job', id: inEpic.id });
    assert.equal(open.state, 'not_ready');
    assert.match(open.reason, /đang chạy \(running\)/);
    s.store.updateEpic(epic.id, { status: 'attention' });
    assert.equal((await inspect({ store: s.store, projectRoot: s.project, kind: 'job', id: inEpic.id })).state, 'ready', 'yêu cầu đóng ở "cần xem": đưa riêng được');
    s.store.updateJob(inEpic.id, { status: 'attention', merge_branch: null });
    assert.match((await inspect({ store: s.store, projectRoot: s.project, kind: 'job', id: inEpic.id })).reason, /chưa có nhánh gộp/);
    s.store.updateJob(inEpic.id, { merge_branch: 'company/job2' });
    const r3 = await integrate({ store: s.store, projectRoot: s.project, kind: 'job', id: inEpic.id });
    assert.equal(r3.ok, true, 'việc lớn "cần xem" đã có nhánh gộp, trong yêu cầu đã đóng: đưa riêng được');
    assert.ok(fs.existsSync(path.join(s.project, 'c.txt')));

    s.store.updateEpic(epic.id, { status: 'awaiting_result', merge_branch: 'company/epic1' });
    assert.equal((await inspect({ store: s.store, projectRoot: s.project, kind: 'epic', id: epic.id })).state, 'not_ready');
    s.store.updateEpic(epic.id, { status: 'done' });
    const r2 = await integrate({ store: s.store, projectRoot: s.project, kind: 'epic', id: epic.id });
    assert.equal(r2.ok, true);
    assert.ok(fs.existsSync(path.join(s.project, 'b.txt')));
  } finally {
    s.cleanup();
  }
});

test('hai lần bấm cùng lúc cho hai việc khác nhau: cả hai vào đủ, thư mục dự án không hỏng', async () => {
  const s = setup();
  try {
    makeBranch(s.project, 'an-task1', { 'one.txt': '1\n' });
    makeBranch(s.project, 'binh-task2', { 'two.txt': '2\n' });
    const t1 = s.doneTask('company/an-task1');
    const t2 = s.doneTask('company/binh-task2');
    const [r1, r2, r1again] = await Promise.all([
      integrate({ store: s.store, projectRoot: s.project, kind: 'task', id: t1.id }),
      integrate({ store: s.store, projectRoot: s.project, kind: 'task', id: t2.id }),
      integrate({ store: s.store, projectRoot: s.project, kind: 'task', id: t1.id }),
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r1again.ok, false, 'bấm đúp cùng một việc chỉ gộp một lần');
    assert.ok(fs.existsSync(path.join(s.project, 'one.txt')) && fs.existsSync(path.join(s.project, 'two.txt')));
    assert.equal(status(s.project), '');
  } finally {
    s.cleanup();
  }
});

test('git từ chối vì file chưa theo dõi sẽ bị đè: không mất file của người dùng, không ghi nhận', async () => {
  const s = setup();
  try {
    makeBranch(s.project, 'an-task1', { 'notes.txt': 'của nhân viên\n' });
    const task = s.doneTask('company/an-task1');
    fs.writeFileSync(path.join(s.project, 'notes.txt'), 'của người dùng, chưa commit\n');
    const result = await integrate({ store: s.store, projectRoot: s.project, kind: 'task', id: task.id });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(path.join(s.project, 'notes.txt'), 'utf8'), 'của người dùng, chưa commit\n');
    assert.equal(s.store.lastIntegration('task', task.id), null);
    assert.equal(fs.existsSync(path.join(s.project, '.git', 'MERGE_HEAD')), false);
  } finally {
    s.cleanup();
  }
});

test('parseMergeTreeConflicts đọc danh sách file đến dòng trống', () => {
  assert.deepEqual(parseMergeTreeConflicts('abc123\na.txt\nb/c.txt\n\nAuto-merging a.txt\nCONFLICT (content): ...\n'), ['a.txt', 'b/c.txt']);
  assert.deepEqual(parseMergeTreeConflicts('abc123\n'), []);
});

function request(port, { method = 'GET', path: urlPath, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* không phải JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('API: xem trước bằng GET, gộp bằng POST (có kiểm tra nguồn), 409 khi không đưa được', async () => {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const app = await startServer({ cfg: testConfig(root, project, local), withUi: false, log: () => {} });
  try {
    makeBranch(project, 'an-task1', { 'api.txt': 'x\n' });
    const task = app.store.createTask({ title: 'T', prompt: 'p', team: 'backend', member: 'An', role: 'dev' });
    app.store.updateTask(task.id, { status: 'done', branch: 'company/an-task1' });
    const host = { host: `localhost:${app.port}` };
    const json = { ...host, 'content-type': 'application/json' };
    const url = `/api/integrate/task/${task.id}`;

    const preview = await request(app.port, { path: url, headers: host });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.state, 'ready');
    assert.equal(fs.existsSync(path.join(project, 'api.txt')), false);

    const evil = await request(app.port, { method: 'POST', path: url, body: '{}', headers: { ...json, origin: 'https://evil.example.com' } });
    assert.equal(evil.status, 403, 'trang web lạ không được tự bấm "Đưa vào dự án"');
    const badType = await request(app.port, { method: 'POST', path: url, body: '{}', headers: { ...host, 'content-type': 'text/plain' } });
    assert.equal(badType.status, 415);
    assert.equal(fs.existsSync(path.join(project, 'api.txt')), false);

    const ok = await request(app.port, { method: 'POST', path: url, body: '{}', headers: json });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.ok(fs.existsSync(path.join(project, 'api.txt')));

    const again = await request(app.port, { method: 'POST', path: url, body: '{}', headers: json });
    assert.equal(again.status, 409);
    assert.equal(again.json.state, 'integrated');

    const none = await request(app.port, { path: '/api/integrate/task/9999', headers: host });
    assert.equal(none.json.state, 'not_ready');
  } finally {
    await app.close();
    removeDir(root);
  }
});
