'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatClock, KIND_LABEL } from '@/lib/format';
import type { Epic, FailureInfo, FailureOption, Task } from '@/lib/types';

interface Props {
  /** Việc "làm" hoặc lượt của Trưởng nhóm/Giám đốc bị lỗi. */
  task?: Task;
  /** Hoặc cả yêu cầu bị lỗi / cần xem. */
  epic?: Epic;
  /** Mở một việc lớn trong danh sách việc chưa đạt của yêu cầu. */
  onSelectJob?: (id: number) => void;
}

const HEADING: Record<Task['kind'], string> = {
  work: 'Việc bị lỗi',
  plan: 'Lượt lập kế hoạch của Trưởng nhóm bị lỗi',
  review: 'Lượt duyệt bài của Trưởng nhóm bị lỗi',
  dplan: 'Giám đốc lập kế hoạch bị lỗi',
  dreview: 'Giám đốc kiểm tra bị lỗi',
  answer: 'Lượt trả lời câu hỏi bị lỗi',
};

/** Người sẽ nhận lời dặn của bạn. */
function whoOf(task: Task | undefined, epic: Epic | undefined): string {
  if (epic) return 'Giám đốc';
  if (!task) return 'nhân viên';
  if (task.kind === 'dplan' || task.kind === 'dreview') return 'Giám đốc';
  if (task.kind === 'plan' || task.kind === 'review') return 'Trưởng nhóm';
  return 'nhân viên';
}

/**
 * Việc, lượt của Trưởng nhóm/Giám đốc, hoặc cả yêu cầu bị lỗi: nói rõ chuyện gì đã xảy ra và đưa các phương án
 * (làm tiếp, nâng model, làm lại, nhận phần đã làm, bỏ qua; với yêu cầu còn có "bỏ phần lỗi").
 * Nơi gọi đặt `key` theo đối tượng, số lần xử lý và trạng thái để khối này tạo lại khi nó đổi trạng thái.
 */
