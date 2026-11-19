import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { openDb } from '../server/db.mjs';
import { startServer } from '../server/index.mjs';
import { inspect, inspectPush, pushToMain } from '../server/integrate.mjs';
import { git, makeProject, removeDir, testConfig, tmpDir } from './helpers.mjs';

/** Tạo nhánh company/<name> từ `from` có một commit, rồi quay về nhánh đang mở trước đó. */
function makeBranch(project, name, files, from = 'main') {
  const back = git(project, 'symbolic-ref', '--short', 'HEAD');
  git(project, 'checkout', '-q', '-b', `company/${name}`, from);
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(project, file), content);
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', `work ${name}`);
  git(project, 'checkout', '-q', back);
}

/** Một repo --bare đóng vai GitHub, đã có main của dự án. */
function addRemote(root, project, { push = true } = {}) {
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(project, 'remote', 'add', 'origin', remote);
  if (push) git(project, 'push', '-q', '-u', 'origin', 'main');
  return remote;
}

/** Người khác push lên GitHub một commit mới (qua một bản clone riêng). */
function pushFromElsewhere(root, remote, file, content) {
  const other = path.join(root, `other-${Date.now()}`);
  git(root, 'clone', '-q', remote, other);
  git(other, 'config', 'user.name', 'Other');
  git(other, 'config', 'user.email', 'other@example.com');
  git(other, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(other, file), content);
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'from elsewhere');
  git(other, 'push', '-q', 'origin', 'main');
}

function setup({ remote = true } = {}) {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const remotePath = remote ? addRemote(root, project) : null;
  const store = openDb(':memory:');
  const doneTask = (branch) => {
    const task = store.createTask({ title: `Việc ${branch}`, prompt: 'p', team: 'backend', member: 'An', role: 'dev' });
    return store.updateTask(task.id, { status: 'done', branch });
  };
  const args = (id, kind = 'task') => ({ store, projectRoot: project, kind, id });
  return { root, project, local, remote: remotePath, store, doneTask, args, cleanup: () => { store.close(); removeDir(root); } };
}

const remoteMain = (remote) => git(remote, 'rev-parse', 'refs/heads/main');
const parents = (repo, ref) => git(repo, 'rev-list', '--parents', '-n', '1', ref).split(' ').length - 1;
// Không dùng git() của helpers vì nó cắt dòng trống cuối file.
const remoteFile = (remote, file) => execFileSync('git', ['show', `main:${file}`], { cwd: remote, encoding: 'utf8', windowsHide: true }).replace(/\r\n/g, '\n');

test('push lên main khi thư mục dự án đang mở main: gộp, push, ghi nhận, lần sau báo đã push', async () => {
  const s = setup();
  try {
    makeBranch(s.project, 'an-task1', { 'feature.txt': 'hello\n' });
    const task = s.doneTask('company/an-task1');

    const before = await inspectPush(s.args(task.id));
    assert.equal(before.state, 'ready');
    assert.equal(before.target, 'main');
    assert.deepEqual(before.files, ['feature.txt']);
    assert.equal(fs.existsSync(path.join(s.project, 'feature.txt')), false, 'xem trước không đụng thư mục dự án');

    const result = await pushToMain(s.args(task.id));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.merged, true);
    assert.equal(remoteMain(s.remote), git(s.project, 'rev-parse', 'main'), 'GitHub và main ở máy trùng nhau');
    assert.equal(remoteMain(s.remote), result.commit);
    assert.equal(parents(s.remote, 'main'), 2, 'là commit gộp');
    assert.equal(remoteFile(s.remote, 'feature.txt'), 'hello\n');
    assert.ok(fs.existsSync(path.join(s.project, 'feature.txt')), 'thư mục dự án đang mở main nên có file mới');
    assert.equal(git(s.project, 'status', '--porcelain'), '');
    assert.equal(s.store.lastIntegration('task', task.id).target, 'main');

    const after = await inspectPush(s.args(task.id));
    assert.equal(after.state, 'pushed');
    assert.equal(after.commit, result.commit);
    assert.equal((await inspect(s.args(task.id))).state, 'integrated', 'khối "Đưa vào dự án" cũng thấy đã có');

    const again = await pushToMain(s.args(task.id));
    assert.equal(again.ok, false);
    assert.equal(again.state, 'pushed');
    assert.equal(remoteMain(s.remote), result.commit, 'bấm lần hai không tạo commit nào');
  } finally {
    s.cleanup();
  }
});

