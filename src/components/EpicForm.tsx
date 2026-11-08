'use client';

import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import type { Epic } from '@/lib/types';
import TemplatePicker from './TemplatePicker';

interface Props {
  disabled: boolean;
  onCreated: (epic: Epic) => void;
}

export default function EpicForm({ disabled, onCreated }: Props) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { epic } = await api<{ epic: Epic }>('/api/epics', { method: 'POST', body: { title, prompt, acceptance } });
      setTitle('');
      setPrompt('');
      setAcceptance('');
      onCreated(epic);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không giao được yêu cầu.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h2>Giao yêu cầu cho cả công ty</h2>
      <p className="muted">
        Giám đốc đọc code, chốt hợp đồng chung và chia việc cho từng team (Backend, Frontend, Chất lượng, DevOps, Thiết kế, Bảo mật, Báo cáo; team nào có trong cấu hình thì nhận việc). Bạn duyệt kế hoạch trước khi các team bắt đầu, và duyệt kết quả cuối cùng.
      </p>
      <TemplatePicker kind="epic" onFill={(f) => { setTitle(f.title); setPrompt(f.prompt); setAcceptance(f.acceptance); }} />
      <label>
        Tiêu đề
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Ví dụ: Đăng nhập bằng email" required />
      </label>
      <label>
        Mô tả yêu cầu
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} placeholder="Tính năng cần làm, ràng buộc, điều bạn muốn thấy khi xong." required />
      </label>
      <label>
        Tiêu chí hoàn thành <span className="muted">(không bắt buộc)</span>
        <textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} rows={3} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || disabled}>{busy ? 'Đang giao...' : 'Giao cho Giám đốc'}</button>
    </form>
  );
}
