import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatterFile } from './frontmatter.mjs';

function asList(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

/** Khóa cũ trong folders -> id team thật (mẫu cũ ghi "reports" trong khi Team Báo cáo nằm ở teams/report). */
const LEGACY_FOLDER_KEYS = { reports: 'report' };

/**
 * Cách chạy bản xem thử để chụp ảnh giao diện (thi đấu skill). Do CHÍNH CHỦ khai trong local/project.md; hệ thống (không phải nhân viên) chạy lệnh này.
 *   preview: { command: "npm run dev -- --port {port}", url: "http://localhost:{port}", pages: ["/", "/login"], wait_seconds: 90 }
 * `{port}` được thay bằng một cổng trống. Không khai thì cuộc thi vẫn chạy, chỉ không có ảnh.
 */
function parsePreview(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const command = String(raw.command ?? '').trim();
  if (!command) return null;
  const pages = asList(raw.pages).filter((p) => p.startsWith('/')).slice(0, 3);
  const wait = Number(raw.wait_seconds);
  return {
    command,
    url: String(raw.url ?? 'http://localhost:{port}').trim().replace(/\/+$/, ''),
    pages: pages.length ? pages : ['/'],
    waitSeconds: Number.isFinite(wait) && wait >= 5 && wait <= 600 ? wait : 90,
  };
}

/** Đọc local/project.md (mục 3.6). Trả về null nếu chưa có. */
export function loadProject(localDir) {
  const file = path.join(localDir, 'project.md');
  if (!fs.existsSync(file)) return null;
  const { data, body } = readFrontmatterFile(file);
  const folders = {};
  for (const [team, list] of Object.entries(data.folders ?? {})) folders[team] = asList(list);
  // Vẫn hiểu khóa cũ để hồ sơ cũ không âm thầm mất giới hạn thư mục; doctor nhắc đổi tên.
  const renamedKeys = [];
  for (const [legacy, id] of Object.entries(LEGACY_FOLDER_KEYS)) {
    if (!Object.hasOwn(folders, legacy)) continue;
    if (!Object.hasOwn(folders, id)) folders[id] = folders[legacy];
    delete folders[legacy];
    renamedKeys.push({ from: legacy, to: id });
  }
  // Thêm skill cho một vai trò mà không phải sao cả team vào local/teams: role_skills: { devops-engineer: [ponytail] }.
  const roleSkills = {};
  if (data.role_skills && typeof data.role_skills === 'object' && !Array.isArray(data.role_skills)) {
    for (const [role, list] of Object.entries(data.role_skills)) roleSkills[role] = asList(list);
  }
  return {
    file,
    name: String(data.name ?? ''),
    stack: asList(data.stack),
    folders,
    renamedKeys,
    roleSkills,
    commands: data.commands && typeof data.commands === 'object' ? data.commands : {},
    allowedCommands: asList(data.allowed_commands),
    preview: parsePreview(data.preview),
    // Thư mục của dự án được nối (junction) vào mỗi worktree để chạy test mà không phải cài lại, ví dụ node_modules.
    worktreeLinks: asList(data.worktree_links ?? ['node_modules']),
    // Lỗi/test đang đỏ SẴN từ trước (không do nhân viên gây ra): báo cho agent khỏi tốn lượt sửa nhầm.
    knownFailures: asList(data.known_failures),
    conventions: String(data.conventions ?? '').trim(),
    notes: body,
  };
}

/** Dòng nhắc đưa vào lời nhắc của agent; null khi hồ sơ không khai lỗi có sẵn. */
export function knownFailuresLine(project) {
  const list = project?.knownFailures ?? [];
  if (!list.length) return null;
  return `- Lỗi có SẴN từ trước, không do bạn gây ra (chỉ sửa nếu việc được giao đúng là sửa nó; nếu không, ghi rõ trong báo cáo rồi bỏ qua): ${list.join('; ')}`;
}

// Script đáng cho nhân viên tự chạy: kiểm tra, không đổi gì bên ngoài, chạy xong thì thoát.
const SAFE_SCRIPT = /^(test|typecheck|type-check|verify|check|lint|build)([:._-].*)?$/i;
// Script KHÔNG tự thêm: chạy mãi (dev, start, watch, serve), đụng dịch vụ thật (deploy, publish, release) hoặc ghi dữ liệu/bí mật.
const RISKY_SCRIPT = /(^|[:._-])(dev|start|serve|preview|watch|deploy|publish|release|secrets?|migrate|seed|reset|push|upload|prod|production)([:._-]|$)/i;

function packageRunner(projectRoot) {
  const has = (name) => fs.existsSync(path.join(projectRoot, name));
  if (has('pnpm-lock.yaml')) return { install: 'pnpm install', run: (n) => `pnpm run ${n}`, test: 'pnpm test' };
  if (has('yarn.lock')) return { install: 'yarn install', run: (n) => `yarn run ${n}`, test: 'yarn test' };
  if (has('bun.lockb') || has('bun.lock')) return { install: 'bun install', run: (n) => `bun run ${n}`, test: 'bun run test' };
  return { install: 'npm install', run: (n) => `npm run ${n}`, test: 'npm test' };
}

/**
 * Gợi ý stack và lệnh từ các file cấu hình ở gốc dự án (chưa dùng agent).
 * `skipped`: script có trong package.json nhưng cố ý không đưa vào, để bản nháp ghi lại cho chủ dự án biết.
 */
export function detectStack(projectRoot) {
  const stack = [];
  const commands = {};
  const skipped = [];
  const exists = (name) => fs.existsSync(path.join(projectRoot, name));
  const pkgFile = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const has = (name) => Object.hasOwn(deps, name);
      if (has('next')) stack.push('Next.js');
      else if (has('react')) stack.push('React');
      if (has('vue')) stack.push('Vue');
      if (has('svelte')) stack.push('Svelte');
      if (has('express')) stack.push('Express');
      if (has('typescript')) stack.push('TypeScript');
      if (has('tailwindcss')) stack.push('Tailwind CSS');
      if (has('@supabase/supabase-js') || exists('supabase')) stack.push('Supabase');
      if (has('prisma') || has('@prisma/client')) stack.push('Prisma');
      if (has('@playwright/test')) stack.push('Playwright');
      if (has('wrangler') || has('@opennextjs/cloudflare') || ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'].some(exists)) {
        stack.push('Cloudflare Workers');
      }
      if (has('@aws-sdk/client-s3')) stack.push('S3 (AWS SDK, có thể là Cloudflare R2)');

      const runner = packageRunner(projectRoot);
      commands.install = runner.install;
      const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts) : [];
      for (const name of scripts.sort((a, b) => a.localeCompare(b))) {
        if (RISKY_SCRIPT.test(name)) skipped.push({ name, reason: 'có thể chạy mãi hoặc đụng dịch vụ/dữ liệu thật' });
        else if (SAFE_SCRIPT.test(name)) commands[name] = name === 'test' ? runner.test : runner.run(name);
      }
    } catch {
      /* package.json hỏng: bỏ qua, người dùng sẽ sửa hồ sơ bằng tay */
    }
  }
  if (exists('pyproject.toml') || exists('requirements.txt')) stack.push('Python');
  if (exists('go.mod')) stack.push('Go');
  return { stack, commands, skipped };
}

