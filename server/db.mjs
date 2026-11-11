import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  acceptance TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL,
  member TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  session_id TEXT,
  worktree TEXT,
  branch TEXT,
  base_commit TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  changed_files TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0,
  resume_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  raw TEXT
);
CREATE INDEX IF NOT EXISTS events_task ON events (task_id, id);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  acceptance TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL,
  lead TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  error TEXT,
  base_commit TEXT,
  merge_branch TEXT,
  merge_worktree TEXT,
  conflict_files TEXT,
  plan_task_id INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS epics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  acceptance TEXT NOT NULL DEFAULT '',
  director TEXT NOT NULL,
  status TEXT NOT NULL,
  contract TEXT,
  plan_summary TEXT,
  plan_feedback TEXT,
  result_feedback TEXT,
  verdict TEXT,
  final_report TEXT,
  summary TEXT,
  error TEXT,
  base_commit TEXT,
  merge_branch TEXT,
  merge_worktree TEXT,
  conflict_files TEXT,
  plan_task_id INTEGER,
  round INTEGER NOT NULL DEFAULT 0,
  replans INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS company_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_finished ON tasks (finished_at);
CREATE TABLE IF NOT EXISTS quota_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  five_hour REAL,
  seven_day REAL,
  status TEXT NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS quota_samples_ts ON quota_samples (ts);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  kind TEXT NOT NULL,
  asker TEXT NOT NULL,
  target TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  answer_task_id INTEGER,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS questions_task ON questions (task_id);
CREATE INDEX IF NOT EXISTS questions_answer_task ON questions (answer_task_id);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
  at_time TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  max_per_day INTEGER NOT NULL DEFAULT 2,
  runs_day TEXT,
  runs_today INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_ref TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  epoch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  agent TEXT
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  session_hash TEXT,
  agent TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_session ON push_subscriptions (session_hash);
CREATE TABLE IF NOT EXISTS integrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  branch TEXT NOT NULL,
  target TEXT NOT NULL,
  commit_id TEXT,
  merged_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS integrations_ref ON integrations (kind, ref_id);
