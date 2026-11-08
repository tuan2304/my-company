import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collect, onlyReports, pickPath, renderReport, slugify, validate, writeReport, writeSummary } from '../scripts/push-report.mjs';

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-report-'));
  sh(dir, 'init', '-q');
  sh(dir, 'config', 'user.email', 't@example.com');
  sh(dir, 'config', 'user.name', 'Tester');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function commitFile(dir, name, content, message) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
  return sh(dir, 'rev-parse', 'HEAD');
}

test('slugify: bỏ dấu tiếng Việt, chỉ chữ thường số gạch ngang, cắt ở ranh giới từ', () => {
  assert.equal(slugify('Thêm nút gộp kết quả vào dự án'), 'them-nut-gop-ket-qua-vao-du-an');
  assert.equal(slugify('Đã sửa lỗi!!  (nhỏ)'), 'da-sua-loi-nho');
  assert.equal(slugify('///'), 'cap-nhat');
  const long = slugify('Failure recovery, integrate button, skill contest, new UI shell; README rewrite and cleanup');
  assert.ok(long.length <= 70 && !long.endsWith('-'));
  assert.ok(validate(`reports/2026-11/${long}.md`));
});

test('validate: chỉ nhận reports/<YYYY-MM>/<tên>.md', () => {
  assert.ok(validate('reports/2026-11/them-nut.md'));
  assert.ok(!validate('reports/them-nut.md'));
  assert.ok(!validate('reports/2026-11/Them Nut.md'));
  assert.ok(!validate('docs/2026-11/them-nut.md'));
  assert.ok(!validate('reports/2026-11/../x.md'));
});

test('onlyReports: chỉ true khi mọi file nằm trong reports/', () => {
  assert.equal(onlyReports([]), false);
  assert.equal(onlyReports([{ name: 'reports/2026-11/a.md' }]), true);
  assert.equal(onlyReports([{ name: 'reports/2026-11/a.md' }, { name: 'src/a.ts' }]), false);
});

test('writeReport: mỗi lần push một file trong reports/<tháng>/, tên theo việc đã làm', () => {
  const dir = tempRepo();
  try {
    const a = commitFile(dir, 'src/a.ts', 'one\ntwo\n', 'Add login form');
    const b = commitFile(dir, 'docs/x.md', 'hi\n', 'Document login form');
    const rel = writeReport([a, b], { branch: 'master', ai: false, now: new Date('2026-11-08T10:00:00Z'), root: dir });
    assert.equal(rel, 'reports/2026-11/document-login-form.md');
    const text = fs.readFileSync(path.join(dir, rel), 'utf8');
    assert.match(text, /^# Document login form/);
    assert.match(text, /Số commit: 2/);
    assert.match(text, /`src\/a\.ts` \+2 -0/);
    assert.match(text, /Add login form/);
    assert.match(text, /\| src \| 1 \| 2 \| 0 \|/);

    // Trùng tên thì thêm -2, không ghi đè.
    const again = writeReport([a, b], { branch: 'master', ai: false, now: new Date('2026-11-09T10:00:00Z'), root: dir });
    assert.equal(again, 'reports/2026-11/document-login-form-2.md');
    assert.ok(fs.existsSync(path.join(dir, rel)));

    // Sang tháng khác thì vào thư mục con khác.
    assert.equal(pickPath('Document login form', new Date('2026-12-01T00:00:00Z'), { root: dir }), 'reports/2026-12/document-login-form.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeReport: bỏ qua khi lần push chỉ chứa reports/ hoặc không có commit', () => {
  const dir = tempRepo();
  try {
    const a = commitFile(dir, 'reports/2026-11/x.md', 'x\n', 'Report: x');
    assert.equal(writeReport([a], { branch: 'master', ai: false, root: dir }), null);
    assert.equal(writeReport([], { branch: 'master', ai: false, root: dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collect: gộp số dòng của nhiều commit trên cùng một file', () => {
  const dir = tempRepo();
  try {
    const a = commitFile(dir, 'f.txt', 'a\n', 'one');
    const b = commitFile(dir, 'f.txt', 'a\nb\nc\n', 'two');
    const { commits, files } = collect([a, b], { cwd: dir });
    assert.equal(commits.length, 2);
    assert.deepEqual(files.map((f) => [f.name, f.add, f.del]), [['f.txt', 3, 0]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeSummary: đọc TITLE và thân từ đầu ra của claude; lỗi hoặc sai định dạng thì trả null', () => {
  const data = { commits: [{ short: 'abc1234', subject: 'x', body: '' }], files: [] };
  const ok = writeSummary(data, 'master', { run: () => ({ status: 0, stdout: 'TITLE: Thêm nút gộp\n\n## Đã làm gì\n- a\n' }) });
  assert.deepEqual(ok, { title: 'Thêm nút gộp', body: '## Đã làm gì\n- a' });
  assert.equal(writeSummary(data, 'master', { run: () => ({ status: 1, stdout: '' }) }), null);
  assert.equal(writeSummary(data, 'master', { run: () => ({ status: 0, stdout: 'không đúng định dạng' }) }), null);
});

test('renderReport: có mục tóm tắt thay thế khi không có AI', () => {
  const text = renderReport({ data: { commits: [], files: [] }, branch: 'm', title: 'T', summary: null, pushedAt: '2026-11-08', remoteUrl: null });
  assert.match(text, /không gọi được Claude/);
});