const yamlKey = (key) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

export function renderProjectDraft({ name, stack, commands, skipped = [] }) {
  const lines = [
    '---',
    '# HỒ SƠ DỰ ÁN (bản nháp do `init` tạo). Ví dụ đầy đủ có chú thích: docs/vi-du/project.web96photobooth.md trong thư mục công cụ.',
    `name: ${name}`,
    `stack: [${stack.join(', ')}]`,
    '',
    '# Thư mục mỗi team ĐƯỢC SỬA, tính từ gốc dự án. Khớp theo tiền tố: "src/lib" gồm cả src/lib/a.ts; ghi tên một file cũng được.',
    '# Thêm "!" để loại trừ: [src/app, "!src/app/api"] = mọi thứ trong src/app trừ src/app/api (nhớ để trong ngoặc kép).',
    '# [] với team viết code (backend, frontend, quality, devops) = KHÔNG giới hạn: sửa được mọi nơi (trừ .env, .git).',
    '# [] với team chỉ ghi tài liệu (design, security, report) = KHÔNG ghi được file nào: phải khai thì team mới làm được việc.',
    'folders:',
    '  backend:  []   # ví dụ [src/server, supabase]',
    '  frontend: []   # ví dụ [src/app, src/components, "!src/app/api"]',
    '  quality:  []   # ví dụ [tests]',
    '  devops:   []   # ví dụ [.github, infra, Dockerfile]',
    '  design:   []   # ví dụ [docs/design]: đặc tả thiết kế, không phải code giao diện',
    '  security: []   # ví dụ [docs/security]: nơi người rà soát ghi báo cáo',
    '  report:   []   # ví dụ [reports]: nơi Team Báo cáo ghi báo cáo mỗi lần push',
    '',
    '# Lệnh của dự án. `init` chỉ lấy script kiểm tra (test*, typecheck, verify, check*, lint*, build).',
    'commands:',
  ];
  for (const [key, value] of Object.entries(commands)) lines.push(`  ${yamlKey(key)}: ${value}`);
  if (skipped.length) lines.push(`  # Cố ý KHÔNG đưa vào (chạy mãi hoặc đụng dịch vụ/dữ liệu thật): ${skipped.map((s) => s.name).join(', ')}`);
  // Next.js: `build` không chạy được trong worktree dùng node_modules nối (đã thử: Turbopack và webpack đều không tìm thấy next),
  // nên không đưa vào allowed_commands để nhân viên khỏi tốn lượt chạy rồi báo lỗi.
  const nextBuild = stack.includes('Next.js');
  const allowed = ['git status', 'git diff', ...Object.entries(commands)
    .filter(([key, c]) => c !== commands.install && !(nextBuild && /^build([:._-].*)?$/.test(key)))
    .map(([, c]) => c)];
  lines.push(
    '',
    '# Lệnh Bash nhân viên được TỰ chạy. Khớp theo tiền tố: "npm run test" cho phép cả "npm run test -- --grep x".',
    '# Chỉ để lệnh đọc hoặc an toàn. Không thêm dev/start (chạy mãi), deploy, publish. git push luôn bị chặn.',
    `allowed_commands: [${[...new Set(allowed)].join(', ')}]`,
    ...(nextBuild ? ['# Next.js: lệnh build chưa được cho phép vì không chạy được trong worktree (node_modules chỉ được nối vào). Kiểm bằng typecheck/test; build chạy tay ở dự án gốc.'] : []),
    '',
    '# Test/lệnh đang ĐỎ SẴN trên nhánh gốc (chạy "npm run baseline" để lấy danh sách), để nhân viên không đi sửa nhầm:',
    '# known_failures:',
    '#   - "npm run test:core: tests/abc.cjs chết lúc thoát (mã 127)"',
    '',
    '# Thêm skill cho MỘT vai trò mà không phải sao cả team vào local/teams (cộng thêm, không thay skill sẵn có):',
    '# role_skills:',
    '#   qa: [ponytail]',
    '',
    '# Thư mục của dự án được nối vào mỗi nhánh làm việc (worktree) để chạy test không phải cài lại. Mặc định chỉ node_modules.',
    '# File bị gitignore (như .env.local, thư mục sinh ra lúc postinstall) KHÔNG có trong worktree; cần thì thêm vào đây.',
    '# worktree_links: [node_modules]',
    '',
    '# Không bắt buộc: cách chạy bản xem thử để chụp ảnh khi thi đấu skill ({port} được thay bằng một cổng trống).',
    '# preview:',
    '#   command: npm run dev -- --port {port}',
    '#   url: http://localhost:{port}',
    '#   pages: [/]',
    '#   wait_seconds: 90',
    '',
    'conventions: |',
    '  (Ghi quy ước code của dự án ở đây, và các test đang đỏ sẵn nếu có, để nhân viên không đi sửa nhầm.)',
    '---',
    '',
    '<!-- BẢN NHÁP do `init` tạo. Hãy xem và sửa trước khi chạy việc thật: hồ sơ này quyết định nhân viên được sửa ở đâu và chạy lệnh nào. -->',
    '',
  );
  return lines.join('\n');
}
