// Kiểm thử các sửa đổi rút ra từ lần đưa công cụ vào một dự án thật (docs/VAN-DE-GAP-TREN-DU-AN-THAT.md):
// folders rỗng/loại trừ, khóa report/reports, init đoán lệnh, gốc dự án, báo lỗi skill từng file, role_skills.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { checkFolders, checkProjectRoot, checkRoleSkills } from '../server/doctor.mjs';
import { Jobs } from '../server/jobs.mjs';
import { decide, describeFolders, folderRules, inFolders } from '../server/path-guard.mjs';
import { detectStack, loadProject, renderProjectDraft } from '../server/project.mjs';
import {
  composeSkillPack, describeRoleSkills, hashDir, installSkill, readLock, recordFileHashes, verifyLibrary, writeLock,
} from '../server/skills.mjs';
import { loadTeams } from '../server/teams.mjs';
import { REPO, removeDir, tmpDir } from './helpers.mjs';

const write = (root, rel, text = 'x') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

// ---------- folders: loại trừ và chế độ "scoped" ----------

test('folderRules/inFolders: loại trừ bằng "!", tiền tố theo thư mục, mục rác bị bỏ', () => {
  const list = ['src/app', '!src/app/api', ' ./src/lib/ ', '!', '/', '', 'src\\win'];
  assert.deepEqual(folderRules(list), { include: ['src/app', 'src/lib', 'src/win'], exclude: ['src/app/api'] });
  assert.equal(inFolders('src/app/page.tsx', list), true);
  assert.equal(inFolders('src/app/api/route.ts', list), false, 'nằm trong phần loại trừ');
  assert.equal(inFolders('src/app/api', list), false, 'chính thư mục loại trừ');
  assert.equal(inFolders('src/app/apis/x.ts', list), true, 'chỉ giống tiền tố chữ, khác thư mục');
  assert.equal(inFolders('src/library/x.ts', list), false, '"src/lib" không gồm "src/library"');
  assert.equal(inFolders('src/win/a.ts', list), true, 'dấu \\ trong hồ sơ được hiểu như /');
  assert.equal(inFolders('other/x', ['!secret']), true, 'chỉ có loại trừ = mọi nơi trừ phần đó');
  assert.equal(inFolders('secret/x', ['!secret']), false);
  assert.equal(describeFolders(list), 'src/app, src/lib, src/win, trừ src/app/api');
});

test('hook chặn file: loại trừ chặn đúng, và chế độ scoped với danh sách rỗng chặn MỌI lần ghi nhưng vẫn cho đọc', () => {
  const root = tmpDir();
  try {
    const ask = (file, allow, mode = 'worker', tool = 'Write') => decide({ toolName: tool, toolInput: { file_path: file }, root, allow, mode });
    const front = ['src/app', '!src/app/api'];
    assert.equal(ask('src/app/page.tsx', front).allowed, true);
    const blocked = ask('src/app/api/route.ts', front);
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason, /trừ src\/app\/api/);
    assert.equal(ask('README.md', ['!src/app/api']).allowed, true);

    for (const allow of [[], ['!docs/private'], ['', '/']]) {
      const r = ask('docs/security/report.md', allow, 'scoped');
      assert.equal(r.allowed, false, `scoped + ${JSON.stringify(allow)} phải chặn`);
      assert.match(r.reason, /chưa khai thư mục/);
    }
    assert.equal(ask('docs/security/report.md', [], 'scoped', 'Read').allowed, true, 'đọc vẫn được');
    assert.equal(ask('docs/security/a.md', ['docs/security'], 'scoped').allowed, true);
    assert.equal(ask('src/x.ts', ['docs/security'], 'scoped').allowed, false);
    assert.equal(ask('src/x.ts', [], 'worker').allowed, true, 'team viết code: rỗng = không giới hạn (giữ nguyên)');
    assert.equal(ask('.env', ['docs'], 'scoped', 'Read').allowed, false, '.env vẫn bị chặn');
  } finally {
    removeDir(root);
  }
});

