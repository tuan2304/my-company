import type { EngineInfo, Task } from './types';

/** Tên bậc model của công ty theo độ khó, để hiện cho người dùng. */
export const TIER_LABEL: Record<string, string> = { haiku: 'Đơn giản', sonnet: 'Bình thường', opus: 'Khó' };

/** Các engine đã liên kết, theo thứ tự ưu tiên. */
export function linkedEngines(engines: EngineInfo[]): EngineInfo[] {
  return engines.filter((e) => e.linked).sort((a, b) => a.order - b.order);
}

/** Model thật mà một engine dùng cho một bậc (haiku/sonnet/opus); bậc lạ (id model cụ thể) giữ nguyên. */
export function modelOn(engine: EngineInfo, tier: string | null | undefined): string {
  const name = tier ?? '';
  return engine.tiers[name] ?? name ?? '?';
}

/** Chỉ các engine làm được vai Trưởng nhóm/Giám đốc (cần công cụ MCP của công ty). */
export function engineLines(engines: EngineInfo[], tier: string | null | undefined, { lead = false }: { lead?: boolean } = {}): { id: string; label: string; model: string }[] {
  return linkedEngines(engines)
    .filter((e) => !lead || e.capabilities.mcp)
    .map((e) => ({ id: e.id, label: e.label, model: modelOn(e, tier) }));
}

/** "Antigravity · gemini-3.8-flash-high" cho việc đã chạy trên một engine; chưa chạy thì chỉ bậc model. */
export function taskModelLabel(task: Pick<Task, 'engine' | 'model'>, engines: EngineInfo[]): string {
  const engine = engines.find((e) => e.id === task.engine);
  if (!engine) return task.model ?? '?';
  const real = modelOn(engine, task.model);
  return real === task.model ? `${engine.label} · ${real}` : `${engine.label} · ${real} (bậc ${task.model})`;
}
