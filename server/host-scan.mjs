import fs from 'node:fs';
import path from 'node:path';

/**
 * Phát hiện công cụ của dự án chủ (tsc, eslint, jest, vitest) có quét nhầm thư mục my-company hay không khi my-company
 * nằm lồng bên trong dự án đó (docs/LOI-TYPECHECK-KHI-DAT-TRONG-DU-AN-KHAC.md). Chỉ ĐỌC file của dự án chủ, không bao giờ sửa.
 */

const ESLINT_FILES = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintignore'];
const TEST_FILES = ['jest.config.js', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs', 'vitest.config.ts', 'vitest.config.mts', 'vitest.workspace.ts'];

/** tsconfig cho phép chú thích và dấu phẩy thừa; bỏ chúng đi (giữ nguyên nội dung chuỗi) rồi mới JSON.parse. */
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Mẫu glob kiểu tsconfig (`**`, `*`, `?`) thành biểu thức chính quy trên đường dẫn tương đối dạng a/b/c. */
function globToRegex(pattern) {
  let p = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Mẫu có khớp đường dẫn này, hoặc một thư mục cha của nó (như cách tsconfig coi "src" là cả cây src)? */
function matchesPathOrParent(pattern, relPath) {
  const re = globToRegex(pattern);
  const parts = relPath.split('/');
  for (let n = 1; n <= parts.length; n += 1) if (re.test(parts.slice(0, n).join('/'))) return true;
  return false;
}

/** tsc có thấy một file .ts nằm trong thư mục tương đối `rel` không (theo include/exclude đã gộp từ extends)? */
export function tsconfigScans(config, rel) {
  const sample = `${rel}/x.ts`;
  const files = Array.isArray(config.files) ? config.files : null;
  const include = Array.isArray(config.include) ? config.include : files ? [] : ['**/*'];
  // Dấu hiệu của tsc: `*` và `**` không vào thư mục bắt đầu bằng dấu chấm, nên ".my-company" an toàn trừ khi mẫu gọi đích danh.
  const hidden = rel.split('/').some((s) => s.startsWith('.'));
  const covered = include.some((pat) => {
    const norm = String(pat).replace(/\\/g, '/').replace(/^\.\//, '');
    if (hidden) return norm === rel || norm.startsWith(`${rel}/`);
    return matchesPathOrParent(norm, sample) || globToRegex(norm).test(sample);
  });
  if (!covered) return false;
  const exclude = Array.isArray(config.exclude) ? config.exclude : ['node_modules', 'bower_components', 'jspm_packages'];
  return !exclude.some((pat) => matchesPathOrParent(String(pat), sample));
}

/** Đọc tsconfig và đi theo `extends` tương đối (tối đa vài tầng) để biết include/exclude hiệu lực. */
function loadTsconfig(file, depth = 0) {
  const config = parseJsonc(fs.readFileSync(file, 'utf8'));
  if (typeof config.extends === 'string' && config.extends.startsWith('.') && depth < 5) {
    const parentFile = path.resolve(path.dirname(file), config.extends.endsWith('.json') ? config.extends : `${config.extends}.json`);
    if (fs.existsSync(parentFile)) {
      const base = loadTsconfig(parentFile, depth + 1);
      // include/exclude/files trong file con thay thế hẳn của file cha; nếu file con không khai thì lấy của cha.
      for (const key of ['include', 'exclude', 'files']) if (config[key] === undefined && base[key] !== undefined) config[key] = base[key];
    }
  }
  return config;
}

/** Các thư mục cha của thư mục công cụ, gần nhất trước, tới gốc ổ đĩa. */
function ancestorsOf(dir) {
  const out = [];
  let cur = path.dirname(path.resolve(dir));
  for (;;) {
    out.push(cur);
    const up = path.dirname(cur);
    if (up === cur) return out;
    cur = up;
  }
}

/**
 * Soát các dự án chủ bao quanh thư mục công cụ. Trả về mảng {tool, file, problem, fix}; rỗng = không thấy vấn đề.
 * `tool`: 'tsc' (đã phân tích include/exclude), 'eslint' | 'test' (chỉ đoán: file cấu hình có nhắc tới tên thư mục công cụ hay không).
 */
export function findHostScanProblems(toolDir) {
  const problems = [];
  const toolName = path.basename(toolDir);
  for (const host of ancestorsOf(toolDir)) {
    const rel = path.relative(host, toolDir).split(path.sep).join('/');
    const tsconfig = path.join(host, 'tsconfig.json');
    if (fs.existsSync(tsconfig)) {
      try {
        if (tsconfigScans(loadTsconfig(tsconfig), rel)) {
          problems.push({
            tool: 'tsc', file: tsconfig,
            problem: `${tsconfig} có "include" bao cả ${rel}/ mà "exclude" chưa loại nó, nên "tsc --noEmit" của dự án chủ sẽ quét code của my-company bằng cấu hình của dự án chủ (hàng trăm lỗi giả).`,
            fix: `Thêm "${rel}" vào "exclude" của tsconfig đó: "exclude": [..., "${rel}"]. Hoặc đặt my-company ở thư mục ngang hàng với dự án.`,
          });
        }
      } catch {
        /* tsconfig không đọc được: để chính tsc báo, doctor không đoán */
      }
    }
    for (const [tool, names] of [['eslint', ESLINT_FILES], ['test', TEST_FILES]]) {
      const found = names.map((n) => path.join(host, n)).find((f) => fs.existsSync(f));
      if (!found) continue;
      let text = '';
      try { text = fs.readFileSync(found, 'utf8'); } catch { continue; }
      if (text.includes(toolName)) continue;
      problems.push({
        tool, file: found,
        problem: `${found} không nhắc tới "${toolName}", nên ${tool === 'eslint' ? 'eslint' : 'bộ chạy test'} của dự án chủ CÓ THỂ quét luôn thư mục này (chưa kiểm chứng: tùy cấu hình).`,
        fix: `Chạy thử lệnh của dự án chủ; nếu thấy lỗi từ ${rel}/ thì thêm "${rel}/**" vào ${tool === 'eslint' ? 'ignores' : 'exclude / testPathIgnorePatterns'}.`,
      });
    }
  }
  return problems;
}

/** Thư mục công cụ có nằm trong một dự án khác (thư mục cha có package.json hoặc .git) không? Trả về thư mục chủ gần nhất hoặc null. */
export function findHostProject(toolDir) {
  return ancestorsOf(toolDir).find((d) => fs.existsSync(path.join(d, 'package.json')) || fs.existsSync(path.join(d, '.git'))) ?? null;
}
