import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { hasPin } from './auth.mjs';
import { getEngine } from './engines/index.mjs';
import { findBillingEnv, sanitizedEnv } from './guard.mjs';
import { loadProject } from './project.mjs';
import { folderRules } from './path-guard.mjs';
import { describeRoleSkills, verifyLibrary } from './skills.mjs';
import { loadTeams } from './teams.mjs';
import { checkRepo } from './worktree.mjs';

const execFileAsync = promisify(execFile);

async function run(bin, args, options = {}) {
  const { stdout } = await execFileAsync(bin, args, { windowsHide: true, timeout: 20_000, env: sanitizedEnv(), ...options });
  return stdout.trim();
}

function result(id, level, title, detail = '') {
  return { id, level, title, detail };
}

const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'composer.json'];

/** Gốc dự án có hợp lý không: không phải gốc ổ đĩa, có dấu hiệu là một dự án, và không bị lấy nhầm thư mục cha. */
export function checkProjectRoot(cfg) {
  const out = [];
  const root = path.resolve(cfg.projectRoot);
  const toolName = path.basename(cfg.toolDir);
  if (path.parse(root).root === root) {
    out.push(result('project-root', 'fail', `Gốc dự án đang là gốc ổ đĩa: ${root}`,
      `Công cụ nằm ở ${cfg.toolDir} nên mặc định coi thư mục cha là dự án. Đặt COMPANY_PROJECT_ROOT=<thư mục dự án> hoặc chạy kèm --project <thư mục dự án>, hoặc clone công cụ vào trong dự án (thư mục .my-company).`));
    return out;
  }
  if (!PROJECT_MARKERS.some((m) => fs.existsSync(path.join(root, m)))) {
    out.push(result('project-root', 'warn', `Gốc dự án không giống một dự án: ${root}`, `Không thấy ${PROJECT_MARKERS.slice(0, 4).join(', ')}... Kiểm tra lại COMPANY_PROJECT_ROOT hoặc --project.`));
  }
  if (cfg.projectRootSource === 'parent' && toolName !== '.my-company') {
    out.push(result('project-root', 'warn', `Thư mục công cụ tên "${toolName}" (không phải ".my-company"), gốc dự án đang tự lấy là thư mục cha: ${root}`,
      'README giả định công cụ nằm ở <dự án>/.my-company. Nếu thư mục cha không phải dự án bạn muốn, đặt COMPANY_PROJECT_ROOT hoặc dùng --project.'));
  }
  return out;
}

/** Cấu hình folders: khóa lạ/cũ, team tài liệu chưa khai thư mục, team viết code để rỗng (= không giới hạn). */
export function checkFolders(project, teams) {
  const out = [];
  const ids = new Set(teams.map((t) => t.id));
  for (const { from, to } of project.renamedKeys ?? []) {
    out.push(result('folders', 'warn', `Hồ sơ dự án dùng khóa cũ folders.${from}`, `Đã tự hiểu là folders.${to} (id thật của team). Hãy đổi tên trong local/project.md.`));
  }
  const unknown = Object.keys(project.folders).filter((k) => !ids.has(k));
  if (unknown.length) {
    out.push(result('folders', 'warn', `Khóa trong folders không khớp team nào: ${unknown.join(', ')}`,
      `Các khóa này không có tác dụng (id team: ${[...ids].join(', ')}).${unknown.includes('shared') ? ' Khóa "shared" chưa từng được dùng, có thể xóa.' : ''}`));
  }
  const writers = teams.filter((t) => t.members.some((m) => m.name !== t.lead && ['Write', 'Edit'].some((tool) => t.roles[m.role]?.tools.includes(tool))));
  const empty = writers.filter((t) => folderRules(project.folders[t.id] ?? []).include.length === 0);
  const docs = empty.filter((t) => t.requiresFolders);
  const code = empty.filter((t) => !t.requiresFolders);
  if (docs.length) {
    out.push(result('folders', 'warn', `Team chưa khai thư mục nên KHÔNG ghi được file nào: ${docs.map((t) => t.id).join(', ')}`,
      'Các team này chỉ ghi tài liệu/báo cáo; khai folders cho chúng trong local/project.md, ví dụ security: [docs/security].'));
  }
  if (code.length) {
    out.push(result('folders', 'warn', `Team để folders rỗng nên sửa được MỌI NƠI trong dự án: ${code.map((t) => t.id).join(', ')}`,
      '[] nghĩa là không giới hạn (chỉ chặn .env, .git và file ngoài nhánh làm việc). Khai thư mục để mỗi team chỉ sửa phần của mình.'));
  }
  return out;
}

/** Vai trò khai skill mà không nạp được (chưa duyệt, thiếu SKILL.md, khác hash) và role_skills trỏ tới vai trò không có. */
export function checkRoleSkills({ teams, project, libraryDir, lockFile }) {
  const { rows, unknownRoles } = describeRoleSkills({ teams, project, libraryDir, lockFile });
  const out = [];
  const skipped = rows.flatMap((r) => r.skipped.map((s) => `${r.team}/${r.role}: ${s.name} (${s.reason})`));
  if (skipped.length) out.push(result('role-skills', 'warn', `${skipped.length} skill khai cho vai trò nhưng sẽ không được nạp`, `${skipped.join('; ')}. Xem chi tiết: npm run skills -- roles`));
  if (unknownRoles.length) out.push(result('role-skills', 'warn', `role_skills có vai trò không tồn tại: ${unknownRoles.join(', ')}`, 'Gõ nhầm tên vai trò thì skill âm thầm không được nạp. Xem tên vai trò: npm run skills -- roles'));
  return out;
}