test('hook chạy thật như tiến trình: COMPANY_GUARD_MODE=scoped với danh sách rỗng thoát mã 2', async () => {
  const root = tmpDir();
  try {
    const run = (mode, allow) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(REPO, 'server', 'path-guard.mjs')], {
        env: { ...process.env, COMPANY_GUARD_ROOT: root, COMPANY_GUARD_ALLOW: JSON.stringify(allow), COMPANY_GUARD_MODE: mode },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ code, err }));
      child.stdin.end(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(root, 'reports', 'a.md') } }));
    });
    assert.equal((await run('scoped', [])).code, 2);
    assert.equal((await run('scoped', ['reports'])).code, 0);
    assert.equal((await run('worker', [])).code, 0);
  } finally {
    removeDir(root);
  }
});

test('team tài liệu (design, security, report) khai requires_folders; team viết code thì không', () => {
  const teams = loadTeams({ teamsDir: path.join(REPO, 'teams') });
  const by = Object.fromEntries(teams.map((t) => [t.id, t.requiresFolders]));
  assert.deepEqual(
    { design: by.design, security: by.security, report: by.report, backend: by.backend, frontend: by.frontend, quality: by.quality, devops: by.devops },
    { design: true, security: true, report: true, backend: false, frontend: false, quality: false, devops: false },
  );
});

test('Trưởng nhóm chia việc: phạm vi rơi vào phần loại trừ bị từ chối; team tài liệu chưa khai thư mục thì không giao được gì', () => {
  const scope = (folders, team, files) => Jobs.prototype.checkScope.call({ r: { getProject: () => ({ folders }) } }, files, team);
  const front = { id: 'frontend', name: 'Team Frontend', requiresFolders: false };
  const sec = { id: 'security', name: 'Team Bảo mật', requiresFolders: true };
  assert.deepEqual(scope({ frontend: ['src/app', '!src/app/api'] }, front, ['src/app/page.tsx']), ['src/app/page.tsx']);
  assert.throws(() => scope({ frontend: ['src/app', '!src/app/api'] }, front, ['src/app/api/x.ts']), /nằm ngoài thư mục của Team Frontend \(src\/app, trừ src\/app\/api\)/);
  assert.deepEqual(scope({}, front, ['anything/x.ts']), ['anything/x.ts'], 'team code không khai = không giới hạn');
  assert.throws(() => scope({}, sec, ['docs/security/a.md']), /chưa khai thư mục cho Team Bảo mật/);
  assert.throws(() => scope({ security: ['!x'] }, sec, ['docs/security/a.md']), /chưa khai thư mục/, 'chỉ có loại trừ vẫn là chưa khai');
  assert.deepEqual(scope({ security: ['docs/security'] }, sec, ['docs/security/a.md']), ['docs/security/a.md']);
});

// ---------- hồ sơ dự án ----------

test('loadProject: khóa cũ "reports" được hiểu là "report" (không âm thầm mất giới hạn), khóa mới thắng nếu có cả hai', () => {
  const dir = tmpDir();
  try {
    const save = (folders) => fs.writeFileSync(path.join(dir, 'project.md'), `---\nname: x\nfolders:\n${folders}\n---\n`);
    save('  reports: [reports]');
    let p = loadProject(dir);
    assert.deepEqual(p.folders, { report: ['reports'] });
    assert.deepEqual(p.renamedKeys, [{ from: 'reports', to: 'report' }]);

    save('  reports: [old]\n  report: [new]');
    p = loadProject(dir);
    assert.deepEqual(p.folders, { report: ['new'] });

    save('  report: [reports]');
    assert.deepEqual(loadProject(dir).renamedKeys, []);
  } finally {
    removeDir(dir);
  }
});

test('loadProject: role_skills đọc đúng; kiểu sai (mảng, chuỗi) bị bỏ qua thay vì làm hỏng hồ sơ', () => {
  const dir = tmpDir();
  try {
    const save = (value) => fs.writeFileSync(path.join(dir, 'project.md'), `---\nname: x\n${value}\n---\n`);
    save('role_skills:\n  devops-engineer: [ponytail]\n  qa: ponytail');
    assert.deepEqual(loadProject(dir).roleSkills, { 'devops-engineer': ['ponytail'], qa: [] });
    save('role_skills: [ponytail]');
    assert.deepEqual(loadProject(dir).roleSkills, {});
    save('role_skills: ponytail');
    assert.deepEqual(loadProject(dir).roleSkills, {});
  } finally {
    removeDir(dir);
  }
});

