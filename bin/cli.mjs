#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { promisify } from 'node:util';
import { clearPin, hasPin, MIN_PIN_LENGTH, pinProblem, setPin } from '../server/auth.mjs';
import { ensureDirs, loadConfig, TOOL_DIR } from '../server/config.mjs';
import { runBaseline, renderKnownFailures } from '../server/baseline.mjs';
import { runDoctor } from '../server/doctor.mjs';
import { detectStack, loadProject, renderProjectDraft } from '../server/project.mjs';
import { startServer } from '../server/index.mjs';
import {
  describeRoleSkills, fetchToQuarantine, inspectSkillDir, installSkill, parseSource, readLock, verifyLibrary,
} from '../server/skills.mjs';
import { loadTeams } from '../server/teams.mjs';

const execFileAsync = promisify(execFile);

const HELP = `my-company: công ty ảo chạy bằng Claude Code (gói Pro)

Cách dùng:
  my-company init     [--project <thư mục>]   Chuẩn bị dự án: ẩn công cụ khỏi git, tạo hồ sơ nháp
  my-company start    [--dev] [--port <số>]    Chạy máy chủ và giao diện (mặc định cổng 4310)
  my-company doctor                            Kiểm tra môi trường
  my-company baseline [--timeout <giây>]       Chạy lệnh kiểm tra của dự án trên nhánh hiện tại, in khối known_failures cho test đã đỏ sẵn
  my-company pin set|clear|status              Đặt, xóa hoặc xem PIN cho truy cập từ xa (cần khi dùng Tailscale)
  my-company skills list                       Liệt kê skill đã duyệt
  my-company skills verify                     Kiểm tra skill còn nguyên vẹn so với skills.lock (chỉ ra file thiếu/bị sửa/thừa)
  my-company skills roles                      Vai trò nào nạp skill nào, skill nào bị bỏ và vì sao
  my-company skills add <owner/repo/đường/dẫn> [--name <tên>] [--exclude <đường,dẫn>] [--yes]
                                               Tải skill vào khu cách ly để duyệt rồi mới đưa vào thư viện
                                               (--exclude: bỏ các file/thư mục không muốn chép)

Truy cập từ xa: đặt COMPANY_PUBLIC_HOST=<tên máy Tailscale> rồi chạy start; Tailscale trỏ vào cổng từ xa (mặc định 4311).
Gốc dự án mặc định là thư mục cha của thư mục công cụ. Đổi bằng --project hoặc COMPANY_PROJECT_ROOT.`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && ['project', 'port', 'name', 'exclude', 'timeout'].includes(key)) {
        flags[key] = next;
        i += 1;
      } else flags[key] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

const LEVEL_MARK = { ok: 'OK  ', warn: 'CHÚ Ý', fail: 'LỖI ' };

async function cmdDoctor(cfg) {
  const checks = await runDoctor(cfg);
  for (const check of checks) {
    console.log(`[${LEVEL_MARK[check.level]}] ${check.title}`);
    if (check.detail) console.log(`        ${check.detail}`);
  }
  const failed = checks.filter((c) => c.level === 'fail').length;
  const warned = checks.filter((c) => c.level === 'warn').length;
  console.log(`\n${failed} lỗi, ${warned} chú ý.`);
  return failed ? 1 : 0;
}

async function cmdBaseline(cfg, flags) {
  const project = loadProject(cfg.localDir);
  if (!project) {
    console.error('Chưa có hồ sơ dự án (local/project.md). Chạy "npm run init" trước.');
    return 2;
  }
  const seconds = typeof flags.timeout === 'string' ? Number.parseInt(flags.timeout, 10) : 300;
  if (!Number.isFinite(seconds) || seconds < 1) {
    console.error('--timeout phải là số giây dương.');
    return 2;
  }
  const usesNode = Object.values(project.commands ?? {}).some((c) => /^\s*(npm|npx|pnpm|yarn)\b/.test(String(c)));
  if (usesNode && !fs.existsSync(path.join(cfg.projectRoot, 'package.json'))) {
    console.error(`Không có package.json ở ${cfg.projectRoot}, lệnh npm sẽ đỏ vì sai thư mục chứ không phải lỗi thật.`);
    console.error('Chỉ đúng dự án bằng --project <thư mục> hoặc biến COMPANY_PROJECT_ROOT rồi chạy lại.');
    return 2;
  }
  console.log(`Chạy lệnh kiểm tra của dự án ở: ${cfg.projectRoot} (mỗi lệnh tối đa ${seconds} giây).`);
  console.log('Nên chạy khi đang đứng ở nhánh gốc, chưa có thay đổi dở của nhân viên.\n');
  const { checks, failures } = await runBaseline(project, { cwd: cfg.projectRoot, timeoutMs: seconds * 1000 });
  if (!checks.length) {
    console.log('Hồ sơ không có lệnh kiểm tra nào (test, typecheck, verify, check, lint) trong "commands".');
    return 0;
  }
  console.log(`
Dán khối này vào local/project.md (phần đầu, giữa hai dấu ---):

${renderKnownFailures(failures)}`);
  return 0;
}