`;

// Cột thêm sau này: chạy ALTER TABLE nếu cơ sở dữ liệu cũ chưa có.
const EXTRA_COLUMNS = [
  ['level', "TEXT NOT NULL DEFAULT 'normal'"],
  ['level_source', "TEXT NOT NULL DEFAULT 'user'"],
  ['level_reason', 'TEXT'],
  ['escalations', 'INTEGER NOT NULL DEFAULT 0'],
  // Giai đoạn 2: việc lớn do Trưởng nhóm chia. kind: work | plan | review.
  ['kind', "TEXT NOT NULL DEFAULT 'work'"],
  ['job_id', 'INTEGER'],
  ['subject_id', 'INTEGER'],
  ['revisions', 'INTEGER NOT NULL DEFAULT 0'],
  ['review_feedback', 'TEXT'],
  ['files', 'TEXT'],
  ['verdict', 'TEXT'],
  // Giai đoạn 3: lượt làm việc của Giám đốc (kind: dplan | dreview) thuộc một yêu cầu (epic).
  ['epic_id', 'INTEGER'],
  // Xử lý việc lỗi: mã lỗi (xem diagnose.mjs), lời dặn của chủ cho lần làm tiếp, số lần chủ đã cho làm tiếp/làm lại.
  ['failure_code', 'TEXT'],
  ['owner_guidance', 'TEXT'],
  ['recoveries', 'INTEGER NOT NULL DEFAULT 0'],
  ['auto_retries', 'INTEGER NOT NULL DEFAULT 0'],
  // Câu hỏi đang chờ chính chủ trả lời (mã trong bảng questions), null nếu không có.
  ['ask_owner_id', 'INTEGER'],
  // Thi đấu skill: bộ skill riêng của việc này (JSON, mảng tên skill), đè lên skill mặc định của vai trò.
  ['skill_set', 'TEXT'],
  // Nhiều engine (xoay vòng): engine đang/đã chạy việc này (mã phiên chỉ có nghĩa với engine đó) và engine bị dừng vì hết hạn mức
  // mà việc vừa được chuyển đi (để dặn bàn giao trong lời nhắc).
  ['engine', 'TEXT'],
  ['handoff_from', 'TEXT'],
];

// Cột thêm cho bảng jobs ở giai đoạn 3: việc lớn của team nằm trong một yêu cầu, có thể phụ thuộc việc khác.
const JOB_EXTRA_COLUMNS = [
  ['epic_id', 'INTEGER'],
  ['depends_on', 'TEXT'],
  ['base_ref', 'TEXT'],
  ['base_dir', 'TEXT'],
  ['round', 'INTEGER NOT NULL DEFAULT 0'],
  // Thi đấu skill (JSON): hai bộ skill, hai bài dự thi, ảnh chụp và kết quả chọn. Xem contest.mjs.
  ['contest', 'TEXT'],
];

const SCHEDULE_COLUMNS = new Set([
  'name', 'params', 'days', 'at_time', 'enabled', 'max_per_day', 'runs_day', 'runs_today', 'last_run_at', 'last_ref', 'last_error',
]);

const EPIC_COLUMNS = new Set([
  'status', 'contract', 'plan_summary', 'plan_feedback', 'result_feedback', 'verdict', 'final_report', 'summary',
  'error', 'merge_branch', 'merge_worktree', 'conflict_files', 'plan_task_id', 'round', 'replans', 'finished_at',
]);

const JOB_COLUMNS = new Set([
  'prompt', 'depends_on', 'base_ref', 'base_dir', 'status', 'summary', 'error', 'base_commit', 'merge_branch', 'merge_worktree', 'conflict_files',
  'plan_task_id', 'finished_at', 'contest',
]);

const QUESTION_COLUMNS = new Set(['status', 'answer', 'answer_task_id', 'delivered', 'answered_at']);

// Việc đang chiếm chỗ trong hàng đợi của một nhân viên (đã nộp bài chờ duyệt thì không tính).
// Việc đang chờ câu trả lời vẫn là cam kết của người đó nên vẫn tính, để Trưởng nhóm không giao quá tải.
const LOAD_STATUSES = ['queued', 'running', 'paused_quota', 'waiting_answer'];

function migrate(db) {
  const have = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name));
  for (const [name, definition] of EXTRA_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
  }
  const haveQuestions = new Set(db.prepare('PRAGMA table_info(questions)').all().map((row) => row.name));
  // Phương án gợi ý (JSON) khi nhân viên hỏi chủ công ty.
  if (!haveQuestions.has('options')) db.exec('ALTER TABLE questions ADD COLUMN options TEXT');
  const haveJobs = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((row) => row.name));
  for (const [name, definition] of JOB_EXTRA_COLUMNS) {
    if (!haveJobs.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
  }
}

const TASK_COLUMNS = new Set([
  'level', 'level_source', 'level_reason', 'escalations', 'revisions', 'review_feedback', 'files', 'verdict', 'epic_id',
  'failure_code', 'owner_guidance', 'recoveries', 'auto_retries', 'ask_owner_id', 'engine', 'handoff_from',
  'status', 'model', 'effort', 'session_id', 'worktree', 'branch', 'base_commit', 'attempts', 'result',
  'error', 'changed_files', 'turns', 'duration_ms', 'input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_creation_tokens', 'est_cost_usd', 'resume_at', 'started_at', 'finished_at',
]);

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  createTask({
    title, prompt, acceptance = '', team, member, role, model, effort, level = 'normal', levelSource = 'user',
    kind = 'work', jobId = null, subjectId = null, files = null, epicId = null, skillSet = null,
  }) {
    const info = this.db
      .prepare(
        `INSERT INTO tasks (title, prompt, acceptance, team, member, role, status, model, effort, level, level_source,
                            kind, job_id, subject_id, files, epic_id, skill_set, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        title, prompt, acceptance, team, member, role, model ?? null, effort ?? null, level, levelSource,
        kind, jobId, subjectId, files ? JSON.stringify(files) : null, epicId, skillSet ? JSON.stringify(skillSet) : null, Date.now(),
      );
    return this.getTask(Number(info.lastInsertRowid));
  }

  // ---- Việc lớn (job) và tải của từng nhân viên ----

  createJob({
    title, prompt, acceptance = '', team, lead, baseCommit = null,
    epicId = null, dependsOn = null, baseRef = null, baseDir = null, round = 0, status = 'planning', contest = null,
  }) {
    const info = this.db
      .prepare(
        `INSERT INTO jobs (title, prompt, acceptance, team, lead, status, base_commit, epic_id, depends_on, base_ref, base_dir, round, contest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        title, prompt, acceptance, team, lead, status, baseCommit, epicId,
        dependsOn ? JSON.stringify(dependsOn) : null, baseRef, baseDir, round, contest ? JSON.stringify(contest) : null, Date.now(),
      );
    return this.getJob(Number(info.lastInsertRowid));
  }

  // ---- Yêu cầu của chủ giao cho cả công ty (epic) ----

  createEpic({ title, prompt, acceptance = '', director, baseCommit = null }) {
    const info = this.db
      .prepare(
        `INSERT INTO epics (title, prompt, acceptance, director, status, base_commit, created_at)
         VALUES (?, ?, ?, ?, 'planning', ?, ?)`,
      )
      .run(title, prompt, acceptance, director, baseCommit, Date.now());
    return this.getEpic(Number(info.lastInsertRowid));
  }

  // ---- Báo cáo ----

  /**
   * Ghi một mẫu mức dùng hạn mức cho báo cáo tuần. Chỉ ghi khi đã qua `minGapMs` kể từ mẫu trước, hoặc khi trạng thái bị chặn đổi
   * (để không bỏ sót lúc chạm trần mà cũng không ghi mỗi sự kiện). Trả về true nếu có ghi.
   */
  recordQuotaSample({ windows = {}, status = 'unknown', blocked = false }, now = Date.now(), minGapMs = 10 * 60_000) {
    const last = this.db.prepare('SELECT ts, status, blocked FROM quota_samples ORDER BY id DESC LIMIT 1').get();
    const changed = last && (Boolean(last.blocked) !== Boolean(blocked) || (blocked && last.status !== status));
    if (last && !changed && now - last.ts < minGapMs) return false;
    const frac = (name) => (typeof windows[name]?.utilization === 'number' ? windows[name].utilization : null);
    this.db
      .prepare('INSERT INTO quota_samples (ts, five_hour, seven_day, status, blocked) VALUES (?, ?, ?, ?, ?)')
      .run(now, frac('five_hour'), frac('seven_day'), String(status), blocked ? 1 : 0);
    return true;
  }

  quotaSamplesBetween(from, to) {
    return this.db.prepare('SELECT * FROM quota_samples WHERE ts >= ? AND ts < ? ORDER BY ts ASC').all(from, to);
  }

  tasksFinishedBetween(from, to) {
    return this.db
      .prepare(
        `SELECT id, team, member, kind, status, level, revisions, turns, duration_ms, input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens, est_cost_usd, finished_at
         FROM tasks WHERE finished_at >= ? AND finished_at < ? ORDER BY finished_at ASC`,
      )
      .all(from, to);
  }

  jobsFinishedBetween(from, to) {
    return this.db.prepare('SELECT id, team, status, epic_id, created_at, finished_at FROM jobs WHERE finished_at >= ? AND finished_at < ?').all(from, to);
  }

  epicsFinishedBetween(from, to) {
    return this.db.prepare('SELECT id, status, round, created_at, finished_at FROM epics WHERE finished_at >= ? AND finished_at < ?').all(from, to);
  }

  countEventsBetween(kind, from, to) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ? AND ts >= ? AND ts < ?').get(kind, from, to).n;
  }

  // ---- Câu hỏi giữa các nhân viên ----

  createQuestion({ taskId, round, kind, asker, target, text, answerTaskId = null, options = null }) {
    const info = this.db
      .prepare('INSERT INTO questions (task_id, round, kind, asker, target, text, answer_task_id, options, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, round, kind, asker, target, text, answerTaskId, options?.length ? JSON.stringify(options) : null, Date.now());
    return this.getQuestion(Number(info.lastInsertRowid));
  }

  getQuestion(id) {
    return this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) ?? null;
  }

  /** Mọi dòng câu hỏi của một việc (một cuộc họp có nhiều dòng cùng `round`). */
  questionsOf(taskId) {
    return this.db.prepare('SELECT * FROM questions WHERE task_id = ? ORDER BY id ASC').all(taskId);
  }

  /** Số lần đã hỏi (mỗi lần hỏi hoặc mỗi cuộc họp tính một) của một việc. */
  questionRounds(taskId) {
    return this.db.prepare('SELECT COALESCE(MAX(round), 0) AS n FROM questions WHERE task_id = ?').get(taskId).n;
  }

  /** Câu hỏi chưa có kết cục. Không truyền `taskId` thì lấy của mọi việc. */
  openQuestions(taskId = null) {
    return taskId === null
      ? this.db.prepare("SELECT * FROM questions WHERE status = 'open' ORDER BY id ASC").all()
      : this.db.prepare("SELECT * FROM questions WHERE task_id = ? AND status = 'open' ORDER BY id ASC").all(taskId);
  }

  questionByAnswerTask(answerTaskId) {
    return this.db.prepare('SELECT * FROM questions WHERE answer_task_id = ?').get(answerTaskId) ?? null;
  }

  recentQuestions(limit = 100) {
    return this.db.prepare('SELECT * FROM questions ORDER BY id DESC LIMIT ?').all(limit);
  }

  updateQuestion(id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return this.getQuestion(id);
    for (const key of keys) {
      if (!QUESTION_COLUMNS.has(key)) throw new Error(`Cột câu hỏi không hợp lệ: ${key}`);
    }
    const sets = keys.map((key) => `${key} = ?`).join(', ');
    this.db.prepare(`UPDATE questions SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    return this.getQuestion(id);
  }

  // ---- Việc định kỳ ----

  createSchedule({ name, template, params = {}, days = [1, 2, 3, 4, 5], atTime, maxPerDay = 2 }) {
    const info = this.db
      .prepare('INSERT INTO schedules (name, template, params, days, at_time, enabled, max_per_day, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
      .run(name, template, JSON.stringify(params), JSON.stringify(days), atTime, maxPerDay, Date.now());
    return this.getSchedule(Number(info.lastInsertRowid));
  }

  getSchedule(id) {
    return this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) ?? null;
  }

  listSchedules() {
    return this.db.prepare('SELECT * FROM schedules ORDER BY id ASC').all();
  }

  updateSchedule(id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return this.getSchedule(id);
    for (const key of keys) {
      if (!SCHEDULE_COLUMNS.has(key)) throw new Error(`Cột lịch không hợp lệ: ${key}`);
    }
    const sets = keys.map((key) => `${key} = ?`).join(', ');
    this.db.prepare(`UPDATE schedules SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    return this.getSchedule(id);
  }

  deleteSchedule(id) {
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  }

  // ---- Phiên đăng nhập từ xa (chỉ lưu băm của mã phiên, nên lộ cơ sở dữ liệu cũng không dùng lại được) ----

  createSession({ tokenHash, epoch, now, expiresAt, agent = null }) {
    this.db
      .prepare('INSERT INTO sessions (token_hash, epoch, created_at, expires_at, last_seen, agent) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tokenHash, epoch, now, expiresAt, now, agent);
  }

  getSession(tokenHash) {
    return this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) ?? null;
  }

  touchSession(tokenHash, now) {
    this.db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, tokenHash);
  }

  deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteAllSessions() {
    this.db.prepare('DELETE FROM sessions').run();
  }

  /** Xóa phiên hết hạn, rồi giữ tối đa `max` phiên mới nhất. */
  pruneSessions(now, max = 20) {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db
      .prepare('DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM sessions ORDER BY created_at DESC LIMIT ?)')
      .run(max);
  }

  countSessions() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  }

  // ---- Thiết bị nhận thông báo đẩy ----

  savePushSubscription({ endpoint, p256dh, auth, sessionHash = null, agent = null, now }) {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, session_hash, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, session_hash = excluded.session_hash,
           agent = excluded.agent, fail_count = 0`,
      )
      .run(endpoint, p256dh, auth, sessionHash, agent, now);
  }

  getPushSubscription(endpoint) {
    return this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) ?? null;
  }

  listPushSubscriptions() {
    return this.db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all();
  }

  countPushSubscriptions() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n;
  }

  deletePushSubscription(endpoint) {
    return this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0;
  }

  deletePushBySession(sessionHash) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE session_hash = ?').run(sessionHash);
  }

  deleteAllPushSubscriptions() {
    this.db.prepare('DELETE FROM push_subscriptions').run();
  }

  /** Ghi kết quả một lần gửi; trả về số lần lỗi liên tiếp hiện tại. */
  markPushResult(endpoint, { ok, now }) {
    if (ok) this.db.prepare('UPDATE push_subscriptions SET fail_count = 0, last_ok_at = ? WHERE endpoint = ?').run(now, endpoint);
    else this.db.prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE endpoint = ?').run(endpoint);
    return this.db.prepare('SELECT fail_count FROM push_subscriptions WHERE endpoint = ?').get(endpoint)?.fail_count ?? 0;
  }

  /** Ghi lại một lần người dùng đưa kết quả vào dự án (gộp nhánh công ty vào nhánh đang làm việc). */
  addIntegration({ kind, refId, branch, target, commitId, now = Date.now() }) {
    this.db
      .prepare('INSERT INTO integrations (kind, ref_id, branch, target, commit_id, merged_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(kind, refId, branch, target, commitId ?? null, now);
  }

  lastIntegration(kind, refId) {
    return this.db.prepare('SELECT * FROM integrations WHERE kind = ? AND ref_id = ? ORDER BY id DESC LIMIT 1').get(kind, refId) ?? null;
  }

  getEpic(id) {
    return this.db.prepare('SELECT * FROM epics WHERE id = ?').get(id) ?? null;
  }

  listEpics(limit = 50) {
    return this.db.prepare('SELECT * FROM epics ORDER BY id DESC LIMIT ?').all(limit);
  }

  updateEpic(id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return this.getEpic(id);
    for (const key of keys) {
      if (!EPIC_COLUMNS.has(key)) throw new Error(`Cột yêu cầu không hợp lệ: ${key}`);
    }
    const sets = keys.map((key) => `${key} = ?`).join(', ');
    this.db.prepare(`UPDATE epics SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    return this.getEpic(id);
  }

  /** Xóa các việc của team chưa bắt đầu (nháp, chờ phụ thuộc) khi kế hoạch bị từ chối. */
  deleteUnstartedJobs(epicId) {
    this.db.prepare("DELETE FROM jobs WHERE epic_id = ? AND status IN ('draft', 'waiting')").run(epicId);
  }

  epicJobs(epicId) {
    return this.db.prepare('SELECT * FROM jobs WHERE epic_id = ? ORDER BY id ASC').all(epicId);
  }

  epicTasks(epicId) {
    return this.db.prepare('SELECT * FROM tasks WHERE epic_id = ? ORDER BY id ASC').all(epicId);
  }

  /** Các sự kiện đáng chú ý gần đây của mọi việc, mới nhất trước: dùng cho "nhật ký hội thoại" giữa các tầng. */
  recentFeed(kinds, limit = 100) {
    const marks = kinds.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT e.id, e.task_id, e.ts, e.kind, e.summary, t.member, t.title AS task_title, t.kind AS task_kind
         FROM events e JOIN tasks t ON t.id = e.task_id
         WHERE e.kind IN (${marks}) OR (e.kind = 'tool' AND e.summary LIKE 'mcp__company__%' AND e.summary NOT LIKE 'mcp__company__ask%' AND e.summary NOT LIKE 'mcp__company__call_meeting%')
         ORDER BY e.id DESC LIMIT ?`,
      )
      .all(...kinds, limit);
  }

  getJob(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
  }

  listJobs(limit = 50) {
    return this.db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit);
  }

  updateJob(id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return this.getJob(id);
    for (const key of keys) {
      if (!JOB_COLUMNS.has(key)) throw new Error(`Cột việc lớn không hợp lệ: ${key}`);
    }
    const sets = keys.map((key) => `${key} = ?`).join(', ');
    this.db.prepare(`UPDATE jobs SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    return this.getJob(id);
  }

  jobTasks(jobId) {
    return this.db.prepare('SELECT * FROM tasks WHERE job_id = ? ORDER BY id ASC').all(jobId);
  }

  /** Các việc "làm" đang chiếm chỗ của một nhân viên (đang chạy, đang chờ, đang chờ hạn mức). */
  openLoad(member) {
    const marks = LOAD_STATUSES.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT id, title, status, job_id FROM tasks WHERE member = ? AND kind = 'work' AND status IN (${marks}) ORDER BY id`)
      .all(member, ...LOAD_STATUSES);
  }

  getTask(id) {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? null;
  }

  listTasks(limit = 100) {
    return this.db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT ?').all(limit);
  }

  tasksByStatus(...statuses) {
    const marks = statuses.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM tasks WHERE status IN (${marks}) ORDER BY id ASC`).all(...statuses);
  }

  updateTask(id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return this.getTask(id);
    for (const key of keys) {
      if (!TASK_COLUMNS.has(key)) throw new Error(`Cột không hợp lệ: ${key}`);
    }
    const sets = keys.map((key) => `${key} = ?`).join(', ');
    this.db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    return this.getTask(id);
  }

  addEvent(taskId, kind, summary = '', raw = null) {
    const ts = Date.now();
    const info = this.db
      .prepare('INSERT INTO events (task_id, ts, kind, summary, raw) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, ts, kind, summary, raw);
    return { id: Number(info.lastInsertRowid), task_id: taskId, ts, kind, summary };
  }

  listEvents(taskId, { afterId = 0, limit = 1000 } = {}) {
    return this.db
      .prepare('SELECT id, task_id, ts, kind, summary FROM events WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(taskId, afterId, limit);
  }

  getRawEvent(eventId) {
    return this.db.prepare('SELECT raw FROM events WHERE id = ?').get(eventId)?.raw ?? null;
  }

  setState(key, value) {
    this.db
      .prepare('INSERT INTO company_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  getState(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM company_state WHERE key = ?').get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }
}
