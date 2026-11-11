'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { TIER_LABEL, linkedEngines } from '@/lib/engines';
import { formatClock, formatCountdown } from '@/lib/format';
import type { EngineInfo } from '@/lib/types';

interface Props {
  engines: EngineInfo[];
  now: number;
  /** Danh sách mới sau khi liên kết/đổi thứ tự (máy chủ trả sẵn). */
  onChange: (engines: EngineInfo[]) => void;
  /** Kiểm tra lại máy (chậm hơn vì agy gọi mạng). */
  onRecheck: () => Promise<void>;
}

const INSTALL_HINT: Record<string, string> = {
  claude: 'Cài Claude Code rồi chạy "claude" một lần để đăng nhập bằng tài khoản Claude (gói Pro).',
  agy: 'Cài Antigravity CLI rồi chạy "agy" một lần để đăng nhập bằng tài khoản Google có gói AI Pro hoặc Ultra.',
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Có lỗi xảy ra.';
}

export default function EnginesPanel({ engines, now, onChange, onRecheck }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const linked = linkedEngines(engines);
  const others = engines.filter((e) => !e.linked);

  async function save(order: string[], key: string) {
    setBusy(key);
    setError(null);
    try {
      const res = await api<{ engines: EngineInfo[] }>('/api/engines', { method: 'POST', body: { order } });
      onChange(res.engines);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function recheck() {
    setBusy('recheck');
    setError(null);
    try {
      await onRecheck();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const ids = linked.map((e) => e.id);
  const move = (id: string, delta: number) => {
    const next = ids.slice();
    const from = next.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= next.length) return;
    [next[from], next[to]] = [next[to], next[from]];
    void save(next, `${id}:move`);
  };

  const card = (engine: EngineInfo) => {
    const blocked = engine.blockedUntil > now && now > 0;
    const loginProblem = engine.installed && engine.loggedIn === false;
    const canLink = engine.installed && !loginProblem;
    const position = ids.indexOf(engine.id);
    return (
      <section key={engine.id} className="card engine-card" aria-label={engine.label}>
        <div className="engine-head">
          <h3>{engine.label}</h3>
          <span className="engine-chips">
            {engine.linked ? <span className="chip status-running">Đã liên kết · ưu tiên {engine.order + 1}</span> : <span className="chip">Chưa liên kết</span>}
            <span className={`chip ${engine.installed ? '' : 'status-failed'}`}>{engine.installed ? `Đã cài${engine.version ? ` (${engine.version.split(' ')[0]})` : ''}` : 'Chưa cài'}</span>
            {engine.installed && (
              <span className={`chip ${engine.loggedIn === false ? 'status-failed' : ''}`}>
                {engine.loggedIn === true ? 'Đã đăng nhập' : engine.loggedIn === false ? 'Chưa đăng nhập' : 'Chưa rõ đăng nhập'}
              </span>
            )}
            {blocked && <span className="chip status-paused_quota">Hết hạn mức · hồi sau {formatCountdown(engine.blockedUntil, now)} (lúc {formatClock(engine.blockedUntil)})</span>}
          </span>
        </div>

        {engine.detail && <p className="muted">{engine.detail}</p>}
        {!engine.installed && <p className="muted">{INSTALL_HINT[engine.id] ?? 'Cài công cụ dòng lệnh của AI này rồi đăng nhập.'}</p>}
        {loginProblem && <p className="muted">{INSTALL_HINT[engine.id] ?? 'Hãy đăng nhập rồi bấm Kiểm tra lại.'}</p>}

        {engine.models.length > 0 && (
          <>
            <h4>Model có trong tài khoản này</h4>
            <p className="engine-models">
              {engine.models.map((m) => (
                <span key={m.id} className="chip" title={m.id}>{m.label}</span>
              ))}
            </p>
            <h4>Công ty dùng model nào</h4>
            <ul className="list-plain engine-tiers">
              {(['haiku', 'sonnet', 'opus'] as const).map((tier) => (
                <li key={tier}>
                  <span>{TIER_LABEL[tier]} <span className="muted">({tier})</span></span>
                  <strong>{engine.tiers[tier] ?? 'model mặc định của AI này'}</strong>
                </li>
              ))}
            </ul>
          </>
        )}

        {!engine.capabilities.mcp && (
          <p className="muted">
            AI này chưa có công cụ hỏi người khác của công ty, nên nhân viên làm bằng nó không hỏi được Trưởng nhóm hay đồng nghiệp, và các lượt của Trưởng nhóm, Giám đốc luôn dùng AI khác.
            {!engine.capabilities.triage && ' Nó cũng không tự đánh giá độ khó (để tiết kiệm hạn mức): việc chạy ở mức Bình thường.'}
          </p>
        )}

        <div className="engine-actions">
          {engine.linked ? (
            <>
              <button type="button" className="secondary small" disabled={busy !== null || position <= 0} onClick={() => move(engine.id, -1)}>Ưu tiên cao hơn</button>
              <button type="button" className="secondary small" disabled={busy !== null || position < 0 || position >= ids.length - 1} onClick={() => move(engine.id, 1)}>Ưu tiên thấp hơn</button>
              <button type="button" className="secondary small" disabled={busy !== null || ids.length <= 1} onClick={() => void save(ids.filter((id) => id !== engine.id), `${engine.id}:unlink`)}>Bỏ liên kết</button>
            </>
          ) : (
            <button type="button" disabled={busy !== null || !canLink} onClick={() => void save([...ids, engine.id], `${engine.id}:link`)}>
              {busy === `${engine.id}:link` ? 'Đang liên kết...' : 'Liên kết'}
            </button>
          )}
        </div>
      </section>
    );
  };

  return (
    <div className="engines">
      <p className="muted">
        Công ty chạy bằng các AI bạn đã liên kết, qua gói đăng ký của chính bạn (không dùng khóa API). AI đứng đầu được dùng trước; khi nó hết hạn mức, việc tự chuyển sang AI kế tiếp còn hạn mức,
        và cả công ty chỉ nghỉ khi mọi AI đã liên kết đều hết. Model của từng AI hiện trong thẻ nhân viên ở văn phòng và trong form giao việc.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      <h3>Đã liên kết ({linked.length})</h3>
      {linked.length === 0 && <p className="muted">Chưa có AI nào được liên kết.</p>}
      {linked.map(card)}
      {others.length > 0 && <h3>Có thể liên kết thêm</h3>}
      {others.map(card)}
      <p>
        <button type="button" className="secondary small" disabled={busy !== null} onClick={() => void recheck()}>
          {busy === 'recheck' ? 'Đang kiểm tra...' : 'Kiểm tra lại các AI trên máy này'}
        </button>
      </p>
    </div>
  );
}