async function cmdInit(cfg) {
  ensureDirs(cfg);
  console.log(`Gốc dự án: ${cfg.projectRoot}`);

  // 1. Ẩn thư mục công cụ khỏi git của dự án mà không phải sửa .gitignore của bạn.
  const relTool = path.relative(cfg.projectRoot, TOOL_DIR).split(path.sep).join('/');
  if (relTool && !relTool.startsWith('..') && !path.isAbsolute(relTool)) {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: cfg.projectRoot, windowsHide: true });
      const excludeFile = path.resolve(cfg.projectRoot, stdout.trim());
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
      const entry = `${relTool}/`;
      if (existing.split(/\r?\n/).includes(entry)) console.log(`- ${entry} đã có trong .git/info/exclude`);
      else {
        fs.appendFileSync(excludeFile, `${existing && !existing.endsWith('\n') ? '\n' : ''}${entry}\n`);
        console.log(`- Đã thêm ${entry} vào .git/info/exclude của dự án`);
      }
    } catch (err) {
      console.log(`- Chưa ẩn được công cụ khỏi git (${err.message.split('\n')[0]}). Dự án có phải git repo không?`);
    }
  } else {
    console.log('- Công cụ nằm ngoài dự án nên không cần ẩn khỏi git.');
  }

  // 2. Hồ sơ dự án nháp (không bao giờ ghi đè).
  const profile = path.join(cfg.localDir, 'project.md');
  if (fs.existsSync(profile)) {
    console.log(`- Hồ sơ dự án đã có: ${profile}`);
  } else {
    const { stack, commands, skipped } = detectStack(cfg.projectRoot);
    fs.writeFileSync(profile, renderProjectDraft({ name: cfg.projectName, stack, commands, skipped }), 'utf8');
    console.log(`- Đã tạo hồ sơ nháp: ${profile}`);
    console.log(`  Phát hiện công nghệ: ${stack.join(', ') || '(chưa nhận ra)'}`);
    console.log('  Hãy mở file này, kiểm tra và sửa. Hồ sơ quyết định thư mục và lệnh nào agent được phép.');
  }

  console.log(`\nXong. Việc tiếp theo: "npm run doctor" để kiểm tra, rồi "npm run start" và mở http://localhost:${cfg.port}`);
  return 0;
}

async function ensureBuilt() {
  if (fs.existsSync(path.join(TOOL_DIR, '.next', 'BUILD_ID'))) return;
  console.log('Lần đầu chạy: đang build giao diện (vài chục giây)...');
  const nextBin = path.join(TOOL_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nextBin, 'build'], { cwd: TOOL_DIR, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`next build thoát với mã ${code}`))));
    child.on('error', reject);
  });
}

async function cmdStart(cfg, flags) {
  const dev = Boolean(flags.dev);
  if (!dev) await ensureBuilt();
  const app = await startServer({ cfg, dev });
  console.log(`\nCông ty đang chạy: ${app.url}`);
  console.log(`Dự án: ${cfg.projectRoot}`);
  if (app.remotePort) {
    const pinNote = hasPin(cfg.dataDir) ? 'cần PIN' : 'CHƯA đặt PIN, chạy "npm run pin -- set"';
    console.log(`Từ xa: https://${cfg.publicHost} qua cổng ${app.remotePort} (${pinNote})`);
  }
  console.log(`Tối đa ${cfg.maxConcurrent} agent chạy cùng lúc. Nhấn Ctrl+C để dừng.\n`);
  const stop = async () => {
    console.log('\nĐang dừng...');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return new Promise(() => {});
}

/** Đọc một dòng mà không hiện ra màn hình (PIN). Cần cửa sổ lệnh thật. */
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      reject(new Error('Cần chạy trong cửa sổ lệnh thật để nhập PIN (không đọc được từ ống dẫn).'));
      return;
    }
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const done = (fn, value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      fn(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(resolve, buf);
        if (ch === '\u0003') return done(reject, new Error('Đã hủy.'));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
      return undefined;
    };
    stdin.on('data', onData);
  });
}