export default function FailurePanel({ task, epic, onSelectJob }: Props) {
  const base = epic ? `/api/epics/${epic.id}` : `/api/tasks/${task?.id ?? 0}`;
  const who = whoOf(task, epic);
  const heading = epic ? 'Yêu cầu cần bạn xử lý' : HEADING[task?.kind ?? 'work'];
  const [info, setInfo] = useState<FailureInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<FailureOption | null>(null);
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await api<FailureInfo>(`${base}/recovery`));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Không đọc được thông tin lỗi.');
    }
  }, [base]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function run() {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/recover`, { method: 'POST', body: { action: choice.action, guidance: choice.guidance ? guidance : undefined } });
      // Đối tượng chuyển trạng thái nên nơi gọi sẽ tạo lại khối này (hoặc bỏ nó đi).
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Xử lý thất bại.');
      setChoice(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <p className="error">{loadError}</p>;
  if (!info) return null;
  const d = info.diagnosis;
  const wantsGuidance = Boolean(choice?.guidance);
  const isWork = !epic && (task?.kind ?? 'work') === 'work';
  const badJobs = d.badJobs ?? [];
  // Phương án nên chọn (thường là "Làm tiếp") đứng đầu để bấm được ngay.
  const options = [...d.options].sort((a, b) => Number(b.action === d.recommended) - Number(a.action === d.recommended));
  const draftFiles = info.work?.files ?? [];

  return (
    <section className="failure" aria-label={heading}>
      <h3>{heading}: {d.title}</h3>
      <p className="why">{d.cause}</p>

      {badJobs.length > 0 && (
        <>
          <p><strong>Việc của team chưa đạt ({badJobs.length})</strong></p>
          <ul className="list-plain">
            {badJobs.map((j) => (
              <li key={j.id}>
                <button type="button" className="row" disabled={!onSelectJob} onClick={() => onSelectJob?.(j.id)}>
                  <span className="row-title">#{j.id} {j.title}</span>
                  <span className="row-sub">{j.lead}{j.error ? ` · ${j.error}` : ''}</span>
                  <span className={`chip job-${j.status}`}>Mở để cứu</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {info.evidence.length > 0 && (
        <details>
          <summary>Những dòng nhật ký cuối ({info.evidence.length})</summary>
          <ul className="evidence">
            {info.evidence.map((e, i) => (
              <li key={`${e.ts}:${i}`}><time>{formatClock(e.ts)}</time> {KIND_LABEL[e.kind] ?? e.kind}: {e.summary}</li>
            ))}
          </ul>
        </details>
      )}

      {draftFiles.length > 0 && (
        <p className="draft-line">
          <strong>Còn bài dở: {draftFiles.length} file</strong> trên nhánh <code>{info.work?.branch}</code>
          {' '}({draftFiles.slice(0, 4).join(', ')}{draftFiles.length > 4 ? ', …' : ''}). Chọn <strong>Làm tiếp</strong> để nhân viên hoàn thành phần còn lại, không phải làm lại từ đầu.
        </p>
      )}
      {info.work ? (
        <details>
          <summary>Phần nhân viên đã làm (nhánh {info.work.branch})</summary>
          {info.work.stat && <pre className="diff">{info.work.stat}</pre>}
          <pre className="diff">{info.work.patch || '(không có thay đổi)'}</pre>
          {info.work.truncated && <p className="muted">Đã cắt bớt. Xem đầy đủ bằng git diff trên nhánh này.</p>}
        </details>
      ) : (
        isWork && <p className="muted">Chưa có phần nào được lưu trên nhánh.</p>
      )}

      {!d.recoverable && d.blockedReason && <p className="notice">{d.blockedReason}</p>}
      {d.recoverable && d.reopensJob !== null && (
        <p className="notice">
          Việc lớn #{d.reopensJob} đã kết thúc. Khi bạn xử lý, việc lớn được mở lại; xong thì hệ thống gộp lại sang một nhánh mới (nhánh gộp cũ vẫn giữ).
        </p>
      )}
      {d.recoverable && d.reopensEpic && (
        <p className="notice">
          Yêu cầu #{d.reopensEpic.id} đã kết thúc. Khi bạn chạy lại, yêu cầu được mở lại và đi tiếp từ lượt này.
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {d.options.length > 0 && (
        <>
          <p><strong>Bạn muốn xử lý thế nào?</strong></p>
          <div className="options">
            {options.map((o) => (
              <button
                key={o.action}
                type="button"
                className={`${o.action === 'skip' ? 'secondary' : ''} ${o.action === d.recommended ? 'recommended' : ''} ${choice?.action === o.action ? 'chosen' : ''}`}
                disabled={busy}
                title={o.hint}
                onClick={() => setChoice(o)}
              >
                {o.label}{o.action === d.recommended ? ' (nên chọn)' : ''}
              </button>
            ))}
          </div>
        </>
      )}

      {choice && (
        <div className="confirm">
          <p>{choice.hint}</p>
          {wantsGuidance && (
            <label>
              Lời dặn thêm cho {who}{choice.guidance === 'recommended' ? ' (nên có)' : ' (không bắt buộc)'}
              <textarea
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder={isWork
                  ? 'Ví dụ: chỉ sửa file src/api.ts, đừng chạy toàn bộ test, đã có sẵn hàm formatDate ở utils.'
                  : 'Ví dụ: chia việc thành 2 phần, phần giao diện cho Frontend, phần API cho Backend; nhớ kết thúc bằng công cụ báo kết quả.'}
              />
            </label>
          )}
          <div className="actions">
            <button type="button" className={choice.action === 'skip' ? 'danger' : ''} disabled={busy} onClick={() => void run()}>
              {busy ? 'Đang xử lý…' : `Xác nhận: ${choice.label}`}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setChoice(null)}>Hủy</button>
          </div>
        </div>
      )}
    </section>
  );
}
