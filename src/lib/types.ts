export type TaskStatus = 'queued' | 'running' | 'paused_quota' | 'waiting_answer' | 'submitted' | 'done' | 'failed' | 'stopped';

export type TaskKind = 'work' | 'plan' | 'review' | 'dplan' | 'dreview' | 'answer';

export type JobStatus = 'draft' | 'waiting' | 'planning' | 'running' | 'awaiting_choice' | 'integrating' | 'done' | 'attention' | 'failed' | 'stopped';

/** Thi đấu skill (xem server/contest.mjs). Chưa chọn thì không có tên người và bộ skill của từng phương án (chấm mù). */
export interface ContestOption {
  option: number;
  images: { page: string; src: string }[];
  shotError: string | null;
  changedFiles: number;
  member?: string;
  label?: string;
  skills?: string[];
  report?: string | null;
  winner?: boolean;
}

export interface ContestView {
  jobId: number;
  title: string;
  lead: string;
  jobStatus: JobStatus;
  status: 'splitting' | 'working' | 'capturing' | 'ready' | 'chosen';
  hasPreview: boolean;
  options: ContestOption[];
  sets?: Record<string, string[]>;
  winnerSkills?: string[];
}

export type EpicStatus =
  | 'planning' | 'awaiting_plan' | 'running' | 'integrating' | 'reviewing'
  | 'awaiting_result' | 'done' | 'attention' | 'failed' | 'stopped' | 'rejected';

export interface Epic {
  id: number;
  title: string;
  prompt: string;
  acceptance: string;
  director: string;
  status: EpicStatus;
  contract: string | null;
  plan_summary: string | null;
  plan_feedback: string | null;
  result_feedback: string | null;
  verdict: string | null;
  final_report: string | null;
  summary: string | null;
  error: string | null;
  base_commit: string | null;
  merge_branch: string | null;
  merge_worktree: string | null;
  conflict_files: string | null;
  plan_task_id: number | null;
  round: number;
  replans: number;
  created_at: number;
  finished_at: number | null;
}

export interface FeedEvent {
  id: number;
  task_id: number;
  ts: number;
  kind: string;
  summary: string;
  member: string;
  task_title: string;
  task_kind: TaskKind;
}

export interface WorkerLoad {
  name: string;
  title: string;
  model: string;
  strengths: string[];
  active: number;
  queued: number;
  free: number;
  cap: number;
  open: { id: number; title: string; status: string; job_id: number | null }[];
}

export interface TeamLoad {
  id: string;
  name: string;
  lead: string | null;
  workers: WorkerLoad[];
}

export interface Job {
  id: number;
  title: string;
  prompt: string;
  acceptance: string;
  team: string;
  lead: string;
  status: JobStatus;
  summary: string | null;
  error: string | null;
  base_commit: string | null;
  merge_branch: string | null;
  merge_worktree: string | null;
  conflict_files: string | null;
  plan_task_id: number | null;
  epic_id: number | null;
  depends_on: string | null;
  /** Có giá trị khi đây là việc thi đấu skill (JSON); xem ContestView để lấy dữ liệu cho giao diện. */
  contest?: string | null;
  round: number;
  created_at: number;
  finished_at: number | null;
}

export interface Task {
  id: number;
  title: string;
  prompt: string;
  acceptance: string;
  team: string;
  member: string;
  role: string;
  status: TaskStatus;
  model: string | null;
  effort: string | null;
  level: 'auto' | 'easy' | 'normal' | 'hard';
  level_source: 'auto' | 'user';
  level_reason: string | null;
  escalations: number;
  kind: TaskKind;
  job_id: number | null;
  epic_id: number | null;
  subject_id: number | null;
  revisions: number;
  review_feedback: string | null;
  failure_code: string | null;
  /** Engine đang/đã chạy việc này ("claude", "agy"...) và engine mà việc vừa được chuyển đi vì hết hạn mức. */
  engine?: string | null;
  handoff_from?: string | null;
  recoveries: number;
  auto_retries: number;
  /** Mã câu hỏi đang chờ chủ trả lời (ask_owner), null nếu không có. */
  ask_owner_id: number | null;
  files: string | null;
  verdict: string | null;
  session_id: string | null;
  worktree: string | null;
  branch: string | null;
  attempts: number;
  result: string | null;
  error: string | null;
  changed_files: string | null;
  turns: number;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  est_cost_usd: number;
  resume_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface TaskEvent {
  id: number;
  task_id: number;
  ts: number;
  kind: string;
  summary: string;
}

export interface Member {
  name: string;
  role: string;
  title: string;
  model: string;
  effort: string;
  strengths: string[];
  isLead: boolean;
}

export interface TeamLimits {
  max_active_per_member: number;
  max_queue_per_member: number;
  max_revisions: number;
  max_subtasks: number;
}

export interface TeamSummary {
  id: string;
  name: string;
  lead: string | null;
  limits?: TeamLimits;
  members: Member[];
}

export interface RateLimitWindow {
  utilization: number | null;
  resetsAt: number | null;
}

export interface RateLimit {
  status: string;
  blocked: boolean;
  type: string | null;
  resetsAt: number | null;
  windows: Record<string, RateLimitWindow>;
  seenAt: number;
}

/** Một engine AI (Claude Code, Antigravity...) như /api/engines trả về. */
export interface EngineInfo {
  id: string;
  label: string;
  /** Đã liên kết (đang dùng, xoay vòng) hay chưa. */
  linked: boolean;
  /** Thứ tự ưu tiên trong danh sách đã liên kết (0 là đầu); -1 nếu chưa liên kết. */
  order: number;
  installed: boolean;
  version: string | null;
  /** null = không rõ. */
  loggedIn: boolean | null;
  models: { id: string; label: string }[];
  /** Bậc model của công ty (haiku/sonnet/opus) thành model thật của engine này. */
  tiers: Record<string, string | null>;
  detail: string;
  capabilities: { mcp: boolean; maxTurns: boolean; triage: boolean };
  /** Giờ (ms) engine hết hạn mức tới lúc nào, 0 nếu đang dùng được. */
  blockedUntil: number;
}

export interface CompanyEngine {
  id: string;
  label: string;
  blockedUntil: number;
}

export interface CompanyState {
  engines?: CompanyEngine[];
  maxConcurrent: number;
  running: number[];
  queued: number;
  pausedUntil: number;
  pauseReason: string | null;
  manualPause: boolean;
  rateLimit: RateLimit | null;
}

export interface AppState {
  project: { name: string; root: string; hasProfile: boolean; stack: string[] };
  teams: TeamSummary[];
  company: CompanyState;
  configError: string | null;
}

// ---- Mẫu việc và việc định kỳ (giai đoạn 6) ----

export interface TemplateField {
  key: string;
  label: string;
  placeholder: string;
  required: boolean;
  multiline: boolean;
}

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  kind: 'epic' | 'job';
  team: string | null;
  fields: TemplateField[];
  source: 'builtin' | 'local';
}