async function cmdPin(cfg, positional) {
  const [action] = positional;
  ensureDirs(cfg);
  if (action === 'set') {
    const pin = await readHidden(`PIN mới (ít nhất ${MIN_PIN_LENGTH} ký tự, khuyên dùng 8 chữ số trở lên): `);
    const problem = pinProblem(pin);
    if (problem) {
      console.error(problem);
      return 1;
    }
    const again = await readHidden('Nhập lại PIN: ');
    if (again !== pin) {
      console.error('Hai lần nhập không khớp.');
      return 1;
    }
    setPin(cfg.dataDir, pin);
    console.log('Đã đặt PIN. Mọi thiết bị đang đăng nhập đã bị đăng xuất.');
    if (!cfg.publicHost) console.log('Nhớ đặt COMPANY_PUBLIC_HOST=<tên máy Tailscale> khi chạy start thì cổng từ xa mới bật (xem README).');
    return 0;
  }
  if (action === 'clear') {
    clearPin(cfg.dataDir);
    console.log('Đã xóa PIN. Cổng từ xa từ chối mọi yêu cầu cho đến khi đặt PIN mới.');
    return 0;
  }
  if (action === 'status' || !action) {
    console.log(`PIN: ${hasPin(cfg.dataDir) ? 'đã đặt' : 'CHƯA đặt'}`);
    console.log(`Tên máy công khai (COMPANY_PUBLIC_HOST): ${cfg.publicHost || '(chưa đặt, cổng từ xa tắt)'}`);
    if (cfg.publicHost) console.log(`Cổng từ xa: ${cfg.remotePort} (Tailscale cần trỏ vào cổng này, KHÔNG phải ${cfg.port})`);
    return 0;
  }
  console.error('Dùng: pin set | clear | status');
  return 2;
}

function paths(cfg) {
  return {
    libraryDir: path.join(cfg.skillsDir, 'library'),
    lockFile: path.join(cfg.toolDir, 'skills.lock'),
    quarantineDir: path.join(cfg.dataDir, 'quarantine'),
  };
}

