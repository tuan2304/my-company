import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function intFromEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Tên máy dùng để vào từ xa (ví dụ "may-cua-ban.tail1234.ts.net"). Bỏ http(s)://, cổng và dấu / ở cuối.
 * Trả về chuỗi rỗng nếu chưa đặt; ném lỗi nếu giá trị không phải tên máy hợp lệ hoặc trỏ về chính máy này.
 */
export function normalizePublicHost(raw) {
  let host = String(raw ?? '').trim().toLowerCase();
  if (!host) return '';
  host = host.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/:\d+$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || host.length > 253) {
    throw new Error(`COMPANY_PUBLIC_HOST "${raw}" không phải tên máy hợp lệ (ví dụ may-cua-ban.tail1234.ts.net).`);
  }
  if (/^\d+(\.\d+){3}$/.test(host)) throw new Error('COMPANY_PUBLIC_HOST phải là tên máy, không phải địa chỉ IP.');
  return host;
}

/**
 * Gốc dự án là thư mục cha của thư mục công cụ (mục 3.7). Có thể ghi đè bằng
 * --project hoặc COMPANY_PROJECT_ROOT, dùng khi phát triển công cụ ngoài dự án.
 */
export function resolveProjectRoot(explicit) {
  const chosen = explicit || process.env.COMPANY_PROJECT_ROOT || path.dirname(TOOL_DIR);
  return path.resolve(chosen);
}

export function loadConfig({ projectRoot, overrides = {} } = {}) {
  const root = resolveProjectRoot(projectRoot);
  const projectName = path.basename(root);
  const cfg = {
    toolDir: TOOL_DIR,
    projectRoot: root,
    // Gốc dự án lấy từ đâu: "flag" (--project), "env" (COMPANY_PROJECT_ROOT) hay "parent" (mặc định: thư mục cha của công cụ).
    projectRootSource: projectRoot ? 'flag' : process.env.COMPANY_PROJECT_ROOT ? 'env' : 'parent',
    projectName,
    host: '127.0.0.1',
    port: intFromEnv('OFFICE_PORT', 4310),
    // Truy cập từ xa (giai đoạn 6E): cổng RIÊNG, luôn đòi PIN, chỉ nghe loopback. Tailscale trỏ vào cổng này
    // (tailscale serve --bg 4311), còn cổng chính chỉ dành cho trình duyệt trên chính máy này.
    // Chỉ bật khi đặt COMPANY_PUBLIC_HOST.
    publicHost: normalizePublicHost(process.env.COMPANY_PUBLIC_HOST),
    remotePort: intFromEnv('COMPANY_REMOTE_PORT', 4311),
    // Thêm dịch vụ nhận thông báo đẩy ngoài danh sách có sẵn (tên máy, phân cách bằng dấu phẩy). Thường không cần.
    pushHosts: (process.env.COMPANY_PUSH_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    dataDir: path.resolve(process.env.COMPANY_DATA_DIR || path.join(TOOL_DIR, 'data')),
    localDir: path.resolve(process.env.COMPANY_LOCAL_DIR || path.join(TOOL_DIR, 'local')),
    teamsDir: path.join(TOOL_DIR, 'teams'),
    templatesDir: path.join(TOOL_DIR, 'templates'),
    skillsDir: path.join(TOOL_DIR, 'skills'),
    worktreesDir: path.resolve(
      process.env.COMPANY_WORKTREES_DIR || path.join(path.dirname(root), `${projectName}-worktrees`),
    ),
    maxConcurrent: intFromEnv('COMPANY_MAX_CONCURRENT', 2),
    // Dự phòng thêm sau giờ hạn mức hồi trước khi thử lại.
    quotaMarginMs: 30_000,
    // Thời gian tối đa cho một lượt trả lời câu hỏi của đồng nghiệp (phút); quá hạn thì người hỏi tự quyết.
    answerTimeoutMinutes: 5,
    // Chờ bao lâu rồi tự làm tiếp một việc bị tiến trình thoát bất thường (một lần duy nhất).
    autoRetryDelayMs: 30_000,
    // Engine chạy nhân viên (server/engines): "claude" hoặc "agy" (Antigravity).
    engine: process.env.COMPANY_ENGINE || 'claude',
    claudeBin: process.env.COMPANY_CLAUDE_BIN || 'claude',
    // Dùng khi kiểm thử: chạy "node fake-claude.mjs" thay cho claude thật.
    claudeArgsPrefix: [],
    agyBin: process.env.COMPANY_AGY_BIN || 'agy',
    // Dùng khi kiểm thử: chạy "node fake-agy.mjs" thay cho agy thật.
    agyArgsPrefix: [],
    ...overrides,
  };
  // Các engine đã liên kết, theo thứ tự ưu tiên: hết hạn mức engine này thì chuyển sang engine kế (COMPANY_ENGINES="claude,agy").
  // Đặt riêng engine (ghi đè hoặc COMPANY_ENGINE) mà không đặt danh sách thì danh sách chỉ có engine đó.
  if (!Array.isArray(cfg.engines)) {
    const fromEnv = overrides.engine ? [] : (process.env.COMPANY_ENGINES ?? '').split(',').map((e) => e.trim()).filter(Boolean);
    cfg.engines = fromEnv.length ? fromEnv : [cfg.engine];
  }
  cfg.engine = cfg.engines[0];
  return cfg;
}

export function ensureDirs(cfg) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(path.join(cfg.dataDir, 'runs'), { recursive: true });
  fs.mkdirSync(cfg.localDir, { recursive: true });
}
