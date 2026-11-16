import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { decide, decideBash, splitCommand } from '../server/path-guard.mjs';
import { buildGuardSettings } from '../server/runner.mjs';
import { REPO, removeDir, tmpDir } from './helpers.mjs';

function setupRoot() {
  const root = tmpDir();
  for (const dir of ['src/server', 'src/app', 'prisma', 'docs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  return root;
}

const allow = ['src/server', 'prisma'];
const ask = (root, toolName, file, extra = {}) => decide({ toolName, toolInput: { file_path: file }, root, allow, mode: 'worker', ...extra });

test('nhân viên sửa được trong thư mục của team và bị chặn ngoài đó', () => {
  const root = setupRoot();
  try {
    assert.equal(ask(root, 'Edit', 'src/server/api.js').allowed, true);
    assert.equal(ask(root, 'Write', path.join(root, 'src', 'server', 'moi', 'sâu', 'file.js')).allowed, true, 'đường dẫn tuyệt đối và thư mục chưa có');
    assert.equal(ask(root, 'Write', 'prisma/schema.prisma').allowed, true);

    const outside = ask(root, 'Edit', 'src/app/page.tsx');
    assert.equal(outside.allowed, false);
    assert.match(outside.reason, /Ngoài thư mục được phép sửa của team \(src\/server, prisma\)/);
    assert.equal(ask(root, 'MultiEdit', 'docs/readme.md').allowed, false);
    assert.equal(ask(root, 'NotebookEdit', 'docs/a.ipynb').allowed, false);
    assert.equal(ask(root, 'Edit', 'src/serverless/x.js').allowed, false, 'chỉ giống tiền tố tên thư mục thì vẫn bị chặn');
    assert.equal(ask(root, 'Edit', 'src/server/../app/page.tsx').allowed, false, 'đi vòng bằng ../ vẫn bị chặn');
    assert.equal(ask(root, 'Edit', 'package.json').allowed, false, 'file ở gốc dự án cũng ngoài phạm vi');
    // Đọc thì được ở mọi nơi trong worktree.
    assert.equal(ask(root, 'Read', 'src/app/page.tsx').allowed, true);
  } finally {
    removeDir(root);
  }
});

test('không khai thư mục thì sửa được mọi nơi trong worktree, nhưng không bao giờ ra ngoài', () => {
  const root = setupRoot();
  try {
    assert.equal(ask(root, 'Edit', 'docs/x.md', { allow: [] }).allowed, true);
    const out = ask(root, 'Edit', path.join(root, '..', 'ngoai.txt'), { allow: [] });
    assert.equal(out.allowed, false);
    assert.match(out.reason, /ngoài thư mục làm việc/);
    assert.equal(ask(root, 'Read', '../ngoai.txt', { allow: [] }).allowed, false, 'đọc ngoài worktree cũng bị chặn');
    assert.equal(ask(root, 'Read', process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd').allowed, false);
  } finally {
    removeDir(root);
  }
});

test('file bí mật và thư mục .git không đọc, không sửa được', () => {
  const root = setupRoot();
  try {
    for (const tool of ['Read', 'Edit', 'Write']) {
      assert.equal(ask(root, tool, '.env', { allow: [] }).allowed, false, `${tool} .env`);
      assert.equal(ask(root, tool, 'src/server/.env.local', { allow: [] }).allowed, false, `${tool} .env.local`);
      assert.equal(ask(root, tool, '.git/config', { allow: [] }).allowed, false, `${tool} .git`);
    }
    assert.equal(ask(root, 'Read', '.env.example', { allow: [] }).allowed, true, 'file mẫu thì được');
    assert.equal(ask(root, 'Read', 'src/environment.ts', { allow: [] }).allowed, true, 'chỉ tên giống .env thì không sao');
  } finally {
    removeDir(root);
  }
});

test('chế độ chỉ đọc (Trưởng nhóm): đọc được, sửa gì cũng bị chặn', () => {
  const root = setupRoot();
  try {
    const opts = { allow: [], mode: 'readonly' };
    assert.equal(ask(root, 'Read', 'src/app/page.tsx', opts).allowed, true);
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      const r = ask(root, tool, 'src/server/a.js', opts);
      assert.equal(r.allowed, false, tool);
      assert.match(r.reason, /chỉ được đọc/);
    }
    assert.equal(decide({ toolName: 'Bash', toolInput: { command: 'ls' }, root, mode: 'readonly' }).allowed, true, 'công cụ không có đường dẫn thì để quyền khác lo');
  } finally {
    removeDir(root);
  }
});

test('thư mục nối từ dự án (node_modules): khai links thì chỉ ĐỌC được trong đó, sửa bị chặn; không khai thì chặn như ra ngoài', () => {
  const base = tmpDir();
  try {
    // Đích thật nằm NGOÀI worktree, như node_modules của dự án được nối (junction) vào worktree.
    const deps = path.join(base, 'du-an', 'node_modules');
    fs.mkdirSync(path.join(deps, 'next', 'dist', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(deps, 'next', 'dist', 'docs', 'route.md'), '# route\n');
    fs.writeFileSync(path.join(deps, '.env'), 'SECRET=1\n');
    const root = path.join(base, 'wt');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.symlinkSync(deps, path.join(root, 'node_modules'), 'junction');

    const viaLink = path.join(root, 'node_modules', 'next', 'dist', 'docs', 'route.md');
    const viaReal = path.join(deps, 'next', 'dist', 'docs', 'route.md');
    const blocked = ask(root, 'Read', viaLink, { allow: [] });
    assert.equal(blocked.allowed, false, 'chưa khai links: realpath ra ngoài worktree nên bị chặn (lỗi web96 đã tái hiện)');
    assert.match(blocked.reason, /ngoài thư mục làm việc/);

    const links = ['node_modules'];
    assert.equal(ask(root, 'Read', viaLink, { allow: [], links }).allowed, true, 'đọc qua liên kết');
    assert.equal(ask(root, 'Read', 'node_modules/next/dist/docs/route.md', { allow: [], links }).allowed, true, 'đường dẫn tương đối');
    assert.equal(ask(root, 'Read', viaReal, { allow: [], links }).allowed, true, 'đọc bằng đường dẫn thật (Glob/ls trả về đường dẫn này)');
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      const r = ask(root, tool, viaLink, { allow: [], links });
      assert.equal(r.allowed, false, `${tool} trong thư mục nối`);
      assert.match(r.reason, /được nối từ dự án để đọc, không được sửa/);
      assert.equal(ask(root, tool, viaReal, { allow: [], links }).allowed, false, `${tool} bằng đường dẫn thật`);
    }
    assert.equal(ask(root, 'Read', path.join(root, 'node_modules', '.env'), { allow: [], links }).allowed, false, 'file bí mật trong thư mục nối vẫn bị chặn');
    assert.equal(ask(root, 'Read', path.join(base, 'du-an', 'khac.txt'), { allow: [], links }).allowed, false, 'ngoài thư mục nối (chỗ khác của dự án thật) vẫn bị chặn');
    assert.equal(ask(root, 'Read', path.join(base, 'du-an', 'node_modules_khac', 'x'), { allow: [], links }).allowed, false, 'chỉ giống tiền tố tên thì không tính');
    assert.equal(ask(root, 'Edit', 'src/a.js', { allow: [], links: ['src'] }).allowed, true, 'thư mục thật trong worktree khai nhầm vào links thì theo luật thường');
    assert.equal(ask(root, 'Read', viaLink, { allow: [], links: ['../du-an'] }).allowed, false, 'mục links đi ra ngoài bị bỏ qua');
  } finally {
    removeDir(base);
  }
});

function runHook(env, event) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, 'server', 'path-guard.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('close', (code) => resolve({ code, stderr, stdout }));
    child.stdin.end(typeof event === 'string' ? event : JSON.stringify(event));
  });
}