test('init đoán lệnh: lấy test*/typecheck/verify/check*/lint*/build, bỏ script chạy mãi hoặc đụng dịch vụ thật', () => {
  const dir = tmpDir();
  try {
    const scripts = Object.fromEntries([
      'test', 'test:core', 'test:admin', 'test:watch', 'typecheck', 'verify', 'check:types', 'lint', 'lint:fix', 'build', 'build:prod',
      'dev', 'start', 'serve', 'cf:deploy', 'cf:secrets', 'db:seed', 'db:migrate', 'release', 'preview', 'postinstall', 'cf:typecheck', 'format',
    ].map((n) => [n, 'x']));
    write(dir, 'package.json', JSON.stringify({ scripts, dependencies: { '@aws-sdk/client-s3': '3' }, devDependencies: { wrangler: '4' } }));
    const { stack, commands, skipped } = detectStack(dir);
    assert.deepEqual(Object.keys(commands).sort(), ['build', 'check:types', 'install', 'lint', 'lint:fix', 'test', 'test:admin', 'test:core', 'typecheck', 'verify']);
    assert.equal(commands.test, 'npm test');
    assert.equal(commands['test:core'], 'npm run test:core');
    for (const bad of ['test:watch', 'build:prod', 'dev', 'start', 'serve', 'cf:deploy', 'cf:secrets', 'db:seed', 'db:migrate', 'release', 'preview']) {
      assert.ok(skipped.some((s) => s.name === bad), `${bad} phải bị bỏ`);
      assert.ok(!Object.keys(commands).includes(bad));
    }
    assert.ok(stack.includes('Cloudflare Workers'));
    assert.ok(stack.some((s) => s.startsWith('S3')));

    // Bản nháp phải là YAML hợp lệ dù khóa có dấu ":" (test:core), và đọc lại ra đúng lệnh được phép.
    write(dir, 'local/project.md', renderProjectDraft({ name: 'demo', stack, commands, skipped }));
    const front = fs.readFileSync(path.join(dir, 'local/project.md'), 'utf8').split('---')[1];
    assert.doesNotThrow(() => parseYaml(front));
    const project = loadProject(path.join(dir, 'local'));
    assert.equal(project.commands['test:core'], 'npm run test:core');
    assert.ok(project.allowedCommands.includes('npm run test:core'));
    assert.ok(!project.allowedCommands.includes('npm install'));
    assert.ok(!project.allowedCommands.some((c) => /deploy|dev|watch/.test(c)));
    assert.deepEqual(Object.keys(project.folders).sort(), ['backend', 'design', 'devops', 'frontend', 'quality', 'report', 'security'], 'mẫu dùng đúng id team, không còn reports/shared');
  } finally {
    removeDir(dir);
  }
});

test('init đoán trình quản lý gói theo file khóa (pnpm, yarn)', () => {
  const dir = tmpDir();
  try {
    write(dir, 'package.json', JSON.stringify({ scripts: { test: 'x', build: 'y' } }));
    write(dir, 'pnpm-lock.yaml', '');
    assert.deepEqual(detectStack(dir).commands, { install: 'pnpm install', build: 'pnpm run build', test: 'pnpm test' });
    fs.rmSync(path.join(dir, 'pnpm-lock.yaml'));
    write(dir, 'yarn.lock', '');
    assert.equal(detectStack(dir).commands.build, 'yarn run build');
  } finally {
    removeDir(dir);
  }
});

// ---------- doctor ----------

test('doctor: gốc ổ đĩa là lỗi; thư mục công cụ không tên .my-company mà tự lấy thư mục cha thì cảnh báo', () => {
  const driveRoot = path.parse(os.tmpdir()).root;
  const atRoot = checkProjectRoot({ projectRoot: driveRoot, toolDir: path.join(driveRoot, 'my-company'), projectRootSource: 'parent' });
  assert.equal(atRoot[0].level, 'fail');
  assert.match(atRoot[0].title, /gốc ổ đĩa/);

  const dir = tmpDir();
  try {
    write(dir, 'package.json', '{}');
    const parent = checkProjectRoot({ projectRoot: dir, toolDir: path.join(dir, 'my-company'), projectRootSource: 'parent' });
    assert.deepEqual(parent.map((c) => c.level), ['warn']);
    assert.match(parent[0].title, /không phải "\.my-company"/);
    assert.deepEqual(checkProjectRoot({ projectRoot: dir, toolDir: path.join(dir, '.my-company'), projectRootSource: 'parent' }), []);
    assert.deepEqual(checkProjectRoot({ projectRoot: dir, toolDir: path.join(dir, 'my-company'), projectRootSource: 'env' }), [], 'đã đặt rõ thì không nhắc');
    fs.rmSync(path.join(dir, 'package.json'));
    assert.match(checkProjectRoot({ projectRoot: dir, toolDir: path.join(dir, '.my-company'), projectRootSource: 'env' })[0].title, /không giống một dự án/);
  } finally {
    removeDir(dir);
  }
});

