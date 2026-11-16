// my-company đặt lồng trong một dự án khác: công cụ của dự án đó không được quét nhầm, và doctor phải cảnh báo khi có nguy cơ
// (docs/LOI-TYPECHECK-KHI-DAT-TRONG-DU-AN-KHAC.md).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { checkHostScan } from '../server/doctor.mjs';
import { findHostProject, findHostScanProblems, parseJsonc, tsconfigScans } from '../server/host-scan.mjs';
import { REPO, removeDir, tmpDir } from './helpers.mjs';

const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const TSC = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');

/** Dự án chủ giả: tsconfig theo kiểu Next.js (include **) và một file của my-company dùng alias @/ chỉ đúng với tsconfig của chính nó. */
function makeHost(root, { toolName = 'my-company', exclude = ['node_modules'] } = {}) {
  write(root, 'tsconfig.json', `{
    // tsconfig cho phép chú thích và dấu phẩy thừa
    "compilerOptions": { "strict": true, "noEmit": true, "module": "esnext", "moduleResolution": "bundler", "paths": { "@/*": ["./src/*"] }, },
    "include": ["**/*.ts"],
    "exclude": ${JSON.stringify(exclude)},
  }`);
  write(root, 'src/app.ts', 'export const app: number = 1;\n');
  write(root, `${toolName}/tsconfig.json`, '{"compilerOptions":{"strict":true,"noEmit":true,"module":"esnext","moduleResolution":"bundler","paths":{"@/*":["./src/*"]}},"include":["**/*.ts"]}');
  write(root, `${toolName}/src/lib/types.ts`, 'export type T = number;\n');
  write(root, `${toolName}/src/use.ts`, "import type { T } from '@/lib/types';\nexport const t = (x: T) => x.toFixed(0);\n");
  return path.join(root, toolName);
}

test('parseJsonc: bỏ chú thích và dấu phẩy thừa nhưng giữ nguyên chuỗi có // hay /*', () => {
  const out = parseJsonc('{ /* a */ "u": "http://x//y/*z*/", // b\n "n": [1, 2,], }');
  assert.deepEqual(out, { u: 'http://x//y/*z*/', n: [1, 2] });
});

test('tsconfigScans: include/exclude theo đúng cách tsc hiểu, thư mục bắt đầu bằng dấu chấm không bị ** lôi vào', () => {
  assert.equal(tsconfigScans({ include: ['**/*.ts'] }, 'my-company'), true);
  assert.equal(tsconfigScans({}, 'my-company'), true, 'không khai include = quét tất cả');
  assert.equal(tsconfigScans({ include: ['**/*.ts'], exclude: ['my-company'] }, 'my-company'), false);
  assert.equal(tsconfigScans({ include: ['**/*.ts'], exclude: ['./my-company/**'] }, 'my-company'), false);
  assert.equal(tsconfigScans({ include: ['**/*.ts'], exclude: ['my-company/src'] }, 'my-company'), true, 'chỉ loại một phần thì vẫn quét phần còn lại');
  assert.equal(tsconfigScans({ include: ['**/*.ts'], exclude: ['node_modules'] }, 'my-company'), true, 'exclude khai tay thay hẳn mặc định');
  assert.equal(tsconfigScans({ include: ['src/**/*', 'app'] }, 'my-company'), false);
  assert.equal(tsconfigScans({ files: ['a.ts'] }, 'my-company'), false);
  assert.equal(tsconfigScans({ include: ['**/*.ts'] }, '.my-company'), false, 'tsc bỏ qua thư mục ẩn khi dùng **');
  assert.equal(tsconfigScans({ include: ['.my-company'] }, '.my-company'), true, 'nhưng gọi đích danh thì quét');
});