test('hook chạy như Claude Code gọi: mã thoát 0 khi cho phép, 2 kèm lý do khi chặn, và chặn khi dữ liệu hỏng', async () => {
  const root = setupRoot();
  try {
    const env = { COMPANY_GUARD_ROOT: root, COMPANY_GUARD_ALLOW: JSON.stringify(allow), COMPANY_GUARD_MODE: 'worker' };
    const okRun = await runHook(env, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src', 'server', 'a.js') } });
    assert.equal(okRun.code, 0);
    const bad = await runHook(env, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(root, 'docs', 'a.md') } });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /Ngoài thư mục được phép sửa/);
    const garbage = await runHook(env, 'không phải JSON');
    assert.equal(garbage.code, 2, 'không đọc được sự kiện thì chặn cho chắc');
    const brokenConfig = await runHook({ ...env, COMPANY_GUARD_ALLOW: '{hỏng' }, { tool_name: 'Edit', tool_input: { file_path: 'a' } });
    assert.equal(brokenConfig.code, 2);

    // Thư mục nối từ dự án qua biến COMPANY_GUARD_LINKS: đọc được, sửa thì không.
    const deps = path.join(root, '..', `${path.basename(root)}-deps`);
    fs.mkdirSync(path.join(deps, 'goi'), { recursive: true });
    fs.writeFileSync(path.join(deps, 'goi', 'index.js'), '1\n');
    fs.symlinkSync(deps, path.join(root, 'node_modules'), 'junction');
    try {
      const file = path.join(root, 'node_modules', 'goi', 'index.js');
      const linked = { ...env, COMPANY_GUARD_LINKS: JSON.stringify(['node_modules']) };
      assert.equal((await runHook(env, { tool_name: 'Read', tool_input: { file_path: file } })).code, 2, 'chưa khai links thì chặn');
      assert.equal((await runHook(linked, { tool_name: 'Read', tool_input: { file_path: file } })).code, 0);
      const write = await runHook(linked, { tool_name: 'Write', tool_input: { file_path: file } });
      assert.equal(write.code, 2);
      assert.match(write.stderr, /không được sửa/);
      assert.equal((await runHook({ ...env, COMPANY_GUARD_LINKS: '[hỏng' }, { tool_name: 'Read', tool_input: { file_path: 'a' } })).code, 2);
    } finally {
      fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
      removeDir(deps);
    }
  } finally {
    removeDir(root);
  }
});