/** Kiểm tra môi trường (`my-company doctor`). Không tốn hạn mức: chỉ chạy các lệnh trạng thái. */
export async function runDoctor(cfg) {
  const checks = [];

  const [major, minor] = process.versions.node.split('.').map(Number);
  checks.push(
    major > 22 || (major === 22 && minor >= 13)
      ? result('node', 'ok', `Node.js ${process.versions.node}`)
      : result('node', 'fail', `Node.js ${process.versions.node} quá cũ`, 'Cần Node.js 22.13 trở lên.'),
  );

  try {
    await run('node', ['--version']);
    checks.push(result('node-path', 'ok', 'Lệnh "node" có trong PATH'));
  } catch {
    checks.push(result('node-path', 'fail', 'Không tìm thấy lệnh "node" trong PATH', 'Hook chặn file của nhân viên gọi "node", thiếu nó thì mọi lần ghi file sẽ bị từ chối.'));
  }

  try {
    checks.push(result('git', 'ok', (await run('git', ['--version'])).replace(/^git version /, 'git ')));
  } catch {
    checks.push(result('git', 'fail', 'Không tìm thấy git', 'Cần git để tạo nhánh riêng cho từng nhân viên.'));
  }

  for (const id of cfg.engines ?? [cfg.engine]) {
    try {
      checks.push(...(await getEngine({ engine: id }).doctor(cfg, { run, result })));
    } catch (err) {
      checks.push(result('engine', 'fail', 'Engine không hợp lệ', err.message));
    }
  }

  const billing = findBillingEnv();
  checks.push(
    billing.length
      ? result('billing', 'warn', `Máy bạn có biến môi trường tính tiền API: ${billing.join(', ')}`, 'Công cụ tự gỡ các biến này khỏi tiến trình claude nó chạy, nhưng hãy cân nhắc xóa chúng khỏi máy.')
      : result('billing', 'ok', 'Không có khóa API trong môi trường'),
  );

  checks.push(...checkProjectRoot(cfg));

  try {
    await checkRepo(cfg.projectRoot);
    checks.push(result('project', 'ok', `Dự án: ${cfg.projectRoot}`));
  } catch (err) {
    checks.push(result('project', 'fail', `Dự án chưa sẵn sàng: ${cfg.projectRoot}`, err.message));
  }

  try {
    const project = loadProject(cfg.localDir);
    if (!project) checks.push(result('profile', 'warn', 'Chưa có hồ sơ dự án (local/project.md)', 'Chạy "npm run init" để tạo bản nháp, rồi xem và sửa.'));
    else if (project.allowedCommands.length === 0) checks.push(result('profile', 'warn', 'Hồ sơ dự án chưa khai lệnh nào được phép', 'Nhân viên sẽ không chạy được lệnh Bash nào (kể cả test).'));
    else checks.push(result('profile', 'ok', `Hồ sơ dự án: ${project.name || path.basename(cfg.projectRoot)} (${project.stack.join(', ') || 'chưa khai stack'})`));
  } catch (err) {
    checks.push(result('profile', 'fail', 'Hồ sơ dự án bị lỗi', err.message));
  }

  try {
    const teams = loadTeams({ teamsDir: cfg.teamsDir, localTeamsDir: path.join(cfg.localDir, 'teams') });
    const people = teams.reduce((n, t) => n + t.members.length, 0);
    checks.push(result('teams', teams.length ? 'ok' : 'warn', `${teams.length} team, ${people} nhân viên`));
  } catch (err) {
    checks.push(result('teams', 'fail', 'Cấu hình team bị lỗi', err.message));
  }

  try {
    const lockFile = path.join(cfg.toolDir, 'skills.lock');
    const verdicts = verifyLibrary({ libraryDir: path.join(cfg.skillsDir, 'library'), lockFile });
    const bad = verdicts.filter((v) => !v.ok);
    if (bad.length) checks.push(result('skills', 'fail', `Skill bị đổi hoặc thiếu: ${bad.map((b) => b.name).join(', ')}`, bad.map((b) => `${b.name}: ${b.reason}`).join('; ')));
    else checks.push(result('skills', 'ok', `${verdicts.length} skill đã duyệt, còn nguyên vẹn`));
  } catch (err) {
    checks.push(result('skills', 'fail', 'Không kiểm tra được skills.lock', err.message));
  }

  try {
    const project = loadProject(cfg.localDir);
    const teams = loadTeams({ teamsDir: cfg.teamsDir, localTeamsDir: path.join(cfg.localDir, 'teams') });
    if (project) checks.push(...checkFolders(project, teams));
    checks.push(...checkRoleSkills({ teams, project, libraryDir: path.join(cfg.skillsDir, 'library'), lockFile: path.join(cfg.toolDir, 'skills.lock') }));
  } catch {
    /* hồ sơ hoặc team lỗi: đã báo ở các mục trên */
  }

  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.accessSync(cfg.dataDir, fs.constants.W_OK);
    checks.push(result('data', 'ok', `Thư mục dữ liệu ghi được: ${cfg.dataDir}`));
  } catch (err) {
    checks.push(result('data', 'fail', 'Không ghi được thư mục dữ liệu', err.message));
  }

  if (cfg.publicHost) {
    checks.push(
      hasPin(cfg.dataDir)
        ? result('remote', 'ok', `Truy cập từ xa bật: https://${cfg.publicHost} (cổng ${cfg.remotePort}, có PIN)`, `Tailscale phải trỏ vào cổng ${cfg.remotePort}, không phải ${cfg.port}: tailscale serve --bg ${cfg.remotePort}`)
        : result('remote', 'warn', 'Đã đặt tên máy từ xa nhưng CHƯA đặt PIN, nên từ xa chưa vào được', 'Chạy "npm run pin -- set".'),
    );
  }

  return checks;
}
