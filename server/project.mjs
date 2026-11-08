import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatterFile } from './frontmatter.mjs';

function asList(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

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
  return {
    file,
    name: String(data.name ?? ''),
    stack: asList(data.stack),
    folders,
    commands: data.commands && typeof data.commands === 'object' ? data.commands : {},
    allowedCommands: asList(data.allowed_commands),
    preview: parsePreview(data.preview),
    // Thư mục của dự án được nối (junction) vào mỗi worktree để chạy test mà không phải cài lại, ví dụ node_modules.
    worktreeLinks: asList(data.worktree_links ?? ['node_modules']),
    conventions: String(data.conventions ?? '').trim(),
    notes: body,
  };
}

/** Gợi ý stack từ các file cấu hình ở gốc dự án (chưa dùng agent). */
export function detectStack(projectRoot) {
  const stack = [];
  const commands = {};
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
      if (has('@supabase/supabase-js') || fs.existsSync(path.join(projectRoot, 'supabase'))) stack.push('Supabase');
      if (has('prisma') || has('@prisma/client')) stack.push('Prisma');
      if (has('@playwright/test')) stack.push('Playwright');
      for (const name of ['install', 'test', 'lint', 'build']) {
        if (name === 'install') commands.install = 'npm install';
        else if (pkg.scripts?.[name]) commands[name] = name === 'test' ? 'npm test' : `npm run ${name}`;
      }
    } catch {
      /* package.json hỏng: bỏ qua, người dùng sẽ sửa hồ sơ bằng tay */
    }
  }
  if (fs.existsSync(path.join(projectRoot, 'pyproject.toml')) || fs.existsSync(path.join(projectRoot, 'requirements.txt'))) {
    stack.push('Python');
  }
  if (fs.existsSync(path.join(projectRoot, 'go.mod'))) stack.push('Go');
  return { stack, commands };
}

export function renderProjectDraft({ name, stack, commands }) {
  const lines = ['---', `name: ${name}`, `stack: [${stack.join(', ')}]`];
  lines.push('folders:', '  backend:  []   # thư mục thuộc team Backend, ví dụ [src/server, supabase]');
  lines.push('  frontend: []   # thư mục thuộc team Frontend, ví dụ [src/app, src/components]');
  lines.push('  quality:  []   # ví dụ [test]');
  lines.push('  devops:   []   # ví dụ [.github, infra, Dockerfile]');
  lines.push('  design:   []   # ví dụ [design, docs/design]: đặc tả thiết kế, không phải code giao diện');
  lines.push('  security: []   # ví dụ [docs/security]: nơi người rà soát ghi báo cáo');
  lines.push('  reports:  []   # ví dụ [reports]: nơi Team Báo cáo ghi báo cáo mỗi lần push');
  lines.push('  shared:   []');
  lines.push('commands:');
  for (const [key, value] of Object.entries(commands)) lines.push(`  ${key}: ${value}`);
  const allowed = ['git status', 'git diff', ...Object.values(commands).filter((c) => c !== 'npm install')];
  lines.push(`allowed_commands: [${[...new Set(allowed)].join(', ')}]`);
  lines.push('# Không bắt buộc: cách chạy bản xem thử để chụp ảnh khi thi đấu skill ({port} được thay bằng một cổng trống).');
  lines.push('# preview:', '#   command: npm run dev -- --port {port}', '#   url: http://localhost:{port}', '#   pages: [/]', '#   wait_seconds: 90');
  lines.push('conventions: |', '  (Ghi quy ước code của dự án ở đây.)', '---', '');
  lines.push('<!-- BẢN NHÁP do `init` tạo. Hãy xem và sửa trước khi chạy việc thật: hồ sơ này quyết định lệnh nào agent được tự chạy. -->', '');
  return lines.join('\n');
}