test('doctor: khóa folders lạ, khóa cũ, team tài liệu chưa khai, team code để rỗng đều được nêu tên', () => {
  const teams = loadTeams({ teamsDir: path.join(REPO, 'teams') });
  const checks = checkFolders({ folders: { report: ['reports'], shared: [], fronend: ['src'] }, renamedKeys: [{ from: 'reports', to: 'report' }] }, teams);
  const text = checks.map((c) => `${c.title} | ${c.detail}`).join('\n');
  assert.match(text, /khóa cũ folders\.reports/);
  assert.match(text, /không khớp team nào: shared, fronend/);
  assert.match(text, /KHÔNG ghi được file nào: design, security/);
  assert.doesNotMatch(text.split('\n').find((l) => l.includes('KHÔNG ghi được')), /report/, 'report đã khai');
  assert.match(text, /sửa được MỌI NƠI.*backend.*devops.*frontend.*quality/);
  const warnedTeams = checks.filter((c) => /KHÔNG ghi được|MỌI NƠI/.test(c.title)).map((c) => c.title).join('\n');
  assert.ok(!/management/.test(warnedTeams), 'team chỉ có Giám đốc (không ai ghi file) không bị nhắc');
});

// ---------- skill ----------

function makeSkill(root, name, files = {}) {
  const dir = path.join(root, name);
  write(dir, 'SKILL.md', `---\nname: ${name}\ndescription: thử\n---\n`);
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  return dir;
}