test('findHostScanProblems: cài lồng trong dự án có include "**/*.ts" thì báo kèm đúng dòng cần thêm; có exclude hoặc thư mục ẩn thì im', () => {
  const root = tmpDir();
  try {
    const tool = makeHost(root);
    write(root, 'package.json', '{}');
    const found = findHostScanProblems(tool);
    assert.equal(found.length, 1);
    assert.equal(found[0].tool, 'tsc');
    assert.match(found[0].fix, /"exclude": \[\.\.\., "my-company"\]/);
    assert.equal(findHostProject(tool), root);

    // Đã loại trừ: không còn cảnh báo.
    write(root, 'tsconfig.json', fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8').replace('"node_modules"', '"node_modules", "my-company"'));
    assert.deepEqual(findHostScanProblems(tool), []);
  } finally {
    removeDir(root);
  }
});

test('findHostScanProblems: .my-company (cách cài mặc định) không bị tsc quét; eslint/test của dự án chủ chỉ được nhắc khi không nhắc tên thư mục', () => {
  const root = tmpDir();
  try {
    const tool = makeHost(root, { toolName: '.my-company' });
    assert.deepEqual(findHostScanProblems(tool), []);

    write(root, 'eslint.config.mjs', 'export default [{ files: ["**/*.ts"] }];\n');
    const [eslintProblem, ...rest] = findHostScanProblems(tool);
    assert.equal(eslintProblem.tool, 'eslint');
    assert.deepEqual(rest, []);
    assert.match(eslintProblem.problem, /chưa kiểm chứng/, 'đây chỉ là đoán nên phải nói rõ là chưa kiểm chứng');

    write(root, 'eslint.config.mjs', 'export default [{ ignores: [".my-company/**"] }];\n');
    assert.deepEqual(findHostScanProblems(tool), []);
    write(root, 'vitest.config.ts', 'export default {};\n');
    assert.equal(findHostScanProblems(tool)[0].tool, 'test');
  } finally {
    removeDir(root);
  }
});

test('không có dự án bao quanh thì không có gì để báo', () => {
  const root = tmpDir();
  try {
    const tool = path.join(root, 'my-company');
    fs.mkdirSync(tool, { recursive: true });
    assert.deepEqual(findHostScanProblems(tool), []);
    // Thư mục tạm có thể nằm dưới một thư mục có package.json/.git của máy này; chỉ cần dự án gần nhất thắng.
    write(root, 'package.json', '{}');
    assert.equal(findHostProject(tool), root);
  } finally {
    removeDir(root);
  }
});

test('chống tái phát: dự án chủ có include "**/*.ts" thật sự đỏ khi chạy tsc, doctor báo trước, thêm dòng doctor gợi ý thì tsc xanh', () => {
  const root = tmpDir();
  try {
    const tool = makeHost(root);
    const tsc = (cwd, ...extra) => spawnSync(process.execPath, [TSC, '--noEmit', ...extra], { cwd, encoding: 'utf8', windowsHide: true });

    // Chính my-company, dùng tsconfig của nó: xanh (code không sai).
    assert.equal(tsc(tool, '-p', 'tsconfig.json').status, 0);

    // Từ dự án chủ: đỏ, và mọi lỗi đều nằm trong my-company/ (alias @/ trỏ sai gốc).
    const red = tsc(root);
    assert.notEqual(red.status, 0, 'không có exclude thì phải đỏ, nếu không bài kiểm tra này vô nghĩa');
    const errorLines = red.stdout.split('\n').filter((l) => /error TS\d+/.test(l));
    assert.ok(errorLines.length > 0);
    assert.ok(errorLines.every((l) => l.startsWith('my-company/')), errorLines.join('\n'));
    assert.match(red.stdout, /TS2307/);

    // doctor phải đã cảnh báo đúng chỗ này.
    const warned = checkHostScan({ toolDir: tool });
    assert.equal(warned.length, 1);
    assert.equal(warned[0].level, 'warn');
    assert.match(warned[0].detail, /"exclude"/);

    // Làm theo gợi ý: 0 lỗi thuộc my-company.
    write(root, 'tsconfig.json', fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8').replace('"node_modules"', '"node_modules", "my-company"'));
    const green = tsc(root);
    assert.equal(green.status, 0, green.stdout);
    assert.deepEqual(checkHostScan({ toolDir: tool }), []);
  } finally {
    removeDir(root);
  }
});

test('dọn gói skill của run: mỗi run không để lại bản chép plugin (kể cả file .ts ví dụ)', async () => {
  const { Runner } = await import('../server/runner.mjs');
  const root = tmpDir();
  try {
    for (const id of ['1', '2']) write(root, `runs/${id}/plugin/skills/x/example.ts`, 'export {};\n');
    write(root, 'runs/1/system.md', 'giữ lại');
    const fake = { cfg: { dataDir: root }, removePluginCopy: Runner.prototype.removePluginCopy };
    assert.equal(Runner.prototype.pruneStalePluginCopies.call(fake), 2);
    assert.ok(!fs.existsSync(path.join(root, 'runs/1/plugin')) && !fs.existsSync(path.join(root, 'runs/2/plugin')));
    assert.ok(fs.existsSync(path.join(root, 'runs/1/system.md')));
    assert.equal(Runner.prototype.pruneStalePluginCopies.call({ cfg: { dataDir: path.join(root, 'khong-co') }, removePluginCopy: fake.removePluginCopy }), 0, 'chưa có thư mục runs thì không lỗi');
  } finally {
    removeDir(root);
  }
});
