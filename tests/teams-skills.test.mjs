import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseFrontmatter } from '../server/frontmatter.mjs';
import { detectStack, loadProject, renderProjectDraft } from '../server/project.mjs';
import {
  composeSkillPack, hashDir, inspectSkillDir, installSkill, parseSource, readLock, verifyLibrary,
} from '../server/skills.mjs';
import { findMember, loadTeams, workersOf } from '../server/teams.mjs';
import { REPO, removeDir, tmpDir } from './helpers.mjs';

test('parseFrontmatter tách YAML và nội dung, chịu được CRLF', () => {
  const { data, body } = parseFrontmatter('---\r\ntitle: A\r\nlist: [1, 2]\r\n---\r\nXin chào\r\n');
  assert.equal(data.title, 'A');
  assert.deepEqual(data.list, [1, 2]);
  assert.equal(body, 'Xin chào');
  assert.deepEqual(parseFrontmatter('không có frontmatter').data, {});
});

test('loadTeams đọc đội hình thật của repo', () => {
  const teams = loadTeams({ teamsDir: path.join(REPO, 'teams') });
  const backend = teams.find((t) => t.id === 'backend');
  assert.ok(backend, 'có team backend');
  assert.deepEqual(backend.members.map((m) => m.name), ['Minh', 'An', 'Bình', 'Hương', 'Khang', 'Nam']);
  assert.equal(backend.lead, 'Minh');
  assert.deepEqual(workersOf(backend).map((m) => m.name), ['An', 'Bình', 'Hương', 'Khang', 'Nam'], 'Trưởng nhóm không tính là nhân viên làm việc');
  const lead = findMember(teams, 'minh');
  assert.equal(lead.isLead, true);
  assert.deepEqual([lead.role.model, lead.role.review_model], ['opus', 'sonnet']);
  assert.equal(backend.limits.max_revisions, 2);
  const found = findMember(teams, 'bình');
  assert.equal(found.isLead, false);
  assert.equal(found.role.id, 'backend-dev');
  assert.equal(found.role.model, 'sonnet');
  assert.ok(found.role.tools.includes('Bash'));
  assert.equal(findMember(teams, 'không có'), null);
});

test('loadTeams báo lỗi rõ khi thành viên dùng vai trò không tồn tại', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'x'));
    fs.writeFileSync(path.join(dir, 'x', 'team.md'), '---\nname: X\nmembers:\n  - { name: A, role: ghost }\n---\n');
    assert.throws(() => loadTeams({ teamsDir: dir }), /ghost/);
  } finally {
    removeDir(dir);
  }
});

test('loadTeams báo lỗi khi Trưởng nhóm không có trong danh sách thành viên', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'x'));
    fs.writeFileSync(path.join(dir, 'x', 'team.md'), '---\nname: X\nlead: Ghost\nmembers:\n  - { name: A, role: dev }\n---\n');
    fs.writeFileSync(path.join(dir, 'x', 'dev.md'), '---\ntitle: Dev\n---\nXin chào\n');
    assert.throws(() => loadTeams({ teamsDir: dir }), /Ghost/);
  } finally {
    removeDir(dir);
  }
});

test('loadTeams từ chối vai trò khai model fable (người dùng không muốn dùng)', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'x'));
    fs.writeFileSync(path.join(dir, 'x', 'team.md'), '---\nname: X\nmembers:\n  - { name: A, role: dev }\n---\n');
    fs.writeFileSync(path.join(dir, 'x', 'dev.md'), '---\ntitle: Dev\nmodel: claude-fable-5-1\n---\nXin chào\n');
    assert.throws(() => loadTeams({ teamsDir: dir }), /bị cấm dùng/);
    fs.writeFileSync(path.join(dir, 'x', 'dev.md'), '---\ntitle: Dev\nmodel: opus\n---\nXin chào\n');
    assert.equal(loadTeams({ teamsDir: dir })[0].roles.dev.model, 'opus');
  } finally {
    removeDir(dir);
  }
});

test('loadProject đọc hồ sơ và detectStack nhận ra công nghệ', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { next: '1', '@supabase/supabase-js': '2' }, devDependencies: { typescript: '5' }, scripts: { test: 'x', lint: 'y' } }),
    );
    const { stack, commands } = detectStack(dir);
    assert.deepEqual(stack, ['Next.js', 'TypeScript', 'Supabase']);
    assert.equal(commands.test, 'npm test');
    assert.equal(commands.lint, 'npm run lint');

    fs.writeFileSync(path.join(dir, 'project.md'), renderProjectDraft({ name: 'demo', stack, commands }));
    const project = loadProject(dir);
    assert.equal(project.name, 'demo');
    assert.deepEqual(project.stack, stack);
    assert.ok(project.allowedCommands.includes('npm test'));
    assert.equal(loadProject(path.join(dir, 'nowhere')), null);
  } finally {
    removeDir(dir);
  }
});

