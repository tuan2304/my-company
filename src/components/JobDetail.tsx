'use client';

import { JOB_STATUS_LABEL, STATUS_LABEL, TASK_KIND_LABEL } from '@/lib/format';
import type { Job, Task } from '@/lib/types';
import { CHILD_PHASE_LABEL, splitByPhase, taskPhase } from '@/lib/work-groups';
import ContestPanel from './ContestPanel';
import IntegratePanel from './IntegratePanel';

interface Props {
  job: Job;
  tasks: Task[];
  selectedTaskId: number | null;
  onSelectTask: (id: number) => void;
  onStop: (id: number) => void;
  /** Cho Trưởng nhóm lập kế hoạch lại (việc lớn lỗi mà chưa có việc con nào). */
  onReplan: (id: number) => void;
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

function TaskRow({ task, selected, onSelect }: { task: Task; selected: boolean; onSelect: (id: number) => void }) {
  const files = parseList(task.files);
  return (
    <li>
      <button type="button" className={`row ${selected ? 'selected' : ''}`} onClick={() => onSelect(task.id)}>
        <span className="row-title">#{task.id} {task.title}</span>
        <span className="row-sub">
          {task.member}
          {task.status === 'failed' && task.error ? ` · ${task.error}` : task.kind === 'work' && files.length > 0 ? ` · ${files.join(', ')}` : ''}
          {task.revisions > 0 ? ` · bị trả ${task.revisions} lần` : ''}
          {task.model ? ` · ${task.model}` : ''}
        </span>
        <span className={`chip status-${task.status}`}>{STATUS_LABEL[task.status]}</span>
      </button>
    </li>
  );
}

export default function JobDetail({ job, tasks, selectedTaskId, onSelectTask, onStop, onReplan }: Props) {
  const plan = tasks.filter((t) => t.kind === 'plan');
  const work = tasks.filter((t) => t.kind === 'work');
  const failedWork = work.filter((t) => t.status === 'failed');
  const canReplan = job.status === 'failed' && work.length === 0;
  const reviews = tasks.filter((t) => t.kind === 'review');
  const active = !['done', 'attention', 'failed', 'stopped'].includes(job.status);
  const conflicts = parseList(job.conflict_files);

  return (
    <div className="card detail">
      <div className="detail-head">
        <div>
          <h2>Việc lớn #{job.id}: {job.title}</h2>
          <p className="muted">Trưởng nhóm: {job.lead} · team {job.team}</p>
        </div>
        <span className={`chip job-${job.status}`}>{JOB_STATUS_LABEL[job.status]}</span>
      </div>

      {job.error && <p className={job.status === 'attention' ? 'notice' : 'error'}>{job.error}</p>}
      {conflicts.length > 0 && (
        <p className="notice">File xung đột khi gộp: {conflicts.join(', ')}. Hãy mở các nhánh trong dự án và gộp tay, hoặc giao lại việc.</p>
      )}
      {job.merge_branch && (
        <p>
          Đã gộp các việc đã duyệt vào nhánh <code>{job.merge_branch}</code> (chưa push). Xem bằng <code>git diff {job.base_commit?.slice(0, 8) ?? 'main'} {job.merge_branch}</code>.
        </p>
      )}
      {job.contest && (job.status === 'awaiting_choice' || job.status === 'done') && <ContestPanel key={`${job.id}:${job.status}`} jobId={job.id} />}
      {job.status === 'done' && job.epic_id === null && !job.contest && (
        <IntegratePanel key={`${job.id}:${job.finished_at ?? 0}`} kind="job" id={job.id} />
      )}
      {active && <button type="button" className="danger" onClick={() => onStop(job.id)}>Dừng cả việc lớn</button>}

      {canReplan && (
        <section className="failure" aria-label="Việc lớn bị lỗi">
          <h3>Trưởng nhóm chưa chia được việc</h3>
          <p className="why">
            Lượt lập kế hoạch bị lỗi hoặc không tạo ra việc con nào. Bạn có thể cho {job.lead} lập kế hoạch lại (một lượt mới, các lượt cũ vẫn xem được trong nhật ký).
            Muốn làm tiếp phiên cũ, nâng model hoặc dặn thêm thì mở lượt lập kế hoạch bị lỗi ở danh sách &ldquo;Lượt của Trưởng nhóm&rdquo; bên dưới.
            {job.epic_id !== null ? ` Việc lớn này thuộc yêu cầu #${job.epic_id}: yêu cầu sẽ được mở lại để chạy tiếp.` : ''}
          </p>
          <div className="actions">
            <button type="button" onClick={() => onReplan(job.id)}>Cho {job.lead} lập kế hoạch lại</button>
          </div>
        </section>
      )}
      {failedWork.length > 0 && (job.status === 'attention' || job.status === 'failed' || job.status === 'running') && (
        <section className="failure" aria-label="Việc con bị lỗi">
          <h3>Việc con bị lỗi cần bạn quyết ({failedWork.length})</h3>
          <p className="why">
            {job.status === 'running'
              ? 'Các việc con khác vẫn đang chạy, bạn còn kịp cứu việc lỗi trước khi việc lớn kết thúc.'
              : `Chọn từng việc để làm tiếp, làm lại, nhận phần đã làm hoặc bỏ qua. Việc lớn${job.epic_id !== null ? ` (và yêu cầu #${job.epic_id} chứa nó)` : ''} sẽ được mở lại và gộp lại khi xong.`}
          </p>
          <p className="muted">Bấm vào từng việc trong nhóm &ldquo;{CHILD_PHASE_LABEL.problem}&rdquo; bên dưới để xử lý.</p>
        </section>
      )}

      <section>
        <h3>Việc con ({work.length})</h3>
        {work.length === 0 && <p className="muted">Trưởng nhóm chưa giao việc con nào.</p>}
        {splitByPhase(work, (t) => taskPhase(t.status)).map((g) => (
          <details key={g.phase} className={`group group-${g.phase}`} open={g.phase === 'problem' || g.phase === 'active' || work.length <= 6}>
            <summary>{CHILD_PHASE_LABEL[g.phase]} <span className="group-count">{g.items.length}</span></summary>
            <ul className="list-plain">{g.items.map((t) => <TaskRow key={t.id} task={t} selected={t.id === selectedTaskId} onSelect={onSelectTask} />)}</ul>
          </details>
        ))}
      </section>

      <details className="group" open={[...plan, ...reviews].some((t) => t.status === 'failed' || t.status === 'running')}>
        <summary>Lượt của Trưởng nhóm <span className="group-count">{plan.length + reviews.length}</span></summary>
        <ul className="list-plain">
          {[...plan, ...reviews].map((t) => (
            <li key={t.id}>
              <button type="button" className={`row ${t.id === selectedTaskId ? 'selected' : ''}`} onClick={() => onSelectTask(t.id)}>
                <span className="row-title">#{t.id} {TASK_KIND_LABEL[t.kind]}{t.kind === 'review' && t.subject_id ? ` việc #${t.subject_id}` : ''}</span>
                <span className="row-sub">
                  {t.member} · {t.model}
                  {t.verdict ? ` · ${t.verdict === 'approve' ? 'đã duyệt' : t.verdict === 'reject' ? 'trả lại' : 'trả lần cuối'}` : ''}
                </span>
                <span className={`chip status-${t.status}`}>{STATUS_LABEL[t.status]}</span>
              </button>
            </li>
          ))}
        </ul>
      </details>

      {job.summary && (
        <section>
          <h3>Báo cáo</h3>
          <pre className="result">{job.summary}</pre>
        </section>
      )}
    </div>
  );
}