test('thư mục dự án đang mở nhánh khác và có file sửa dở: gộp thẳng vào main, không đổi nhánh, không đụng file', async () => {
  const s = setup();
  try {
    makeBranch(s.project, 'an-task1', { 'feature.txt': 'hello\n' });
    const task = s.doneTask('company/an-task1');
    git(s.project, 'checkout', '-q', '-b', 'feature/dang-lam');
    fs.writeFileSync(path.join(s.project, 'README.md'), '# sửa dở\n');
    fs.writeFileSync(path.join(s.project, 'nhap.txt'), 'chưa add\n');
    const featureHead = git(s.project, 'rev-parse', 'HEAD');
    const oldMain = git(s.project, 'rev-parse', 'main');

    const info = await inspectPush(s.args(task.id));
    assert.equal(info.state, 'ready', 'file sửa dở ở nhánh khác không chặn');
    assert.equal(info.current, 'feature/dang-lam');

    const result = await pushToMain(s.args(task.id));
    assert.equal(result.ok, true, result.error);
    assert.equal(git(s.project, 'symbolic-ref', '--short', 'HEAD'), 'feature/dang-lam', 'vẫn ở nhánh đang làm');
    assert.equal(git(s.project, 'rev-parse', 'HEAD'), featureHead);
    assert.equal(fs.readFileSync(path.join(s.project, 'README.md'), 'utf8'), '# sửa dở\n', 'code đang viết dở còn nguyên');
    assert.equal(fs.readFileSync(path.join(s.project, 'nhap.txt'), 'utf8'), 'chưa add\n');
    assert.equal(fs.existsSync(path.join(s.project, 'feature.txt')), false, 'thư mục làm việc không bị đổi');

    const main = git(s.project, 'rev-parse', 'main');
    assert.equal(remoteMain(s.remote), main);
    assert.deepEqual(git(s.project, 'rev-list', '--parents', '-n', '1', 'main').split(' ').slice(1), [oldMain, git(s.project, 'rev-parse', 'company/an-task1')]);
    assert.equal(remoteFile(s.remote, 'feature.txt'), 'hello\n');
    assert.equal(remoteFile(s.remote, 'README.md'), '# proj\n', 'file sửa dở không lọt vào main');
    assert.equal((await inspectPush(s.args(task.id))).state, 'pushed');
    assert.notEqual((await inspect(s.args(task.id))).state, 'integrated', 'nhánh đang mở chưa có thay đổi này: "Đưa vào dự án" không được báo là đã có');
  } finally {
    s.cleanup();
  }
});

test('GitHub có commit mới hơn: chặn trước khi gộp, main ở máy và GitHub giữ nguyên', async () => {
  const s = setup();
  try {
    makeBranch(s.project, 'an-task1', { 'feature.txt': 'hello\n' });
    const task = s.doneTask('company/an-task1');
    pushFromElsewhere(s.root, s.remote, 'other.txt', 'x\n');
    const remoteBefore = remoteMain(s.remote);
    const localBefore = git(s.project, 'rev-parse', 'main');
    assert.equal((await inspectPush(s.args(task.id))).state, 'ready', 'chưa tải về thì xem trước chưa biết');

    const result = await pushToMain(s.args(task.id));
    assert.equal(result.ok, false);
    assert.equal(result.state, 'blocked');
    assert.equal(result.merged, false);
    assert.match(result.error, /mới hơn/);
    assert.equal(git(s.project, 'rev-parse', 'main'), localBefore, 'không tạo commit gộp không push được');
    assert.equal(remoteMain(s.remote), remoteBefore);
    assert.equal(s.store.lastIntegration('task', task.id), null);
    assert.equal((await inspectPush(s.args(task.id))).state, 'blocked', 'sau khi tải về, xem trước cũng báo');

    git(s.project, 'pull', '-q', '--no-rebase', 'origin', 'main');
    const retry = await pushToMain(s.args(task.id));
    assert.equal(retry.ok, true, 'pull về rồi bấm lại thì được');
    assert.equal(remoteFile(s.remote, 'other.txt'), 'x\n', 'commit của người khác còn nguyên');
    assert.equal(remoteFile(s.remote, 'feature.txt'), 'hello\n');
  } finally {
    s.cleanup();
  }
});