test('buildGuardSettings tạo cấu hình hook dùng đường dẫn có dấu gạch xuôi', () => {
  const settings = buildGuardSettings('D:\\my-company\\server\\path-guard.mjs');
  const hook = settings.hooks.PreToolUse[0];
  assert.match(hook.matcher, /Edit.*Write.*Read.*Bash/);
  assert.equal(hook.hooks[0].type, 'command');
  assert.equal(hook.hooks[0].command, 'node "D:/my-company/server/path-guard.mjs"');
});

test('thư mục nháp .company-tmp: nhân viên ghi được dù ngoài thư mục của team hay team không có thư mục; Trưởng nhóm thì không', () => {
  const root = setupRoot();
  try {
    assert.equal(ask(root, 'Write', '.company-tmp/thu.mjs').allowed, true);
    assert.equal(ask(root, 'Edit', path.join(root, '.company-tmp', 'sau', 'a.txt')).allowed, true);
    assert.equal(ask(root, 'Write', '.company-tmp/x', { allow: [], mode: 'scoped' }).allowed, true, 'team chỉ ghi tài liệu vẫn có chỗ nháp');
    assert.equal(ask(root, 'Write', '.company-tmp/x', { mode: 'readonly' }).allowed, false);
    assert.equal(ask(root, 'Write', '.company-tmp').allowed, false, 'chính thư mục nháp không phải file để ghi');
    assert.equal(ask(root, 'Write', '.company-tmp-khac/a').allowed, false, 'tên gần giống không được tính');
    assert.equal(ask(root, 'Read', '.company-tmp/x', { mode: 'readonly' }).allowed, true);
  } finally {
    removeDir(root);
  }
});