test('parseSource hiểu owner/repo/đường-dẫn và URL GitHub', () => {
  assert.deepEqual(parseSource('obra/superpowers/skills/tdd'), { owner: 'obra', repo: 'superpowers', ref: null, subpath: 'skills/tdd' });
  assert.deepEqual(parseSource('https://github.com/a/b/tree/main/x/y'), { owner: 'a', repo: 'b', ref: 'main', subpath: 'x/y' });
  assert.throws(() => parseSource('khong hop le'));
});

function makeSkill(dir, name, extra = {}) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: thử\n---\nNội dung ${name}\n`);
  for (const [file, content] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(skillDir, file)), { recursive: true });
    fs.writeFileSync(path.join(skillDir, file), content);
  }
  return skillDir;
}

test('skill chỉ được nạp khi đã duyệt và còn nguyên vẹn', () => {
  const dir = tmpDir();
  try {
    const source = path.join(dir, 'source');
    const library = path.join(dir, 'library');
    const lockFile = path.join(dir, 'skills.lock');
    const good = makeSkill(source, 'good');
    const risky = makeSkill(source, 'risky', { 'scripts/run.py': 'print(1)', 'hooks/hooks.json': '{}' });

    const review = inspectSkillDir(risky);
    assert.deepEqual(review.risky.map((f) => f.rel).sort(), ['hooks/hooks.json', 'scripts/run.py']);

    installSkill({ skillDir: good, libraryDir: library, lockFile, name: 'good', meta: { source: 'a/b', commit: 'abc', license: 'MIT' } });
    assert.equal(readLock(lockFile).skills.good.sha256, hashDir(path.join(library, 'good')));
    makeSkill(library, 'unlocked'); // có trong thư viện nhưng chưa duyệt

    const role = { id: 'r', skills: ['good', 'unlocked', 'missing'], stack_skills: { node: ['good'], rust: ['unlocked'] } };
    const pack = composeSkillPack({ libraryDir: library, lockFile, role, project: { stack: ['Node.js'] }, outDir: path.join(dir, 'pack') });
    assert.deepEqual(pack.loaded, ['good']);
    assert.deepEqual(pack.skipped.map((s) => s.name).sort(), ['missing', 'unlocked']);
    assert.ok(fs.existsSync(path.join(pack.dir, 'skills', 'good', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(pack.dir, '.claude-plugin', 'plugin.json')));

    // Sửa skill sau khi duyệt thì bị từ chối và verify báo lỗi.
    fs.appendFileSync(path.join(library, 'good', 'SKILL.md'), '\nchèn thêm chỉ dẫn lạ\n');
    const tampered = composeSkillPack({ libraryDir: library, lockFile, role, project: { stack: [] }, outDir: path.join(dir, 'pack2') });
    assert.equal(tampered.dir, null);
    assert.match(tampered.skipped.find((s) => s.name === 'good').reason, /khác với lúc duyệt/);
    assert.equal(verifyLibrary({ libraryDir: library, lockFile }).find((v) => v.name === 'good').ok, false);
  } finally {
    removeDir(dir);
  }
});

test('skill thiết kế và nén ngữ cảnh gán đúng vai trò theo công nghệ; skill điều khiển máy chỉ QA nạp', () => {
  const teams = loadTeams({ teamsDir: path.join(REPO, 'teams') });
  const lockFile = path.join(REPO, 'skills.lock');
  const libraryDir = path.join(REPO, 'skills', 'library');
  const dir = tmpDir();
  try {
    const roleOf = (member) => findMember(teams, member).role;
    const loadedFor = (member, stack) => composeSkillPack({ libraryDir, lockFile, role: roleOf(member), project: { stack }, outDir: path.join(dir, `${member}-${stack.join('_')}`) });

    // Frontend: luôn có impeccable; dự án React/Next có thêm react-best-practices và composition-patterns.
    const plain = loadedFor('Cúc', ['React']);
    assert.ok(plain.loaded.includes('impeccable'));
    assert.ok(plain.loaded.includes('react-best-practices') && plain.loaded.includes('composition-patterns'));
    assert.deepEqual(plain.skipped, [], 'mọi skill được gán đều đã duyệt và còn nguyên vẹn');
    // redesign-existing-projects trùng với impeccable nên đã gỡ. design-taste-frontend được giữ lại trong thư viện (đã duyệt)
    // để đem ra thi đấu với impeccable, nhưng KHÔNG nạp mặc định cho ai.
    assert.equal(fs.existsSync(path.join(libraryDir, 'redesign-existing-projects')), false);
    assert.equal(readLock(lockFile).skills['redesign-existing-projects'], undefined);
    assert.ok(readLock(lockFile).skills['design-taste-frontend'], 'design-taste-frontend phải còn trong skills.lock');
    assert.equal(plain.loaded.includes('design-taste-frontend'), false, 'không nạp mặc định');

    // impeccable được cài bản không có scripts/ (chương trình tự tải về, hook, trình duyệt trực tiếp).
    const impeccable = path.join(libraryDir, 'impeccable');
    assert.equal(fs.existsSync(path.join(impeccable, 'scripts')), false);
    assert.equal(readLock(lockFile).skills.impeccable.excluded.includes('scripts'), true);
    assert.ok(fs.existsSync(path.join(impeccable, 'reference', 'craft-floor.md')));

    // Backend: headroom chỉ nạp khi dự án có tính năng gọi LLM.
    assert.equal(loadedFor('An', ['Node.js']).loaded.includes('headroom'), false);
    assert.ok(loadedFor('An', ['Node.js', 'LLM app']).loaded.includes('headroom'));

    // Theo quyết định của chủ công ty: QA nạp cả webapp-testing và hai skill agent-desktop; các vai trò khác thì không.
    const qaSkills = loadedFor('Quân', ['React']);
    for (const n of ['webapp-testing', 'agent-desktop', 'agent-desktop-windows']) assert.ok(qaSkills.loaded.includes(n), `QA phải nạp ${n}`);
    assert.deepEqual(qaSkills.skipped, [], 'mọi skill của QA đã duyệt và còn nguyên vẹn');
    for (const member of ['An', 'Cúc', 'Minh', 'Hòa']) {
      const loaded = loadedFor(member, ['React', 'Tailwind CSS', 'LLM app', 'Supabase']).loaded;
      assert.equal(loaded.some((n) => n.startsWith('agent-desktop') || n === 'webapp-testing'), false, `${member} không được nạp skill điều khiển máy`);
    }
    const lock = readLock(lockFile);
    assert.ok(lock.skills['agent-desktop'] && lock.skills['agent-desktop-windows'], 'đã duyệt vào skills.lock');
    assert.deepEqual(verifyLibrary({ libraryDir, lockFile }).filter((e) => !e.ok), [], 'toàn bộ thư viện còn nguyên vẹn');
  } finally {
    removeDir(dir);
  }
});

test('detectStack nhận ra Tailwind CSS từ package.json', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { tailwindcss: '^4.0.0', react: '^19.0.0' } }));
    assert.ok(detectStack(dir).stack.includes('Tailwind CSS'));
  } finally {
    removeDir(dir);
  }
});

test('team DevOps, Thiết kế, Bảo mật và Báo cáo: mỗi team có Trưởng nhóm, nhân viên, mô tả; mọi skill đã duyệt và nạp được', () => {
  const teams = loadTeams({ teamsDir: path.join(REPO, 'teams') });
  const lockFile = path.join(REPO, 'skills.lock');
  const libraryDir = path.join(REPO, 'skills', 'library');
  const expected = {
    devops: { lead: 'Khôi', workers: ['Sơn', 'Đạt', 'Tâm', 'Nhi'], role: 'devops-engineer' },
    design: { lead: 'Ngọc', workers: ['Vy', 'Linh', 'Hà', 'Tiên'], role: 'designer' },
    security: { lead: 'Hải', workers: ['Trinh', 'Khoa', 'Hùng', 'Thu'], role: 'security-reviewer' },
    report: { lead: 'Thảo', workers: ['Mai', 'Lộc', 'Quỳnh'], role: 'reporter' },
  };
  const dir = tmpDir();
  try {
    for (const [id, want] of Object.entries(expected)) {
      const team = teams.find((t) => t.id === id);
      assert.ok(team, `có team ${id}`);
      assert.equal(team.lead, want.lead);
      assert.deepEqual(workersOf(team).map((m) => [m.name, m.role]), want.workers.map((name) => [name, want.role]));
      assert.ok(team.description.length > 80, `team ${id} có mô tả để Giám đốc biết khi nào giao việc`);
      for (const role of Object.values(team.roles)) {
        assert.notEqual(role.model, 'fable');
        const pack = composeSkillPack({ libraryDir, lockFile, role, project: { stack: [] }, outDir: path.join(dir, `${id}-${role.id}`) });
        assert.deepEqual(pack.skipped, [], `${id}/${role.id}: mọi skill được gán đều đã duyệt và còn nguyên vẹn`);
      }
    }

    // Người rà soát bảo mật dùng skill rà soát thay đổi (đã đọc và duyệt) cùng sharp-edges; không có công cụ sửa code.
    const reviewer = findMember(teams, 'Trinh').role;
    assert.deepEqual(reviewer.skills, ['differential-review', 'sharp-edges', 'verification-before-completion']);
    assert.equal(reviewer.tools.includes('Edit'), false, 'người rà soát chỉ ghi báo cáo (Write), không sửa tệp có sẵn');
    // Nhà thiết kế không có Bash: skill ui-ux-pro-max chạy script Python nên chỉ dùng phần nguyên tắc.
    const designer = findMember(teams, 'Vy').role;
    assert.equal(designer.tools.includes('Bash'), false);
    // Kỹ sư DevOps có Bash để chạy lệnh test/build trong allowed_commands, nhưng chỉ chuẩn bị tệp, không triển khai.
    // Người viết báo cáo ghi được tệp (Write) nhưng không có Edit: chỉ tạo báo cáo mới, không sửa code có sẵn.
    const reporter = findMember(teams, 'Mai').role;
    assert.equal(reporter.tools.includes('Write'), true);
    assert.equal(reporter.tools.includes('Edit'), false);
    assert.equal(reporter.model, 'haiku');
    assert.match(reporter.body, /reports\/<năm-tháng>\/<việc-đã-làm>\.md/);
    const devops = findMember(teams, 'Sơn').role;
    assert.match(devops.body, /Không triển khai/);

    // Skill ngoài đã được duyệt: chỉ bản không có script (differential-review là tài liệu thuần).
    const lock = readLock(lockFile);
    assert.ok(lock.skills['differential-review'].source.startsWith('trailofbits/skills/'));
    assert.equal(fs.readdirSync(path.join(libraryDir, 'differential-review')).some((f) => f.endsWith('.py') || f === 'scripts'), false);
    assert.deepEqual(verifyLibrary({ libraryDir, lockFile }).filter((e) => !e.ok), []);
  } finally {
    removeDir(dir);
  }
});

test('Giám đốc biết phạm vi của mọi team qua get_company_overview, và lời nhắc không ghi cứng danh sách team', async () => {
  const { buildDirectorSystemPrompt } = await import('../server/epics.mjs');
  const teams = loadTeams({ teamsDir: path.join(REPO, 'teams') });
  const director = findMember(teams, 'Hòa');
  const prompt = buildDirectorSystemPrompt({ member: director.member, team: director.team, role: director.role, project: null, kind: 'dplan' });
  assert.doesNotMatch(prompt, /team Backend \(API/, 'danh sách team lấy từ get_company_overview, không ghi cứng trong lời nhắc');
  assert.match(prompt, /get_company_overview/);
  assert.match(prompt, /Thiết kế nên làm TRƯỚC/);
  assert.match(prompt, /rà soát của Bảo mật/);
});

test('hashDir không phụ thuộc kiểu xuống dòng của file văn bản (clone sang máy khác vẫn qua kiểm tra), nhưng vẫn bắt được nội dung bị sửa', () => {
  const dir = tmpDir();
  try {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    for (const d of [a, b]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(a, 'SKILL.md'), '---\nname: x\n---\ndòng 1\ndòng 2\n');
    fs.writeFileSync(path.join(b, 'SKILL.md'), '---\r\nname: x\r\n---\r\ndòng 1\r\ndòng 2\r\n');
    const bin = Buffer.from([1, 13, 10, 0, 2]);
    fs.writeFileSync(path.join(a, 'x.bin'), bin);
    fs.writeFileSync(path.join(b, 'x.bin'), bin);
    assert.equal(hashDir(a), hashDir(b), 'CRLF và LF cho cùng một hash');
    fs.writeFileSync(path.join(b, 'SKILL.md'), '---\r\nname: x\r\n---\r\ndòng 1\r\ndòng 3\r\n');
    assert.notEqual(hashDir(a), hashDir(b), 'đổi nội dung thì hash đổi');
    fs.writeFileSync(path.join(b, 'SKILL.md'), '---\nname: x\n---\ndòng 1\ndòng 2\n');
    fs.writeFileSync(path.join(b, 'x.bin'), Buffer.from([1, 10, 0, 2]));
    assert.notEqual(hashDir(a), hashDir(b), 'file nhị phân được băm nguyên byte');
  } finally {
    removeDir(dir);
  }
});
