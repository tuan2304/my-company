'use client';

import { useEffect, useRef, useState } from 'react';
import {
  formatClock, formatCountdown, formatDuration, formatTokens, KIND_LABEL, LEVEL_LABEL, STATUS_LABEL, TASK_KIND_LABEL,
} from '@/lib/format';
import { taskModelLabel } from '@/lib/engines';
import type { EngineInfo, Task, TaskEvent } from '@/lib/types';
import { isTechnicalEvent } from '@/lib/work-groups';
import FailurePanel from './FailurePanel';
import IntegratePanel from './IntegratePanel';
import OwnerQuestionPanel from './OwnerQuestionPanel';

interface Props {
  task: Task | null;
  /** Các AI đã liên kết (để hiện model thật của engine đã chạy việc này). */
  engines?: EngineInfo[];
  events: TaskEvent[];
  now: number;
  onStop: (id: number) => void;
}

type View = 'overview' | 'log' | 'files';

function parseFiles(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

const ACTIVE = new Set<Task['status']>(['running', 'queued', 'paused_quota', 'waiting_answer', 'submitted']);

/** Một câu nói việc đang ở đâu, đặt ngay dưới tiêu đề. */
function stateLine(task: Task, now: number): string {
  switch (task.status) {
    case 'queued': return 'Đang chờ tới lượt chạy.';
    case 'running': return task.started_at && now ? `Đang làm, đã chạy ${formatDuration(now - task.started_at)}.` : 'Đang làm.';
    case 'paused_quota': return task.resume_at && now ? `Hết hạn mức Pro, tự làm tiếp sau ${formatCountdown(task.resume_at, now)}.` : 'Hết hạn mức Pro, sẽ tự làm tiếp.';
    case 'waiting_answer': return task.ask_owner_id !== null ? 'Đang chờ bạn trả lời một câu hỏi.' : 'Đang chờ đồng nghiệp trả lời.';
    case 'submitted': return 'Đã nộp, đang chờ Trưởng nhóm duyệt.';
    case 'done': return task.duration_ms ? `Xong sau ${formatDuration(task.duration_ms)}.` : 'Đã xong.';
    case 'failed': return 'Bị lỗi. Chọn cách xử lý ở bên dưới.';
    case 'stopped': return 'Đã dừng.';
    default: return '';
  }
}

export default function TaskDetail({ task, engines = [], events, now, onStop }: Props) {
  const logRef = useRef<HTMLOListElement>(null);
  // Thẻ con nhớ theo từng việc: mở việc khác thì về thẻ mặc định của việc đó.
  const [picked, setPicked] = useState<{ id: number; view: View } | null>(null);
  const [showTech, setShowTech] = useState(false);

  const defaultView: View = task && (task.status === 'running' || task.status === 'queued') ? 'log' : 'overview';
  const view: View = task && picked?.id === task.id ? picked.view : defaultView;
  const visible = showTech ? events : events.filter((e) => !isTechnicalEvent(e.kind));
  const hidden = events.length - visible.length;

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, task?.id, view]);

  if (!task) {
    return (
      <div className="card empty detail-empty">
        <p>Chọn một việc trong danh sách để xem chi tiết, hoặc bấm vào một nhân viên trong văn phòng.</p>
      </div>
    );
  }

  const active = ACTIVE.has(task.status);
  const files = parseFiles(task.changed_files);
  const allTokens = task.input_tokens + task.output_tokens + task.cache_read_tokens + task.cache_creation_tokens;
  const setView = (v: View) => setPicked({ id: task.id, view: v });

  return (
    <div className="card detail">
      <header className={`dhead tone-${task.status}`}>
        <div className="dhead-main">
          <p className="dhead-kicker">
            {task.kind !== 'work' ? `${TASK_KIND_LABEL[task.kind]} · ` : ''}Việc #{task.id}
          </p>
          <h2>{task.title}</h2>
          <p className="muted">
            {task.member} · {task.role} · {taskModelLabel(task, engines)}{task.effort ? ` (${task.effort})` : ''}
          </p>
        </div>
        <div className="dhead-side">
          <span className={`chip status-${task.status}`}>{task.status === 'submitted' ? 'Chờ Trưởng nhóm duyệt' : STATUS_LABEL[task.status]}</span>
          {active && task.status !== 'submitted' && (
            <button type="button" className="danger small" onClick={() => onStop(task.id)}>Dừng việc này</button>
          )}
        </div>
      </header>
      <p className="dstate">{stateLine(task, now)}</p>

      {/* Những thứ cần bạn làm luôn nằm trên cùng, không bị giấu trong thẻ con. */}
      {task.error && task.status !== 'stopped' && <p className="error">{task.error}</p>}
      {task.kind === 'work' && task.status === 'waiting_answer' && task.ask_owner_id !== null && (
        <OwnerQuestionPanel key={task.ask_owner_id} questionId={task.ask_owner_id} asker={task.member} />
      )}
      {task.kind !== 'answer' && task.status === 'failed' && (
        <FailurePanel key={`${task.id}:${task.recoveries}:${task.finished_at ?? 0}`} task={task} />
      )}

      <div className="tabs subtabs" role="tablist" aria-label="Phần của việc">
        <button type="button" role="tab" aria-selected={view === 'overview'} className={view === 'overview' ? 'tab active' : 'tab'} onClick={() => setView('overview')}>Tổng quan</button>
        <button type="button" role="tab" aria-selected={view === 'log'} className={view === 'log' ? 'tab active' : 'tab'} onClick={() => setView('log')}>
          Nhật ký <span className="tab-count">{visible.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={view === 'files'} className={view === 'files' ? 'tab active' : 'tab'} onClick={() => setView('files')}>
          File thay đổi <span className="tab-count">{files.length}</span>
        </button>
      </div>

      {view === 'overview' && (
        <div className="dview" role="tabpanel" aria-label="Tổng quan">
          {task.result ? (
            <section>
              <h3>Kết quả</h3>
              <pre className="result">{task.result}</pre>
            </section>
          ) : (
            <p className="muted">{active ? 'Chưa có kết quả: việc còn đang chạy. Xem tiến độ ở thẻ Nhật ký.' : 'Không có kết quả.'}</p>
          )}
          {task.kind === 'work' && task.job_id === null && task.epic_id === null && task.status === 'done' && (
            <IntegratePanel key={`${task.id}:${task.finished_at ?? 0}`} kind="task" id={task.id} />
          )}
          <dl className="meta">
            <div><dt>Độ khó</dt><dd>{LEVEL_LABEL[task.level] ?? task.level}{task.level_source === 'user' ? ' (bạn chọn)' : ''}</dd></div>
            <div><dt>Lượt</dt><dd>{task.turns}</dd></div>
            <div><dt>Lần chạy</dt><dd>{task.attempts}</dd></div>
            {task.kind === 'work' && task.job_id !== null && <div><dt>Bị trả lại</dt><dd>{task.revisions} lần</dd></div>}
            <div><dt>Thời gian</dt><dd>{task.duration_ms ? formatDuration(task.duration_ms) : '—'}</dd></div>
            <div><dt>Token (tổng)</dt><dd>{formatTokens(allTokens)}</dd></div>
            <div><dt>Ước tính giá API</dt><dd title="Chỉ để so sánh mức dùng. Bạn dùng gói Pro nên không bị tính khoản này.">${task.est_cost_usd.toFixed(3)}</dd></div>
            <div className="meta-wide"><dt>Nhánh</dt><dd>{task.branch ?? '—'}</dd></div>
          </dl>
          {(task.level_reason || task.escalations > 0) && (
            <p className="muted small-text">
              {task.level_reason}
              {task.escalations > 0 ? ` Đã được nâng model ${task.escalations} lần vì việc chưa xong.` : ''}
            </p>
          )}
        </div>
      )}

      {view === 'log' && (
        <div className="dview" role="tabpanel" aria-label="Nhật ký">
          <div className="log-tools">
            <label className="check">
              <input type="checkbox" checked={showTech} onChange={(e) => setShowTech(e.target.checked)} />
              Hiện dòng kỹ thuật{hidden > 0 ? ` (${hidden} dòng đang ẩn)` : ''}
            </label>
          </div>
          <ol className="log" ref={logRef}>
            {visible.length === 0 && <li className="muted">Chưa có sự kiện.</li>}
            {visible.map((e) => (
              <li key={e.id} className={`kind-${e.kind}`}>
                <time>{formatClock(e.ts)}</time>
                <span className="kind">{KIND_LABEL[e.kind] ?? e.kind}</span>
                <span className="text">{e.summary}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {view === 'files' && (
        <div className="dview" role="tabpanel" aria-label="File thay đổi">
          {files.length === 0 ? (
            <p className="muted">{active ? 'Chưa có file nào thay đổi.' : 'Việc này không đổi file nào.'}</p>
          ) : (
            <>
              <ul className="files">{files.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
              <p className="muted">Nằm trên nhánh <code>{task.branch}</code>, chưa push. Xem bằng <code>git diff {task.branch}</code>.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