test('splitCommand tách lệnh ghép, giữ chuỗi trong ngoặc, bỏ cuộc khi có cú pháp lạ', () => {
  assert.deepEqual(splitCommand('npm run test && git status'), ['npm run test', 'git status']);
  assert.deepEqual(splitCommand('a | b; c || d\ne'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitCommand('node x.mjs "a && b" \'c;d\''), ['node x.mjs "a && b" \'c;d\'']);
  for (const bad of ['echo $(x)', 'echo `x`', '(cd a && b)', 'a && ', 'echo "mở', 'x; ', 'echo $HOME', '{ a; }']) assert.equal(splitCommand(bad), null, bad);
});

test('decideBash: cho phép lệnh ghép khi mọi phần đều được phép, rm và node trong thư mục làm việc; chặn khi đụng ra ngoài; không ý kiến khi không chắc', () => {
  const root = setupRoot();
  try {
    const bash = (command, extra = {}) => decideBash({ command, root, allow, mode: 'worker', commands: ['npm run test', 'git status'], ...extra });
    const allowedVerdict = (c, extra) => assert.equal(bash(c, extra).decision, 'allow', c);
    const silent = (c, extra) => assert.deepEqual(bash(c, extra), { allowed: true }, c);
    const denied = (c, re, extra) => {
      const v = bash(c, extra);
      assert.equal(v.allowed, false, c);
      assert.match(v.reason, re);
    };

    allowedVerdict('npm run test');
    allowedVerdict('npm run test -- --grep x && git status');
    allowedVerdict('npm  run   test');
    silent('npm run test:core', 'tiền tố khác thì không phải lệnh đã khai');
    silent('npm run test && ls');
    silent('ls');
    silent('npm run test | tail -5');
    silent('echo $(rm -rf /)', 'có thay thế lệnh thì không đoán');
    silent('git status;');

    allowedVerdict('rm -rf src/server/tmp.js');
    allowedVerdict('rm .company-tmp/a.txt .company-tmp/b.txt');
    allowedVerdict('rm -r src/server/*.log');
    denied('rm -rf src/app/page.tsx', /Lệnh rm chỉ được xóa trong thư mục làm việc[\s\S]*Ngoài thư mục được phép sửa của team/);
    denied('rm -rf ../khac', /ngoài thư mục làm việc/);
    denied('rm -rf .git', /\.git/);
    denied('rm -rf *', /không xóa bằng mẫu ở gốc/);
    denied('rm -rf .', /không được xóa cả thư mục làm việc/);
    denied(`rm -rf ${root}`, /không được xóa cả thư mục làm việc/);
    denied('rm -rf ~/x', /đường dẫn không rõ/);
    denied('npm run test && rm -rf /', /ngoài thư mục làm việc/);
    silent('rm -rf');

    allowedVerdict('node .company-tmp/thu.mjs');
    allowedVerdict('node --test src/server/*.test.mjs');
    allowedVerdict('node src/server/a.mjs --port 3000 > .company-tmp/out.txt 2>&1');
    allowedVerdict('node src/server/a.mjs > /dev/null');
    silent('node -e "process.exit()"');
    silent('node --eval x');
    silent('node -r ./x.js');
    silent('node');
    silent('node src/server/a.mjs > src/app/ra.txt', 'ghi ra ngoài thư mục được phép thì để Claude Code quyết');
    denied('node ../x.js', /ngoài thư mục làm việc/);
    denied('node .git/hooks/pre-commit', /\.git/);

    // Trưởng nhóm (chỉ đọc): hook không mở rộng gì.
    silent('rm -rf src/server/a.js', { mode: 'readonly' });
    silent('npm run test', { mode: 'readonly' });
    // Không khai lệnh nào: chỉ còn rm và node.
    silent('npm run test', { commands: [] });
    allowedVerdict('rm src/server/a.js', { commands: [] });
    // Thư mục nối từ dự án (node_modules): chạy file trong đó được, xóa thì không (xóa qua liên kết là xóa dự án thật).
    const deps = path.join(root, '..', `${path.basename(root)}-deps`);
    fs.mkdirSync(path.join(deps, 'goi'), { recursive: true });
    fs.writeFileSync(path.join(deps, 'goi', 'index.js'), '1\n');
    fs.symlinkSync(deps, path.join(root, 'node_modules'), 'junction');
    try {
      allowedVerdict('node node_modules/goi/index.js', { links: ['node_modules'] });
      denied('rm -rf node_modules/goi', /không được sửa/, { links: ['node_modules'] });
      denied('rm -rf node_modules', /không được sửa|ngoài thư mục làm việc/, { links: ['node_modules'] });
    } finally {
      fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
      removeDir(deps);
    }
  } finally {
    removeDir(root);
  }
});

test('hook với Bash: in JSON cho phép khi chắc, im lặng khi không ý kiến, mã 2 kèm lý do khi chặn', async () => {
  const root = setupRoot();
  try {
    const env = { COMPANY_GUARD_ROOT: root, COMPANY_GUARD_ALLOW: JSON.stringify(allow), COMPANY_GUARD_MODE: 'worker', COMPANY_GUARD_COMMANDS: JSON.stringify(['npm run test']) };
    const bash = (command, extra = {}) => runHook({ ...env, ...extra }, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
    const ok = await bash('npm run test && rm -rf src/server/tmp');
    assert.equal(ok.code, 0);
    assert.deepEqual(JSON.parse(ok.stdout).hookSpecificOutput.permissionDecision, 'allow');
    const quiet = await bash('ls -la');
    assert.equal(quiet.code, 0);
    assert.equal(quiet.stdout.trim(), '', 'không ý kiến thì không in gì, Claude Code tự quyết');
    const bad = await bash('rm -rf ../du-an-that');
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /Lệnh rm chỉ được xóa trong thư mục làm việc/);
    assert.equal((await bash('npm run test', { COMPANY_GUARD_COMMANDS: '[hỏng' })).code, 2);
    assert.equal((await runHook(env, { tool_name: 'Bash', tool_input: {} })).code, 0, 'không có lệnh thì không chặn');
  } finally {
    removeDir(root);
  }
});
