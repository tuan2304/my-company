import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { describeProjectRootSource, loadConfig, profileProjectRoot, resolveProjectRoot, TOOL_DIR } from '../server/config.mjs';
import { renderProjectDraft } from '../server/project.mjs';
import { REPO, tmpDir } from './helpers.mjs';

/** Chạy fn với COMPANY_PROJECT_ROOT / COMPANY_LOCAL_DIR đặt như ý, rồi trả môi trường về như cũ. */
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function writeProfile(localDir, frontmatter) {
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, 'project.md'), `---\n${frontmatter}\n---\nghi chú\n`, 'utf8');
}

test('root: trong local/project.md chỉ gốc dự án khi không có --project hay COMPANY_PROJECT_ROOT', () => {
  const dir = tmpDir();
  const project = path.join(dir, 'du-an');
  fs.mkdirSync(project);
  const local = path.join(dir, 'local');
  writeProfile(local, `name: demo\nroot: ${JSON.stringify(project)}`);

  withEnv({ COMPANY_PROJECT_ROOT: undefined }, () => {
    assert.equal(profileProjectRoot(local), path.resolve(project));
    assert.equal(resolveProjectRoot(undefined, local), path.resolve(project));
    const cfg = loadConfig({ overrides: { localDir: local } });
    assert.equal(cfg.projectRoot, path.resolve(project));
    assert.equal(cfg.projectRootSource, 'profile');
    assert.equal(cfg.projectName, 'du-an');
    assert.equal(cfg.localDir, path.resolve(local));
    assert.match(describeProjectRootSource(cfg.projectRootSource), /local\/project\.md/);

    // --project và biến môi trường đè lên hồ sơ (để thử một dự án khác mà không sửa hồ sơ).
    const other = path.join(dir, 'khac');
    assert.equal(loadConfig({ projectRoot: other, overrides: { localDir: local } }).projectRootSource, 'flag');
    assert.equal(loadConfig({ projectRoot: other, overrides: { localDir: local } }).projectRoot, path.resolve(other));
  });
  withEnv({ COMPANY_PROJECT_ROOT: path.join(dir, 'env-root') }, () => {
    const cfg = loadConfig({ overrides: { localDir: local } });
    assert.equal(cfg.projectRootSource, 'env');
    assert.equal(cfg.projectRoot, path.resolve(dir, 'env-root'));
  });
});

test('root: tương đối tính từ thư mục công cụ; thiếu hồ sơ, hồ sơ hỏng hay root rỗng thì về mặc định thư mục cha', () => {
  const dir = tmpDir();
  withEnv({ COMPANY_PROJECT_ROOT: undefined }, () => {
    const local = path.join(dir, 'local');
    writeProfile(local, 'name: demo\nroot: ../ben-canh');
    assert.equal(resolveProjectRoot(undefined, local), path.resolve(TOOL_DIR, '../ben-canh'));

    const empty = path.join(dir, 'empty');
    writeProfile(empty, 'name: demo\nroot: "  "');
    assert.equal(loadConfig({ overrides: { localDir: empty } }).projectRootSource, 'parent');

    const broken = path.join(dir, 'broken');
    writeProfile(broken, 'name: [chưa đóng');
    assert.equal(profileProjectRoot(broken), '', 'hồ sơ hỏng: không ném lỗi ở bước cấu hình, doctor sẽ báo');
    assert.equal(loadConfig({ overrides: { localDir: broken } }).projectRootSource, 'parent');

    const missing = path.join(dir, 'khong-co');
    const cfg = loadConfig({ overrides: { localDir: missing } });
    assert.equal(cfg.projectRootSource, 'parent');
    assert.equal(cfg.projectRoot, path.dirname(TOOL_DIR));
  });
});

test('init ghi root vào hồ sơ nháp khi gốc không phải thư mục cha; mẫu để comment khi là mặc định', () => {
  const draft = renderProjectDraft({ name: 'n', stack: [], commands: {}, root: 'D:\\du an\\web' });
  assert.match(draft, /^root: "D:\\\\du an\\\\web"$/m, 'đường dẫn có dấu cách và gạch chéo ngược phải được bao trong ngoặc kép');
  const local = path.join(tmpDir(), 'local');
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, 'project.md'), draft, 'utf8');
  assert.equal(profileProjectRoot(local), path.resolve('D:\\du an\\web'), 'đọc lại đúng đường dẫn đã ghi');

  const plain = renderProjectDraft({ name: 'n', stack: [], commands: {} });
  assert.match(plain, /^# root: /m);
  assert.doesNotMatch(plain, /^root:/m);
});

test('start từ chối chạy khi gốc dự án không phải git repo, nói rõ gốc lấy từ đâu và cách sửa', () => {
  const dir = tmpDir();
  const notRepo = path.join(dir, 'khong-phai-repo');
  fs.mkdirSync(notRepo);
  const env = { ...process.env, COMPANY_LOCAL_DIR: path.join(dir, 'local'), COMPANY_DATA_DIR: path.join(dir, 'data') };
  delete env.COMPANY_PROJECT_ROOT;

  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'cli.mjs'), 'start', '--project', notRepo], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Không khởi động/);
  assert.match(r.stderr, /theo --project/);
  assert.match(r.stderr, /không phải là git repo/);
  assert.match(r.stderr, /root: <thư mục dự án>/);
  assert.doesNotMatch(r.stdout, /Công ty đang chạy/);

  // Repo thật nhưng chưa có commit cũng bị chặn (nhân viên không có gì để rẽ nhánh).
  const bare = path.join(dir, 'chua-commit');
  fs.mkdirSync(bare);
  execFileSync('git', ['init', '-q'], { cwd: bare });
  const r2 = spawnSync(process.execPath, [path.join(REPO, 'bin', 'cli.mjs'), 'start', '--project', bare], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /chưa có commit nào/);
});
