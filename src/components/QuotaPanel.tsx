'use client';

import { formatClock, formatCountdown, windowLabel } from '@/lib/format';
import type { CompanyState } from '@/lib/types';

export default function QuotaPanel({ company, now }: { company: CompanyState; now: number }) {
  const limit = company.rateLimit;
  const windows = Object.entries(limit?.windows ?? {}).filter(([, w]) => w.utilization !== null);
  const paused = company.pausedUntil > 0 && now > 0 && company.pausedUntil > now;
  const engines = company.engines ?? [];
  const many = engines.length > 1;
  const blocked = engines.filter((e) => e.blockedUntil > now && now > 0);

  return (
    <div className="quota" aria-label="Hạn mức">
      {paused && (
        <p className="notice">
          {many ? 'Mọi AI đã liên kết đều hết hạn mức.' : 'Hết hạn mức Pro.'} Cả công ty nghỉ giải lao, làm tiếp sau{' '}
          <strong>{formatCountdown(company.pausedUntil, now)}</strong> (lúc {formatClock(company.pausedUntil)}).
        </p>
      )}
      {many && (
        <ul className="list-plain engine-status" aria-label="Trạng thái từng AI">
          {engines.map((e) => {
            const down = blocked.some((b) => b.id === e.id);
            return (
              <li key={e.id}>
                <span>{e.label}</span>
                {down
                  ? <span className="chip status-paused_quota">Hết hạn mức · hồi sau {formatCountdown(e.blockedUntil, now)} (lúc {formatClock(e.blockedUntil)})</span>
                  : <span className="chip status-done">Còn hạn mức</span>}
              </li>
            );
          })}
        </ul>
      )}
      {many && windows.length > 0 && <h4>Claude Code</h4>}
      {windows.length === 0 && !paused && <p className="muted">Chưa có số liệu hạn mức. Sẽ hiện sau lần chạy đầu tiên.</p>}
      {windows.map(([name, w]) => {
        const pct = Math.round((w.utilization ?? 0) * 100);
        return (
          <div key={name} className="meter">
            <div className="meter-label">
              <span>{windowLabel(name)}</span>
              <span>{pct}%{w.resetsAt ? ` · hồi ${formatClock(w.resetsAt)}` : ''}</span>
            </div>
            <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className={`fill ${pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : ''}`} style={{ width: `${Math.min(pct, 100)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