async function cmdSkills(cfg, positional, flags) {
  const [action, source] = positional;
  const { libraryDir, lockFile, quarantineDir } = paths(cfg);

  if (action === 'list') {
    const lock = readLock(lockFile);
    const names = Object.keys(lock.skills);
    if (!names.length) console.log('Chưa có skill nào được duyệt.');
    for (const name of names) {
      const e = lock.skills[name];
      console.log(`${name}  (${e.source ?? '?'} @ ${String(e.commit ?? '').slice(0, 10)}, ${e.license ?? 'không rõ giấy phép'})`);
    }
    return 0;
  }

  if (action === 'verify') {
    const verdicts = verifyLibrary({ libraryDir, lockFile });
    for (const v of verdicts) console.log(`[${v.ok ? 'OK  ' : 'LỖI '}] ${v.name}${v.ok ? '' : `: ${v.reason}`}`);
    console.log(`\n${verdicts.filter((v) => !v.ok).length} skill có vấn đề.`);
    return verdicts.some((v) => !v.ok) ? 1 : 0;
  }

  if (action === 'roles') {
    const teams = loadTeams({ teamsDir: cfg.teamsDir, localTeamsDir: path.join(cfg.localDir, 'teams') });
    const project = loadProject(cfg.localDir);
    const { rows, unknownRoles } = describeRoleSkills({ teams, project, libraryDir, lockFile });
    if (!project) console.log('(Chưa có hồ sơ dự án: skill theo công nghệ và role_skills chưa được tính.)\n');
    for (const row of rows) {
      console.log(`${row.team} / ${row.role}: ${row.loaded.length ? row.loaded.join(', ') : '(không nạp skill nào)'}`);
      for (const s of row.skipped) console.log(`    BỎ ${s.name}: ${s.reason}`);
    }
    for (const r of unknownRoles) console.log(`\nCẢNH BÁO: role_skills trong hồ sơ dự án có vai trò "${r}" không tồn tại (gõ nhầm?).`);
    const skippedCount = rows.reduce((n, r) => n + r.skipped.length, 0);
    console.log(`\n${rows.length} vai trò, ${skippedCount} skill bị bỏ.`);
    return skippedCount || unknownRoles.length ? 1 : 0;
  }

  if (action === 'add') {
    if (!source) {
      console.error('Thiếu nguồn. Ví dụ: my-company skills add obra/superpowers/skills/systematic-debugging');
      return 2;
    }
    const parsed = parseSource(source);
    console.log(`Đang tải ${parsed.owner}/${parsed.repo} vào khu cách ly...`);
    const fetched = await fetchToQuarantine({ source, quarantineDir });
    const skillDir = path.join(fetched.dir, ...parsed.subpath.split('/').filter(Boolean));
    const info = inspectSkillDir(skillDir);
    const name = typeof flags.name === 'string' ? flags.name : path.basename(skillDir);

    console.log(`\nSkill "${name}" từ commit ${fetched.commit} (giấy phép: ${fetched.license ?? 'không rõ'})`);
    console.log(`Thư mục cách ly: ${skillDir}\n`);
    for (const f of info.files) console.log(`  ${f.rel}  (${f.size} byte)${f.flags.length ? `   <-- ${f.flags.join(', ')}` : ''}`);
    if (info.risky.length) {
      console.log(`\nCẢNH BÁO: có ${info.risky.length} file là script, hook hoặc nhị phân. Hãy đọc kỹ chúng trước khi duyệt.`);
    }
    console.log('\nHãy mở và đọc SKILL.md cùng mọi file ở trên trong thư mục cách ly trước khi duyệt.');

    let approved = flags.yes === true;
    if (!approved) {
      if (!process.stdin.isTTY) {
        console.error('Không có bàn phím để hỏi. Chạy lại với --yes sau khi bạn đã đọc xong.');
        return 2;
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Gõ "duyet" nếu bạn đã đọc và đồng ý đưa vào thư viện: ');
      rl.close();
      approved = answer.trim().toLowerCase() === 'duyet';
    }
    if (!approved) {
      console.log('Không duyệt. Skill vẫn nằm trong khu cách ly, chưa được nạp.');
      return 1;
    }
    const exclude = typeof flags.exclude === 'string' ? flags.exclude.split(',').map((s) => s.trim()).filter(Boolean) : [];
    installSkill({
      skillDir, libraryDir, lockFile, name, exclude,
      meta: { source: `${parsed.owner}/${parsed.repo}${parsed.subpath ? `/${parsed.subpath}` : ''}`, commit: fetched.commit, license: fetched.license },
    });
    if (exclude.length) console.log(`Đã bỏ khi chép: ${exclude.join(', ')}`);
    console.log(`\nĐã đưa "${name}" vào skills/library và ghi vào skills.lock.`);
    console.log(`Để một vai trò dùng nó, thêm "${name}" vào danh sách skills (hoặc stack_skills) trong file vai trò, ví dụ teams/backend/backend-dev.md.`);
    return 0;
  }

  console.error('Dùng: skills list | verify | roles | add <nguồn>');
  return 2;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  if (!command || flags.help || command === 'help') {
    console.log(HELP);
    return 0;
  }
  const overrides = {};
  if (typeof flags.port === 'string') overrides.port = Number.parseInt(flags.port, 10);
  const cfg = loadConfig({ projectRoot: typeof flags.project === 'string' ? flags.project : undefined, overrides });

  switch (command) {
    case 'init': return cmdInit(cfg);
    case 'start': return cmdStart(cfg, flags);
    case 'doctor': return cmdDoctor(cfg);
    case 'baseline': return cmdBaseline(cfg, flags);
    case 'pin': return cmdPin(cfg, rest);
    case 'skills': return cmdSkills(cfg, rest, flags);
    default:
      console.error(`Lệnh không có: ${command}\n`);
      console.log(HELP);
      return 2;
  }
}

main().then(
  (code) => { if (code !== undefined) process.exitCode = code; },
  (err) => {
    console.error(`Lỗi: ${err.message}`);
    process.exitCode = 1;
  },
);
