import type { EpicStatus, JobStatus, TaskKind, TaskStatus } from './types';

export const EPIC_STATUS_LABEL: Record<EpicStatus, string> = {
  planning: 'Giám đốc đang lập kế hoạch',
  awaiting_plan: 'Chờ bạn duyệt kế hoạch',
  running: 'Các team đang làm',
  integrating: 'Đang ghép kết quả',
  reviewing: 'Giám đốc đang kiểm tra',
  awaiting_result: 'Chờ bạn duyệt kết quả',
  done: 'Hoàn thành',
  attention: 'Cần bạn xem',
  failed: 'Lỗi',
  stopped: 'Đã dừng',
  rejected: 'Bạn không duyệt',
};

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  draft: 'Nháp (chờ duyệt kế hoạch)',
  waiting: 'Chờ việc phụ thuộc',
  planning: 'Đang lập kế hoạch',
  running: 'Đang làm',
  awaiting_choice: 'Chờ bạn chọn bản',
  integrating: 'Đang gộp nhánh',
  done: 'Xong',
  attention: 'Cần bạn xem',
  failed: 'Lỗi',
  stopped: 'Đã dừng',
};

export const TASK_KIND_LABEL: Record<TaskKind, string> = {
  work: 'Làm việc',
  plan: 'Lập kế hoạch',
  review: 'Duyệt bài',
  dplan: 'Giám đốc lập kế hoạch',
  dreview: 'Giám đốc kiểm tra',
  answer: 'Trả lời câu hỏi',
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'Đang chờ',
  running: 'Đang làm',
  paused_quota: 'Chờ hạn mức',
  waiting_answer: 'Chờ trả lời',
  submitted: 'Chờ duyệt',
  done: 'Xong',
  failed: 'Lỗi',
  stopped: 'Đã dừng',
};

export const LEVEL_LABEL: Record<string, string> = {
  auto: 'Đang đánh giá',
  easy: 'Đơn giản',
  normal: 'Bình thường',
  hard: 'Khó',
};

export const KIND_LABEL: Record<string, string> = {
  job: 'Việc lớn',
  review: 'Duyệt bài',
  question: 'Câu hỏi',
  answer: 'Trả lời',
  triage: 'Độ khó',
  escalate: 'Nâng bậc',
  recover: 'Chủ quyết',
  system: 'Hệ thống',
  start: 'Bắt đầu',
  say: 'Nói',
  tool: 'Dùng công cụ',
  tool_result: 'Kết quả',
  tool_error: 'Công cụ lỗi',
  quota: 'Hạn mức',
  warn: 'Cảnh báo',
  error: 'Lỗi',
  done: 'Hoàn thành',
  stopped: 'Dừng',
  raw: 'Khác',
};

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} phút ${s} giây` : `${s} giây`;
}

export function formatCountdown(untilMs: number, nowMs: number): string {
  const total = Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function windowLabel(name: string): string {
  if (name === 'five_hour') return 'Khung 5 giờ';
  if (name === 'seven_day') return 'Khung 7 ngày';
  return name;
}

/** "vừa xong", "5 phút trước", "3 giờ trước", "hôm qua 14:20", "08/11 09:15". */
export function formatAgo(ts: number, now: number): string {
  if (!now) return '';
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return 'vừa xong';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} phút trước`;
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const time = new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  if (ts >= day.getTime()) return `${Math.floor(diff / 3_600_000)} giờ trước`;
  day.setDate(day.getDate() - 1);
  if (ts >= day.getTime()) return `hôm qua ${time}`;
  return `${new Date(ts).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })} ${time}`;
}
