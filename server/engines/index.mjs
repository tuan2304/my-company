import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { agyEngine } from './agy.mjs';
import { claudeEngine } from './claude.mjs';

const ENGINES = { [claudeEngine.id]: claudeEngine, [agyEngine.id]: agyEngine };

export function listEngines() {
  return Object.values(ENGINES);
}

const execFileAsync = promisify(execFile);

async function run(engine, bin, args) {
  const { stdout } = await execFileAsync(bin, args, { windowsHide: true, timeout: 20_000, env: engine.env() });
  return stdout.trim();
}

/**
 * Trạng thái của mọi engine mà công cụ biết (kể cả chưa liên kết): đã cài chưa, đã đăng nhập chưa, model thật, bị chặn tới khi nào.
 * Chỉ chạy lệnh trạng thái, không tốn hạn mức. `blocked` là { mã engine: giờ ms } từ runner.
 */
export async function detectEngines(cfg, { blocked = {} } = {}) {
  const linked = cfg.engines ?? [cfg.engine];
  const now = Date.now();
  return Promise.all(
    listEngines().map(async (engine) => {
      let info;
      try {
        info = await engine.detect(cfg, { run: (bin, args) => run(engine, bin, args) });
      } catch (err) {
        info = { installed: false, version: null, loggedIn: null, models: [], detail: err.message };
      }
      const until = blocked[engine.id] ?? 0;
      return {
        id: engine.id,
        label: engine.label,
        linked: linked.includes(engine.id),
        order: linked.indexOf(engine.id),
        ...info,
        // Bậc model của công ty (haiku/sonnet/opus) thành model thật của engine này (để giao diện hiện đúng model đang dùng).
        tiers: Object.fromEntries(['haiku', 'sonnet', 'opus'].map((tier) => [tier, engine.modelFor(tier)])),
        capabilities: engine.capabilities,
        blockedUntil: until > now ? until : 0,
      };
    }),
  );
}

/** Engine đang dùng theo cấu hình (mặc định claude). Tên lạ thì báo lỗi rõ thay vì chạy nhầm. */
export function getEngine(cfg) {
  const id = cfg?.engine ?? 'claude';
  const engine = ENGINES[id];
  if (!engine) throw new Error(`Engine "${id}" không tồn tại. Hiện có: ${Object.keys(ENGINES).join(', ')}.`);
  return engine;
}
