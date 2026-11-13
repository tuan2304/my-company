// Đường cơ sở: chạy các lệnh kiểm tra của dự án trên nhánh đang đứng (nên là nhánh gốc, chưa có thay đổi của nhân viên)
// để biết cái nào ĐỎ SẴN. Kết quả in ra dưới dạng khối `known_failures:` để dán vào hồ sơ dự án; không tự ghi file.
import { spawn } from 'node:child_process';

// Chỉ chạy lệnh kiểm tra; `install` và mọi thứ có thể đụng dịch vụ thật không nằm trong `commands` do init sinh ra.
const CHECK_KEY = /^(test|typecheck|type-check|verify|check|lint)([:._-].*)?$/i;

export function pickCheckCommands(commands = {}) {
  return Object.entries(commands).filter(([key, cmd]) => CHECK_KEY.test(key) && typeof cmd === 'string' && cmd.trim());
}

/** Chạy một lệnh, giới hạn thời gian; trả { code, timedOut, tail } với tail là vài dòng cuối của đầu ra. */
export function runCheck(command, { cwd, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (chunk) => {
      out += chunk.toString('utf8');
      if (out.length > 20_000) out = out.slice(-10_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, timedOut: false, tail: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      resolve({ code: code ?? -1, timedOut, tail: lines.slice(-3).join(' | ') });
    });
  });
}

/** Một dòng known_failures cho lệnh đỏ. */
export function describeFailure(key, command, result) {
  const why = result.timedOut ? 'quá thời gian chờ' : `thoát với mã ${result.code}`;
  const tail = result.tail ? `; dòng cuối: ${result.tail.slice(0, 160)}` : '';
  return `${command} (${key}) ${why}${tail}`;
}

export function renderKnownFailures(failures) {
  if (!failures.length) return '# Mọi lệnh kiểm tra đều xanh: không cần khai known_failures.';
  return ['known_failures:', ...failures.map((f) => `  - ${JSON.stringify(f)}`)].join('\n');
}

export async function runBaseline(project, { cwd, timeoutMs, log = console.log, run = runCheck } = {}) {
  const checks = pickCheckCommands(project?.commands);
  if (!checks.length) return { checks: [], failures: [] };
  const rows = [];
  for (const [key, command] of checks) {
    log(`Đang chạy ${command} ...`);
    const result = await run(command, { cwd, timeoutMs });
    rows.push({ key, command, ...result, ok: result.code === 0 && !result.timedOut });
    log(`  ${rows.at(-1).ok ? 'XANH' : 'ĐỎ  '} ${command}`);
  }
  return { checks: rows, failures: rows.filter((r) => !r.ok).map((r) => describeFailure(r.key, r.command, r)) };
}