export interface FilledTemplate {
  kind: 'epic' | 'job';
  team: string | null;
  title: string;
  prompt: string;
  acceptance: string;
}

export interface ScheduleRun {
  kind: 'epic' | 'job';
  id: number;
}

export interface Schedule {
  id: number;
  name: string;
  template: string;
  params: Record<string, string>;
  days: number[];
  at_time: string;
  enabled: boolean;
  max_per_day: number;
  runs_today: number;
  last_run_at: number | null;
  last_ref: ScheduleRun | null;
  last_error: string | null;
  open_run: (ScheduleRun & { status: string }) | null;
  next_run_at: number | null;
}

// ---- Báo cáo tuần ----

export interface ReportBucket {
  finished: number;
  work_done: number;
  work_failed: number;
  work_stopped: number;
  revisions: number;
  turns: number;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  est_cost_usd: number;
}

export interface WeeklyReport {
  week: string;
  next_week: string;
  current_week: string;
  from: number;
  to: number;
  total: ReportBucket;
  previous: ReportBucket & { week: string };
  teams: (ReportBucket & { id: string; name: string })[];
  members: (ReportBucket & { team: string; member: string; lead_runs: number; answers: number })[];
  jobs: { finished: number; by_status: Record<string, number> };
  epics: { finished: number; by_status: Record<string, number>; rework_rounds: number };
  quota: {
    samples: number;
    peak_five_hour: number | null;
    peak_seven_day: number | null;
    last_five_hour: number | null;
    last_seven_day: number | null;
    blocked_events: number;
  };
}

export type IntegrationState = 'not_ready' | 'missing' | 'integrated' | 'blocked' | 'conflict' | 'ready' | 'failed';

/** Kết quả xem trước "Đưa vào dự án" (GET /api/integrate/...). */
export interface IntegrationInfo {
  kind: 'task' | 'job' | 'epic';
  id: number;
  title: string | null;
  branch: string | null;
  target: string | null;
  state: IntegrationState;
  reason: string | null;
  files: string[];
  stat: string;
  conflictFiles: string[];
  dirtyFiles: string[];
  integration: { branch: string; target: string; commit_id: string | null; merged_at: number } | null;
}

export interface FailureOption {
  /** Hành động với việc/lượt: continue, raise, redo, accept, skip. Riêng yêu cầu còn có proceed (bỏ phần lỗi) và accept (vẫn nhận kết quả). */
  action: 'continue' | 'raise' | 'redo' | 'accept' | 'skip' | 'proceed';
  label: string;
  hint: string;
  /** Có nhận lời dặn thêm của chủ không: false, 'optional' hoặc 'recommended'. */
  guidance: false | 'optional' | 'recommended';
}

/** Chẩn đoán một việc bị lỗi và các phương án xử lý (GET /api/tasks/:id/recovery). */
export interface FailureInfo {
  diagnosis: {
    code: string;
    title: string;
    cause: string;
    recommended: FailureOption['action'] | null;
    hasWork: boolean;
    canResume: boolean;
    recoverable: boolean;
    blockedReason: string | null;
    /** Mã việc lớn đã kết luận sẽ được mở lại khi bạn xử lý việc này (null nếu không). */
    reopensJob: number | null;
    /** Yêu cầu đã kết luận sẽ được mở lại khi chạy lại lượt của Giám đốc (null nếu không). */
    reopensEpic: { id: number; kind: 'dplan' | 'dreview' } | null;
    options: FailureOption[];
    /** Chỉ có khi chẩn đoán một yêu cầu: các việc của team chưa đạt. */
    badJobs?: { id: number; title: string; status: string; lead: string; error: string | null }[];
  };
  evidence: { ts: number; kind: string; summary: string }[];
  work: { branch: string; stat: string; patch: string; truncated: boolean } | null;
}

/** Câu hỏi nhân viên gửi cho chủ công ty (GET /api/questions/:id). */
export interface OwnerQuestion {
  id: number;
  task_id: number;
  asker: string;
  text: string;
  status: 'open' | 'answered' | 'failed';
  answer: string | null;
  options: string[];
}