test('xung đột với main: báo file, không gộp, main giữ nguyên (cả khi đang mở nhánh khác)', async () => {
  const s = setup();
  try {
    makeBranch(s.project, 'an-task1', { 'README.md': '# của nhân viên\n' });
    const task = s.doneTask('company/an-task1');
    fs.writeFileSync(path.join(s.project, 'README.md'), '# của chủ\n');
    git(s.project, 'commit', '-q', '-am', 'owner edit');
    git(s.project, 'push', '-q', 'origin', 'main');
    git(s.project, 'checkout', '-q', '-b', 'feature/x');
    const main = git(s.project, 'rev-parse', 'main');

    const info = await inspectPush(s.args(task.id));
    assert.equal(info.state, 'conflict');
    assert.deepEqual(info.conflictFiles, ['README.md']);
    const result = await pushToMain(s.args(task.id));
    assert.equal(result.ok, false);
    assert.equal(result.state, 'conflict');
    assert.equal(git(s.project, 'rev-parse', 'main'), main);
    assert.equal(remoteMain(s.remote), main);
  } finally {
    s.cleanup();
  }
});

test('GitHub từ chối push: phần gộp ở máy vẫn giữ, báo "chưa push", sửa xong bấm "Push lại" thì được', async () => {
  const s = setup();
  try {
    makeBranch(s.project, 'an-task1', { 'feature.txt': 'hello\n' });
    const task = s.doneTask('company/an-task1');
    const hook = path.join(s.remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "bi chan boi test" >&2\nexit 1\n', { mode: 0o755 });
    const remoteBefore = remoteMain(s.remote);

    const result = await pushToMain(s.args(task.id));
    assert.equal(result.ok, false);
    assert.equal(result.state, 'unpushed');
    assert.equal(result.merged, true);
    assert.match(result.error, /Đã gộp vào main ở máy nhưng push/);
    assert.match(result.error, /bi chan boi test/);
    assert.equal(remoteMain(s.remote), remoteBefore, 'GitHub không đổi');
    assert.equal(parents(s.project, 'main'), 2, 'main ở máy đã có commit gộp');
    const merged = git(s.project, 'rev-parse', 'main');

    const info = await inspectPush(s.args(task.id));
    assert.equal(info.state, 'unpushed');
    assert.equal(info.commit, merged);

    fs.rmSync(hook);
    const retry = await pushToMain(s.args(task.id));
    assert.equal(retry.ok, true, retry.error);
    assert.equal(retry.merged, false, 'push lại không gộp thêm lần nữa');
    assert.equal(remoteMain(s.remote), merged);
    assert.equal((await inspectPush(s.args(task.id))).state, 'pushed');
  } finally {
    s.cleanup();
  }
});

test('không có origin thì chặn; GitHub còn trống (chưa có main) thì push tạo main', async () => {
  const s = setup({ remote: false });
  try {
    makeBranch(s.project, 'an-task1', { 'feature.txt': 'hello\n' });
    const task = s.doneTask('company/an-task1');
    const none = await inspectPush(s.args(task.id));
    assert.equal(none.state, 'blocked');
    assert.match(none.reason, /chưa có remote "origin"/);
    assert.equal((await pushToMain(s.args(task.id))).ok, false);
    assert.equal(parents(s.project, 'main'), 0, 'không gộp gì');

    const remote = addRemote(s.root, s.project, { push: false });
    const result = await pushToMain(s.args(task.id));
    assert.equal(result.ok, true, result.error);
    assert.equal(remoteMain(remote), git(s.project, 'rev-parse', 'main'));
    assert.equal(remoteFile(remote, 'feature.txt'), 'hello\n');
  } finally {
    s.cleanup();
  }
});

test('dự án dùng master thay cho main: push vào master', async () => {
  const s = setup();
  try {
    git(s.project, 'branch', '-m', 'main', 'master');
    git(s.project, 'push', '-q', '-u', 'origin', 'master');
    makeBranch(s.project, 'an-task1', { 'feature.txt': 'hello\n' }, 'master');
    const task = s.doneTask('company/an-task1');
    assert.equal((await inspectPush(s.args(task.id))).target, 'master');
    const result = await pushToMain(s.args(task.id));
    assert.equal(result.ok, true, result.error);
    assert.equal(git(s.remote, 'rev-parse', 'refs/heads/master'), git(s.project, 'rev-parse', 'master'));
  } finally {
    s.cleanup();
  }
});

test('main đang mở ở một worktree khác, hoặc đang mở main mà có file sửa dở: chặn, không đổi gì', async () => {
  const s = setup();
  try {
    makeBranch(s.project, 'an-task1', { 'feature.txt': 'hello\n' });
    const task = s.doneTask('company/an-task1');
    const main = git(s.project, 'rev-parse', 'main');

    fs.writeFileSync(path.join(s.project, 'README.md'), '# sửa dở\n');
    const dirty = await inspectPush(s.args(task.id));
    assert.equal(dirty.state, 'blocked');
    assert.deepEqual(dirty.dirtyFiles, ['README.md']);
    assert.equal((await pushToMain(s.args(task.id))).ok, false);
    assert.equal(git(s.project, 'rev-parse', 'main'), main);
    git(s.project, 'checkout', '--', 'README.md');

    git(s.project, 'checkout', '-q', '-b', 'feature/x');
    const wt = path.join(s.root, 'wt-main');
    git(s.project, 'worktree', 'add', '-q', wt, 'main');
    const info = await inspectPush(s.args(task.id));
    assert.equal(info.state, 'blocked');
    assert.match(info.reason, /đang được mở ở thư mục/);
    assert.equal((await pushToMain(s.args(task.id))).ok, false);
    assert.equal(git(s.project, 'rev-parse', 'main'), main);
    assert.equal(remoteMain(s.remote), main);
  } finally {
    s.cleanup();
  }
});

test('yêu cầu: chỉ push được khi đã duyệt kết quả (done)', async () => {
  const s = setup();
  try {
    makeBranch(s.project, 'epic1', { 'b.txt': 'b\n' });
    const epic = s.store.createEpic({ title: 'E', prompt: 'p', director: 'Lan' });
    s.store.updateEpic(epic.id, { status: 'awaiting_result', merge_branch: 'company/epic1' });
    assert.equal((await inspectPush(s.args(epic.id, 'epic'))).state, 'not_ready');
    assert.equal((await pushToMain(s.args(epic.id, 'epic'))).ok, false);
    assert.equal(parents(s.project, 'main'), 0);

    s.store.updateEpic(epic.id, { status: 'done' });
    const result = await pushToMain(s.args(epic.id, 'epic'));
    assert.equal(result.ok, true, result.error);
    assert.equal(remoteFile(s.remote, 'b.txt'), 'b\n');
    assert.match(git(s.remote, 'log', '-1', '--format=%s', 'main'), /company: đưa company\/epic1 vào main \(epic #\d+: E\)/);
  } finally {
    s.cleanup();
  }
});

test('lệnh push không bao giờ có force', () => {
  const src = fs.readFileSync(new URL('../server/integrate.mjs', import.meta.url), 'utf8');
  const pushCalls = src.match(/\['push'[^\]]*\]/g) ?? [];
  assert.equal(pushCalls.length, 1);
  assert.doesNotMatch(pushCalls[0], /force|'-f'|'\+/);
});

function request(port, { method = 'GET', path: p, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
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

test('API push-main: xem trước bằng GET, push bằng POST (có kiểm tra nguồn), 409 khi đã push', async () => {
  const root = tmpDir();
  const { project, local } = makeProject(root);
  const remote = addRemote(root, project);
  const app = await startServer({ cfg: testConfig(root, project, local), withUi: false, log: () => {} });
  try {
    makeBranch(project, 'an-task1', { 'api.txt': 'x\n' });
    const task = app.store.createTask({ title: 'T', prompt: 'p', team: 'backend', member: 'An', role: 'dev' });
    app.store.updateTask(task.id, { status: 'done', branch: 'company/an-task1' });
    const host = { host: `localhost:${app.port}` };
    const json = { ...host, 'content-type': 'application/json' };
    const url = `/api/push-main/task/${task.id}`;
    const before = remoteMain(remote);

    const preview = await request(app.port, { path: url, headers: host });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.state, 'ready');

    const evil = await request(app.port, { method: 'POST', path: url, body: '{}', headers: { ...json, origin: 'https://evil.example.com' } });
    assert.equal(evil.status, 403, 'trang web lạ không được tự bấm push');
    assert.equal(remoteMain(remote), before);

    const ok = await request(app.port, { method: 'POST', path: url, body: '{}', headers: json });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.ok, true);
    assert.equal(remoteFile(remote, 'api.txt'), 'x\n');

    const again = await request(app.port, { method: 'POST', path: url, body: '{}', headers: json });
    assert.equal(again.status, 409);
    assert.equal(again.json.state, 'pushed');
  } finally {
    await app.close();
    removeDir(root);
  }
});