test('skills verify nêu đúng file thiếu, bị sửa, thừa (trường hợp clone thiếu thư mục data/)', () => {
  const dir = tmpDir();
  try {
    const library = path.join(dir, 'library');
    const lockFile = path.join(dir, 'skills.lock');
    const src = makeSkill(path.join(dir, 'src'), 'ui', { 'data/a.csv': '1', 'data/b.csv': '2', 'scripts/x.py': 'print(1)' });
    installSkill({ skillDir: src, libraryDir: library, lockFile, name: 'ui', meta: { source: 'a/b' } });
    assert.deepEqual(Object.keys(readLock(lockFile).skills.ui.files).sort(), ['SKILL.md', 'data/a.csv', 'data/b.csv', 'scripts/x.py']);
    assert.deepEqual(verifyLibrary({ libraryDir: library, lockFile }), [{ name: 'ui', ok: true, recorded: true }]);

    fs.rmSync(path.join(library, 'ui', 'data'), { recursive: true });
    fs.writeFileSync(path.join(library, 'ui', 'scripts', 'x.py'), 'print(2)');
    fs.writeFileSync(path.join(library, 'ui', 'extra.md'), 'lạ');
    const [v] = verifyLibrary({ libraryDir: library, lockFile });
    assert.equal(v.ok, false);
    assert.deepEqual(v.missing, ['data/a.csv', 'data/b.csv']);
    assert.deepEqual(v.changed, ['scripts/x.py']);
    assert.deepEqual(v.extra, ['extra.md']);
    assert.match(v.reason, /thiếu 2 file \(data\/a\.csv, data\/b\.csv\); bị sửa 1 file \(scripts\/x\.py\); thừa 1 file \(extra\.md\)/);

    // Chỉ đổi kiểu xuống dòng (clone trên Windows) thì không bị coi là sửa.
    fs.rmSync(path.join(library, 'ui'), { recursive: true });
    fs.cpSync(src, path.join(library, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(library, 'ui', 'SKILL.md'), fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8').replace(/\n/g, '\r\n'));
    assert.equal(verifyLibrary({ libraryDir: library, lockFile })[0].ok, true);
  } finally {
    removeDir(dir);
  }
});

test('recordFileHashes chỉ ghi cho skill còn nguyên vẹn; skill đã bị sửa không được "duyệt lại" âm thầm', () => {
  const dir = tmpDir();
  try {
    const library = path.join(dir, 'library');
    const lockFile = path.join(dir, 'skills.lock');
    makeSkill(library, 'good', { 'a.md': '1' });
    makeSkill(library, 'bad', { 'a.md': '1' });
    writeLock(lockFile, { version: 1, skills: { good: { sha256: hashDir(path.join(library, 'good')) }, bad: { sha256: hashDir(path.join(library, 'bad')) }, gone: { sha256: 'x' } } });
    fs.writeFileSync(path.join(library, 'bad', 'a.md'), 'đã sửa');

    const before = verifyLibrary({ libraryDir: library, lockFile }).find((v) => v.name === 'bad');
    assert.match(before.reason, /chưa có danh sách từng file/);
    assert.deepEqual(recordFileHashes({ libraryDir: library, lockFile }), ['good']);
    const lock = readLock(lockFile);
    assert.ok(lock.skills.good.files);
    assert.equal(lock.skills.bad.files, undefined);
    assert.equal(lock.skills.gone.files, undefined);
    assert.deepEqual(recordFileHashes({ libraryDir: library, lockFile }), [], 'chạy lại không đổi gì');
  } finally {
    removeDir(dir);
  }
});

test('skills.lock của repo đã có danh sách từng file cho mọi skill, và mọi file thư viện đều không bị .gitignore bỏ qua', () => {
  const verdicts = verifyLibrary({ libraryDir: path.join(REPO, 'skills', 'library'), lockFile: path.join(REPO, 'skills.lock') });
  assert.ok(verdicts.length > 0);
  for (const v of verdicts) assert.deepEqual({ name: v.name, ok: v.ok, recorded: v.recorded }, { name: v.name, ok: true, recorded: true });
  const ignore = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(!ignore.includes('data/') && !ignore.includes('local/'), 'data/ và local/ phải neo ở gốc (/data/, /local/), nếu không skills/library/*/data/ bị bỏ khi clone');
});

test('role_skills cộng thêm skill cho đúng vai trò, không đụng vai trò khác; thi đấu skill vẫn loại được nó', () => {
  const dir = tmpDir();
  try {
    const library = path.join(dir, 'library');
    const lockFile = path.join(dir, 'skills.lock');
    for (const n of ['base', 'extra']) {
      makeSkill(library, n);
    }
    writeLock(lockFile, { version: 1, skills: Object.fromEntries(['base', 'extra'].map((n) => [n, { sha256: hashDir(path.join(library, n)) }])) });
    const role = { id: 'qa', skills: ['base'], stack_skills: {} };
    const other = { id: 'designer', skills: ['base'], stack_skills: {} };
    const project = { stack: [], roleSkills: { qa: ['extra', 'missing'] } };
    const pack = (r, extra = {}) => composeSkillPack({ libraryDir: library, lockFile, role: r, project, outDir: path.join(dir, `out-${r.id}`), ...extra });

    const qa = pack(role);
    assert.deepEqual(qa.loaded, ['base', 'extra']);
    assert.deepEqual(qa.skipped.map((s) => s.name), ['missing']);
    assert.deepEqual(pack(other).loaded, ['base']);
    assert.deepEqual(pack(role, { excludeSkills: ['extra'] }).loaded, ['base']);
  } finally {
    removeDir(dir);
  }
});

test('skills roles / doctor: devops-engineer nạp ponytail; skill khai mà bị bỏ và role_skills gõ nhầm đều được cảnh báo', () => {
  const teams = loadTeams({ teamsDir: path.join(REPO, 'teams') });
  const libraryDir = path.join(REPO, 'skills', 'library');
  const lockFile = path.join(REPO, 'skills.lock');
  const { rows } = describeRoleSkills({ teams, project: { stack: [] }, libraryDir, lockFile });
  assert.ok(rows.find((r) => r.role === 'devops-engineer').loaded.includes('ponytail'));
  assert.ok(!rows.find((r) => r.role === 'qa').loaded.includes('ponytail'), 'QA không nạp ponytail mặc định');
  assert.deepEqual(checkRoleSkills({ teams, project: { stack: [] }, libraryDir, lockFile }), []);

  const warned = checkRoleSkills({ teams, project: { stack: [], roleSkills: { qa: ['khong-co'], 'devop-engineer': ['ponytail'] } }, libraryDir, lockFile });
  const text = warned.map((c) => `${c.title} | ${c.detail}`).join('\n');
  assert.match(text, /quality\/qa: khong-co \(chưa được duyệt/);
  assert.match(text, /vai trò không tồn tại: devop-engineer/);
});
