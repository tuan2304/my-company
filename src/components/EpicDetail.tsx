'use client';

import { useState } from 'react';
import { EPIC_STATUS_LABEL, JOB_STATUS_LABEL, STATUS_LABEL, TASK_KIND_LABEL } from '@/lib/format';
import type { Epic, Job, Task } from '@/lib/types';
import { CHILD_PHASE_LABEL, jobPhase, splitByPhase } from '@/lib/work-groups';
import FailurePanel from './FailurePanel';
import IntegratePanel from './IntegratePanel';

interface Props {
  epic: Epic;
  jobs: Job[];
  directorTasks: Task[];
  selectedJobId: number | null;
  selectedTaskId: number | null;
  onSelectJob: (id: number) => void;
  onSelectTask: (id: number) => void;
  onAct: (action: 'approve-plan' | 'reject-plan' | 'approve-result' | 'reject-result' | 'stop', feedback?: string) => void;
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export default function EpicDetail({ epic, jobs, directorTasks, selectedJobId, selectedTaskId, onSelectJob, onSelectTask, onAct }: Props) {
  const [feedback, setFeedback] = useState('');
  const active = !['done', 'attention', 'failed', 'stopped', 'rejected'].includes(epic.status);
  const conflicts = parseList(epic.conflict_files);
  const titleOf = (id: number) => jobs.find((j) => j.id === id)?.title ?? `#${id}`;

  return (
    <div className="card detail">
      <div className="detail-head">
        <div>
          <h2>Yêu cầu #{epic.id}: {epic.title}</h2>
          <p className="muted">Giám đốc: {epic.director}{epic.round > 0 ? ` · đã làm lại ${epic.round} đợt` : ''}{epic.replans > 0 ? ` · kế hoạch lập lại ${epic.replans} lần` : ''}</p>
        </div>
        <span className={`chip epic-${epic.status}`}>{EPIC_STATUS_LABEL[epic.status]}</span>
      </div>

      {epic.error && <p className={epic.status === 'attention' || epic.status === 'rejected' ? 'notice' : 'error'}>{epic.error}</p>}
      {conflicts.length > 0 && <p className="notice">File xung đột khi ghép kết quả các team: {conflicts.join(', ')}.</p>}

      {epic.status === 'awaiting_plan' && (
        <section className="gate">
          <h3>Kế hoạch đang chờ bạn duyệt</h3>
          {epic.plan_summary && <pre className="result">{epic.plan_summary}</pre>}
          <p className="muted">Các team chưa làm gì cho đến khi bạn duyệt. Từ chối thì Giám đốc lập lại theo nhận xét của bạn (tối đa 2 lần).</p>
          <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} placeholder="Nhận xét nếu bạn muốn Giám đốc sửa kế hoạch" />
          <div className="actions">
            <button type="button" onClick={() => onAct('approve-plan')}>Duyệt kế hoạch</button>
            <button type="button" className="danger" disabled={feedback.trim().length < 5} onClick={() => { onAct('reject-plan', feedback); setFeedback(''); }}>Từ chối, lập lại</button>
          </div>
        </section>
      )}

      {epic.status === 'awaiting_result' && (
        <section className="gate">
          <h3>Kết quả đang chờ bạn duyệt</h3>
          {epic.final_report && <pre className="result">{epic.final_report}</pre>}
          {epic.merge_branch && (
            <p className="muted">Mã đã ghép nằm ở nhánh <code>{epic.merge_branch}</code> (chưa push). Xem bằng <code>git diff {epic.base_commit?.slice(0, 8) ?? 'main'} {epic.merge_branch}</code>.</p>
          )}
          <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2} placeholder="Lý do nếu bạn không duyệt (không bắt buộc)" />
          <div className="actions">
            <button type="button" onClick={() => onAct('approve-result')}>Duyệt kết quả</button>
            <button type="button" className="danger" onClick={() => { onAct('reject-result', feedback); setFeedback(''); }}>Không duyệt</button>
          </div>
        </section>
      )}

      {(epic.status === 'attention' || epic.status === 'failed') && (
        <FailurePanel key={`${epic.id}:${epic.status}:${epic.round}:${epic.finished_at ?? 0}`} epic={epic} onSelectJob={onSelectJob} />
      )}

      {epic.status !== 'awaiting_result' && epic.merge_branch && (
        <p>Kết quả ghép của các team nằm ở nhánh <code>{epic.merge_branch}</code> (chưa push).</p>
      )}
      {epic.status === 'done' && <IntegratePanel key={`${epic.id}:${epic.finished_at ?? 0}`} kind="epic" id={epic.id} />}
      {epic.status === 'done' && epic.final_report && (
        <section>
          <h3>Báo cáo của Giám đốc</h3>
          <pre className="result">{epic.final_report}</pre>
        </section>
      )}

      {active && <button type="button" className="danger" onClick={() => onAct('stop')}>Dừng cả yêu cầu</button>}

      {epic.contract && (
        <section>
          <h3>Hợp đồng chung</h3>
          <pre className="result">{epic.contract}</pre>
        </section>
      )}

      <section>
        <h3>Việc cho các team ({jobs.length})</h3>
        {jobs.length === 0 && <p className="muted">Giám đốc chưa tạo việc nào.</p>}
        {splitByPhase(jobs, (j) => jobPhase(j.status)).map((g) => (
          <details key={g.phase} className={`group group-${g.phase}`} open={g.phase === 'problem' || g.phase === 'active' || jobs.length <= 6}>
            <summary>{CHILD_PHASE_LABEL[g.phase]} <span className="group-count">{g.items.length}</span></summary>
            <ul className="list-plain">
              {g.items.map((j) => {
                const deps = parseList(j.depends_on).map(Number);
                return (
                  <li key={j.id}>
                    <button type="button" className={`row ${j.id === selectedJobId ? 'selected' : ''}`} onClick={() => onSelectJob(j.id)}>
                      <span className="row-title">#{j.id} {j.title}</span>
                      <span className="row-sub">
                        {j.team} · Trưởng nhóm {j.lead}
                        {deps.length > 0 ? ` · chờ ${deps.map(titleOf).join(', ')}` : ''}
                        {j.round > 0 ? ` · làm lại đợt ${j.round}` : ''}
                      </span>
                      <span className={`chip job-${j.status}`}>{JOB_STATUS_LABEL[j.status]}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </details>
        ))}
      </section>

      <details className="group" open={directorTasks.some((t) => t.status === 'failed' || t.status === 'running')}>
        <summary>Lượt của Giám đốc <span className="group-count">{directorTasks.length}</span></summary>
        <ul className="list-plain">
          {directorTasks.map((t) => (
            <li key={t.id}>
              <button type="button" className={`row ${t.id === selectedTaskId && selectedJobId === null ? 'selected' : ''}`} onClick={() => onSelectTask(t.id)}>
                <span className="row-title">#{t.id} {TASK_KIND_LABEL[t.kind]}</span>
                <span className="row-sub">{t.member} · {t.model}</span>
                <span className={`chip status-${t.status}`}>{STATUS_LABEL[t.status]}</span>
              </button>
            </li>
          ))}
        </ul>
      </details>

      {epic.summary && (
        <section>
          <h3>Tóm tắt</h3>
          <pre className="result">{epic.summary}</pre>
        </section>
      )}
    </div>
  );
}
