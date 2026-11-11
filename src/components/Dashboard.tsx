'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, reloadForLogin } from '@/lib/api';
import { EPIC_STATUS_LABEL, JOB_STATUS_LABEL } from '@/lib/format';
import { chime, newKeys, notifyMessage, readNotifyMode, readSoundPreference, titleFor, writeNotifyMode, writeSoundPreference, type NotifyMode } from '@/lib/notify';
import { disableNotifications, enableNotifications, notificationsSupported, resyncPush, showLocalNotification } from '@/lib/push';
import { ownerRequests } from '@/office/status';
import { setTheme, useTheme } from '@/lib/theme';
import type { AppState, CompanyState, EngineInfo, Epic, Job, Task, TaskEvent } from '@/lib/types';
import Board from './Board';
import EpicDetail from './EpicDetail';
import EnginesPanel from './EnginesPanel';
import EpicForm from './EpicForm';
import FeedPanel from './FeedPanel';
import JobDetail from './JobDetail';
import JobForm from './JobForm';
import QuotaPanel from './QuotaPanel';
import Report from './Report';
import Schedules from './Schedules';
import TaskDetail from './TaskDetail';
import TaskForm from './TaskForm';
import TeamLoadPanel from './TeamLoadPanel';
import WorkPanel, { type Crumb } from './WorkPanel';
import { Drawer, Icon, Overlay, type IconName } from './ui';

// Cảnh 3D chỉ chạy ở trình duyệt và khá nặng (three.js) nên chỉ tải khi bạn mở tab này.
const Office3D = dynamic(() => import('./Office3D'), {
  ssr: false,
  loading: () => <div className="stage-loading" role="status">Đang tải văn phòng 3D...</div>,
});

const MAX_EVENTS_PER_TASK = 600;

function upsertById<T extends { id: number }>(list: T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id);
  if (index < 0) return [item, ...list].sort((a, b) => b.id - a.id);
  const next = list.slice();
  next[index] = item;
  return next;
}

function mergeEvents(a: TaskEvent[], b: TaskEvent[]): TaskEvent[] {
  const byId = new Map<number, TaskEvent>();
  for (const e of [...a, ...b]) byId.set(e.id, e);
  return [...byId.values()].sort((x, y) => x.id - y.id).slice(-MAX_EVENTS_PER_TASK);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Có lỗi xảy ra.';
}

type Mode = 'epic' | 'job' | 'task';
type Panel = 'work' | 'board' | 'load' | 'schedules' | 'report' | 'usage' | 'engines' | null;
type EpicAction = 'approve-plan' | 'reject-plan' | 'approve-result' | 'reject-result' | 'stop';

const NAV: { id: Exclude<Panel, null>; label: string; icon: IconName }[] = [
  { id: 'work', label: 'Công việc', icon: 'work' },
  { id: 'board', label: 'Bảng kanban', icon: 'board' },
  { id: 'load', label: 'Tải của team', icon: 'users' },
  { id: 'schedules', label: 'Mẫu & lịch', icon: 'calendar' },
  { id: 'report', label: 'Báo cáo', icon: 'report' },
  { id: 'usage', label: 'Mức dùng', icon: 'gauge' },
  { id: 'engines', label: 'Liên kết AI', icon: 'link' },
];

export default function Dashboard() {
  const [app, setApp] = useState<AppState | null>(null);
  const [company, setCompany] = useState<CompanyState | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [epics, setEpics] = useState<Epic[]>([]);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [adding, setAdding] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);
  const [needsOpen, setNeedsOpen] = useState(false);
  const [barOpen, setBarOpen] = useState(false);
  const [stopArmed, setStopArmed] = useState(false);
  const barRef = useRef<HTMLElement>(null);
  const theme = useTheme();
  const [mode, setMode] = useState<Mode>('epic');
  const [selectedEpicId, setSelectedEpicId] = useState<number | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [eventsByTask, setEventsByTask] = useState<Record<number, TaskEvent[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(0);
  const [sound, setSound] = useState(true);
  const [remote, setRemote] = useState(false);
  const [notifyMode, setNotifyMode] = useState<NotifyMode>('off');
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [notifyNote, setNotifyNote] = useState<string | null>(null);
  const seenRequests = useRef<Set<string> | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  // Nút Dừng tất cả cần bấm hai lần; không bấm lần hai trong vài giây thì tự thôi.
  useEffect(() => {
    if (!stopArmed) return undefined;
    const timer = setTimeout(() => setStopArmed(false), 3500);
    return () => clearTimeout(timer);
  }, [stopArmed]);

  // Thanh công cụ mở bằng chạm (điện thoại) thì bấm ra ngoài là đóng.
  useEffect(() => {
    if (!barOpen) return undefined;
    const close = (e: PointerEvent) => {
      const target = e.target as Node;
      if (barRef.current?.contains(target) || (target as HTMLElement).closest?.('.edge')) return;
      setBarOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [barOpen]);

  useEffect(() => {
    const timer = setTimeout(() => setSound(readSoundPreference()), 0);
    return () => clearTimeout(timer);
  }, []);

  // Thông báo: nhớ lựa chọn của thiết bị này. Chế độ đẩy thì đăng ký lại với máy chủ (phiên đăng nhập có thể đã đổi); quyền bị thu hồi thì về chế độ tắt.
  useEffect(() => {
    const timer = setTimeout(() => {
      const mode = readNotifyMode();
      const off = () => {
        writeNotifyMode('off');
        setNotifyMode('off');
      };
      if (mode === 'off') return;
      if (!notificationsSupported() || Notification.permission !== 'granted') return off();
      setNotifyMode(mode);
      if (mode === 'push') void resyncPush().then((ok) => { if (!ok) off(); });
      return undefined;
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const toggleNotify = useCallback(async () => {
    setNotifyBusy(true);
    setNotifyNote(null);
    try {
      if (notifyMode === 'off') {
        const result = await enableNotifications();
        writeNotifyMode(result.mode);
        setNotifyMode(result.mode);
        setNotifyNote(result.note);
      } else {
        await disableNotifications();
        writeNotifyMode('off');
        setNotifyMode('off');
      }
    } catch (err) {
      setNotifyNote(errorText(err));
    } finally {
      setNotifyBusy(false);
    }
  }, [notifyMode]);

  const testNotify = useCallback(async () => {
    setNotifyBusy(true);
    setNotifyNote(null);
    try {
      const result = await api<{ sent: number; removed: number; failed: number }>('/api/push/test', { method: 'POST' });
      setNotifyNote(result.sent > 0 ? `Đã gửi thử tới ${result.sent} thiết bị.` : 'Không gửi được tới thiết bị nào. Tắt rồi bật lại thông báo để đăng ký lại.');
    } catch (err) {
      setNotifyNote(errorText(err));
    } finally {
      setNotifyBusy(false);
    }
  }, []);

  // Đang vào qua cổng từ xa (có PIN)? Khi đó hiện nút Đăng xuất.
  useEffect(() => {
    let alive = true;
    api<{ remote: boolean }>('/api/me').then((me) => alive && setRemote(me.remote)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } finally {
      window.location.reload();
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [state, list, jobList, epicList] = await Promise.all([
        api<AppState>('/api/state'),
        api<{ tasks: Task[] }>('/api/tasks'),
        api<{ jobs: Job[] }>('/api/jobs'),
        api<{ epics: Epic[] }>('/api/epics'),
      ]);
      setApp(state);
      setCompany(state.company);
      setTasks(list.tasks);
      setJobs(jobList.jobs);
      setEpics(epicList.epics);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  // Các AI đã liên kết và model thật của chúng (hiện trong văn phòng, form giao việc, trang Liên kết AI). Không có thì UI vẫn chạy như cũ.
  const loadEngines = useCallback(async (fresh = false) => {
    const data = await api<{ engines: EngineInfo[] }>(`/api/engines${fresh ? '?refresh=1' : ''}`);
    setEngines(data.engines);
  }, []);
  useEffect(() => {
    const first = setTimeout(() => void loadEngines().catch(() => {}), 0);
    const again = setInterval(() => void loadEngines().catch(() => {}), 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(again);
    };
  }, [loadEngines]);

  useEffect(() => {
    const source = new EventSource('/api/stream');
    let wasDown = false;
    source.onopen = () => {
      setConnected(true);
      if (wasDown) void refresh();
      wasDown = false;
    };
    source.onerror = () => {
      wasDown = true;
      setConnected(false);
      // EventSource không cho biết mã lỗi: hỏi thử /api/me, nếu phiên đã hết hạn thì về trang đăng nhập.
      fetch('/api/me', { cache: 'no-store' }).then((res) => { if (res.status === 401) reloadForLogin(); }).catch(() => {});
    };
    const parse = <T,>(e: Event) => JSON.parse((e as MessageEvent<string>).data) as T;
    source.addEventListener('state', (e) => setCompany(parse<CompanyState>(e)));
    source.addEventListener('task', (e) => {
      const task = parse<Task>(e);
      setTasks((prev) => upsertById(prev, task));
    });
    source.addEventListener('job', (e) => {
      const job = parse<Job>(e);
      setJobs((prev) => upsertById(prev, job));
    });
    source.addEventListener('epic', (e) => {
      const epic = parse<Epic>(e);
      setEpics((prev) => upsertById(prev, epic));
    });
    source.addEventListener('event', (e) => {
      const event = parse<TaskEvent>(e);
      setEventsByTask((prev) => ({ ...prev, [event.task_id]: mergeEvents(prev[event.task_id] ?? [], [event]) }));
    });
    return () => source.close();
  }, [refresh]);

  const selectTask = useCallback(async (id: number) => {
    setSelectedTaskId(id);
    try {
      const data = await api<{ task: Task; events: TaskEvent[] }>(`/api/tasks/${id}`);
      setEventsByTask((prev) => ({ ...prev, [id]: mergeEvents(data.events, prev[id] ?? []) }));
      setTasks((prev) => upsertById(prev, data.task));
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  const selectJob = useCallback(async (id: number, keepEpic = false) => {
    setSelectedJobId(id);
    setSelectedTaskId(null);
    if (!keepEpic) setSelectedEpicId(null);
    try {
      const data = await api<{ job: Job; tasks: Task[] }>(`/api/jobs/${id}`);
      setJobs((prev) => upsertById(prev, data.job));
      setTasks((prev) => data.tasks.reduce((list, t) => upsertById(list, t), prev));
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  const selectEpic = useCallback(async (id: number) => {
    setSelectedEpicId(id);
    setSelectedJobId(null);
    setSelectedTaskId(null);
    try {
      const data = await api<{ epic: Epic; jobs: Job[]; tasks: Task[] }>(`/api/epics/${id}`);
      setEpics((prev) => upsertById(prev, data.epic));
      setJobs((prev) => data.jobs.reduce((list, j) => upsertById(list, j), prev));
      setTasks((prev) => data.tasks.reduce((list, t) => upsertById(list, t), prev));
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  const selectLooseTask = useCallback(
    (id: number) => {
      setSelectedEpicId(null);
      setSelectedJobId(null);
      void selectTask(id);
    },
    [selectTask],
  );

  const openTaskFromAnywhere = useCallback(
    (id: number) => {
      setPanel('work');
      setNeedsOpen(false);
      const task = tasks.find((t) => t.id === id);
      if (task?.job_id) {
        const job = jobs.find((j) => j.id === task.job_id);
        setSelectedEpicId(job?.epic_id ?? null);
        setSelectedJobId(task.job_id);
      } else if (task?.epic_id) {
        setSelectedEpicId(task.epic_id);
        setSelectedJobId(null);
      } else {
        setSelectedEpicId(null);
        setSelectedJobId(null);
      }
      void selectTask(id);
    },
    [tasks, jobs, selectTask],
  );

  const act = useCallback(async (path: string, body?: unknown) => {
    try {
      await api(path, { method: 'POST', body });
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  const actEpic = useCallback(
    (id: number, action: EpicAction, feedback?: string) => void act(`/api/epics/${id}/${action}`, { feedback }),
    [act],
  );

  const selectedEpic = useMemo(() => epics.find((e) => e.id === selectedEpicId) ?? null, [epics, selectedEpicId]);
  const selectedJob = useMemo(() => jobs.find((j) => j.id === selectedJobId) ?? null, [jobs, selectedJobId]);
  const selectedTask = useMemo(() => tasks.find((t) => t.id === selectedTaskId) ?? null, [tasks, selectedTaskId]);
  const epicJobs = useMemo(() => jobs.filter((j) => j.epic_id === selectedEpicId).sort((a, b) => a.id - b.id), [jobs, selectedEpicId]);
  const directorTasks = useMemo(() => tasks.filter((t) => t.epic_id === selectedEpicId).sort((a, b) => a.id - b.id), [tasks, selectedEpicId]);
  const jobTasks = useMemo(() => tasks.filter((t) => t.job_id === selectedJobId).sort((a, b) => a.id - b.id), [tasks, selectedJobId]);
  const signature = useMemo(
    () => [...tasks.map((t) => `${t.id}:${t.status}`), ...jobs.map((j) => `j${j.id}:${j.status}`), ...epics.map((e) => `e${e.id}:${e.status}`)].join(','),
    [tasks, jobs, epics],
  );
  // Dòng nhật ký công cụ gần nhất của từng việc đang chạy: văn phòng 3D dựa vào đây để biết ai đang đọc code, ai đang chạy lệnh.
  const lastTool = useMemo(() => {
    const out: Record<number, string> = {};
    for (const t of tasks) {
      if (t.status !== 'running') continue;
      const events = eventsByTask[t.id];
      if (!events) continue;
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].kind === 'tool') {
          out[t.id] = events[i].summary;
          break;
        }
      }
    }
    return out;
  }, [tasks, eventsByTask]);
  const requests = useMemo(() => ownerRequests(epics, jobs, tasks), [epics, jobs, tasks]);
  // Chuỗi đang xem ở bảng Công việc, suy từ dữ liệu (không từ các id đã chọn) để luôn đúng dù mở việc từ đâu: yêu cầu > việc lớn > việc.
  const chain = useMemo(() => {
    const job = selectedTask ? jobs.find((j) => j.id === selectedTask.job_id) ?? null : selectedJob;
    const epicId = selectedTask ? job?.epic_id ?? selectedTask.epic_id : selectedJob ? selectedJob.epic_id : selectedEpic?.id ?? null;
    const epic = epicId !== null && epicId !== undefined ? epics.find((e) => e.id === epicId) ?? null : null;
    return { epic, job, task: selectedTask };
  }, [epics, jobs, selectedEpic, selectedJob, selectedTask]);
  const activeCount = company ? company.running.length : 0;
  const usagePct = useMemo(() => {
    const values = Object.values(company?.rateLimit?.windows ?? {}).map((w) => w.utilization).filter((u): u is number => u !== null);
    return values.length ? Math.round(Math.max(...values) * 100) : null;
  }, [company]);
  const blocked = Boolean(app?.configError) || app?.teams.length === 0;
  const workTeams = app?.teams.filter((t) => t.lead && t.members.some((m) => !m.isLead)) ?? [];

  // Thông báo khi có việc chờ chính bạn: số trên tiêu đề tab, và một tiếng chuông cho việc MỚI (không rung chuông cho thứ đã chờ sẵn lúc mở trang).
  const requestKeys = useMemo(() => requests.map((r) => `${r.kind}:${r.id}:${r.status}`), [requests]);
  useEffect(() => {
    document.title = titleFor('My Company', requestKeys.length);
    return () => {
      document.title = titleFor('My Company', 0);
    };
  }, [requestKeys.length]);
  useEffect(() => {
    if (!app) return;
    const seen = seenRequests.current;
    seenRequests.current = new Set(requestKeys);
    const fresh = seen ? newKeys(seen, requestKeys) : [];
    if (sound && fresh.length > 0) chime();
    // Chế độ "chỉ khi mở trang": báo bằng thông báo của trình duyệt khi bạn đang ở tab khác. Chế độ đẩy do máy chủ lo.
    if (notifyMode === 'local' && document.hidden) {
      for (const request of requests) {
        if (fresh.includes(`${request.kind}:${request.id}:${request.status}`)) void showLocalNotification(notifyMessage(request));
      }
    }
  }, [app, requestKeys, requests, sound, notifyMode]);

  const openPanel = (id: Panel) => {
    setNeedsOpen(false);
    setPanel(id);
  };

  return (
    <main className="shell">
      <div className="stage">
        {app ? (
          <Office3D
            teams={app.teams}
            tasks={tasks}
            jobs={jobs}
            epics={epics}
            lastTool={lastTool}
            engines={engines}
            pausedUntil={company?.pausedUntil ?? 0}
            now={now}
            onOpenTask={openTaskFromAnywhere}
          />
        ) : (
          <div className="stage-loading" role="status">{error ?? 'Đang tải văn phòng...'}</div>
        )}
      </div>

      <div className="edge">
        <button
          type="button"
          className="edge-handle"
          aria-label="Thanh công cụ"
          aria-expanded={barOpen}
          onClick={() => setBarOpen((v) => !v)}
        />
      </div>
      <header className="topbar" data-open={barOpen} ref={barRef}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Icon name="building" size={18} /></span>
          <div className="brand-text">
            <strong>My Company</strong>
            <span className="muted">{app ? `${app.project.name}${app.project.stack.length ? ` · ${app.project.stack.join(', ')}` : ''}` : 'Đang tải...'}</span>
          </div>
        </div>

        <nav className="topnav" aria-label="Chức năng">
          {NAV.map((item) => (
            <button key={item.id} type="button" className="hbtn" aria-pressed={panel === item.id} title={item.label} onClick={() => openPanel(item.id)}>
              <Icon name={item.icon} />
              <span className="hbtn-label">{item.label}</span>
              {item.id === 'usage' && usagePct !== null && <span className={`hbtn-badge ${usagePct >= 90 ? 'hot' : usagePct >= 70 ? 'warm' : ''}`}>{usagePct}%</span>}
            </button>
          ))}
        </nav>

        <div className="toolbar">
          <span className={`live ${connected ? 'on' : 'off'}`} title={connected ? 'Đã kết nối với máy chủ' : 'Mất kết nối với máy chủ'}>
            <span className="live-dot" aria-hidden="true" />
            {company ? `${activeCount}/${company.maxConcurrent} đang làm · ${company.queued} chờ` : connected ? 'Đã kết nối' : 'Mất kết nối'}
          </span>
          {company && (
            <button
              type="button"
              className="hbtn"
              aria-pressed={company.manualPause}
              title={company.manualPause ? 'Tiếp tục nhận việc mới' : 'Nhường chỗ: tạm dừng nhận việc mới, việc đang làm vẫn chạy tiếp'}
              onClick={() => void act('/api/pause', { paused: !company.manualPause })}
            >
              <Icon name={company.manualPause ? 'play' : 'pause'} />
              <span className="hbtn-label">{company.manualPause ? 'Tiếp tục nhận việc' : 'Nhường chỗ'}</span>
            </button>
          )}
          <button
            type="button"
            className="hbtn icon-only"
            aria-pressed={sound}
            aria-label={sound ? 'Chuông: bật' : 'Chuông: tắt'}
            title={sound ? 'Chuông: bật (kêu khi có việc chờ bạn quyết)' : 'Chuông: tắt'}
            onClick={() => { const next = !sound; setSound(next); writeSoundPreference(next); if (next) chime(); }}
          >
            <Icon name={sound ? 'volume' : 'volumeOff'} />
          </button>
          <button
            type="button"
            className="hbtn icon-only"
            aria-pressed={notifyMode !== 'off'}
            disabled={notifyBusy}
            aria-label={notifyMode === 'push' ? 'Thông báo: bật' : notifyMode === 'local' ? 'Thông báo: bật (khi mở trang)' : 'Thông báo: tắt'}
            title={notifyMode === 'off' ? 'Bật thông báo khi có việc chờ bạn quyết, kể cả lúc đã đóng trang (cần cho phép trong trình duyệt)' : notifyMode === 'push' ? 'Thông báo: bật. Bấm để tắt' : 'Thông báo: bật khi mở trang. Bấm để tắt'}
            onClick={() => void toggleNotify()}
          >
            <Icon name={notifyMode === 'off' ? 'bellOff' : 'bell'} />
          </button>
          {notifyMode === 'push' && (
            <button type="button" className="hbtn" disabled={notifyBusy} onClick={() => void testNotify()}>
              <Icon name="bell" />
              <span className="hbtn-label">Gửi thử</span>
            </button>
          )}
          <button
            type="button"
            className="hbtn icon-only"
            aria-label={theme === 'dark' ? 'Chuyển sang giao diện sáng (cảnh ban ngày)' : 'Chuyển sang giao diện tối (cảnh ban đêm)'}
            title={theme === 'dark' ? 'Giao diện sáng, cảnh ban ngày' : 'Giao diện tối, cảnh ban đêm'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
          {remote && (
            <button type="button" className="hbtn icon-only" aria-label="Đăng xuất" title="Đăng xuất" onClick={() => void logout()}>
              <Icon name="logout" />
            </button>
          )}
        </div>
      </header>

      {requests.length > 0 && (
        <section className="needs-wrap" aria-label="Cần bạn quyết">
          <button type="button" className="needs-pill" aria-expanded={needsOpen} onClick={() => setNeedsOpen((v) => !v)}>
            <span className="pulse" aria-hidden="true" />
            {requests.length} việc cần bạn quyết
            <Icon name="chevron" size={16} />
          </button>
          {needsOpen && (
            <ul className="needs-menu">
              {requests.map((r) => (
                <li key={`${r.kind}:${r.id}`}>
                  <button
                    type="button"
                    className="need"
                    onClick={() => {
                      setNeedsOpen(false);
                      setPanel('work');
                      if (r.kind === 'epic') void selectEpic(r.id);
                      else if (r.kind === 'job') void selectJob(r.id);
                      else openTaskFromAnywhere(r.id);
                    }}
                  >
                    <span className="need-title">{r.kind === 'epic' ? 'Yêu cầu' : r.kind === 'job' ? 'Việc lớn' : 'Việc'} #{r.id} “{r.title}”</span>
                    <span className="need-sub">{r.kind === 'epic' ? EPIC_STATUS_LABEL[r.status as Epic['status']] : r.kind === 'job' ? JOB_STATUS_LABEL[r.status as Job['status']] : r.status === 'asking' ? 'Đang hỏi bạn một câu' : 'Bị lỗi, chọn cách xử lý'} · {r.who}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="toasts" role="status" aria-live="polite">
        {error && (
          <p className="toast toast-error" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
            <button type="button" className="icon-btn" aria-label="Ẩn thông báo" onClick={() => setError(null)}><Icon name="x" size={16} /></button>
          </p>
        )}
        {notifyNote && (
          <p className="toast">
            <span>{notifyNote}</span>
            <button type="button" className="icon-btn" aria-label="Ẩn thông báo" onClick={() => setNotifyNote(null)}><Icon name="x" size={16} /></button>
          </p>
        )}
        {app && !connected && <p className="toast toast-error"><Icon name="alert" size={18} /><span>Mất kết nối với máy chủ, đang thử nối lại...</span></p>}
        {app?.configError && <p className="toast toast-error"><Icon name="alert" size={18} /><span>Cấu hình lỗi: {app.configError}</span></p>}
        {app && !app.project.hasProfile && (
          <p className="toast toast-warn">
            <Icon name="alert" size={18} />
            <span>Chưa có hồ sơ dự án. Chạy <code>npm run init</code> để tạo bản nháp tại <code>local/project.md</code>, sửa lại, rồi giao việc. Không có hồ sơ thì nhân viên không chạy được lệnh nào (kể cả test).</span>
          </p>
        )}
        {company?.manualPause && <p className="toast toast-warn"><Icon name="pause" size={18} /><span>Đang tạm dừng nhận việc mới. Các việc đang làm vẫn chạy tiếp.</span></p>}
      </div>

      <footer className="dock" aria-label="Thao tác chính">
        <button type="button" className="dock-btn" aria-pressed={feedOpen} onClick={() => setFeedOpen((v) => !v)}>
          <Icon name="chat" />
          <span>Tin nhắn</span>
        </button>
        <button type="button" className="dock-btn dock-primary" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          <span>Thêm công việc</span>
        </button>
        <button
          type="button"
          className={`dock-btn dock-danger ${stopArmed ? 'armed' : ''}`}
          title="Dừng mọi việc đang chạy và đang chờ. Bấm hai lần để xác nhận."
          onClick={() => {
            if (!stopArmed) return setStopArmed(true);
            setStopArmed(false);
            void act('/api/stop-all');
          }}
        >
          <Icon name="stop" />
          <span>{stopArmed ? 'Bấm lại để dừng hết' : 'Dừng tất cả'}</span>
        </button>
      </footer>

      {feedOpen && (
        <Drawer title="Tin nhắn giữa các nhân viên" onClose={() => setFeedOpen(false)}>
          <FeedPanel signature={signature} onSelectTask={(id) => { setFeedOpen(false); openTaskFromAnywhere(id); }} />
        </Drawer>
      )}

      {adding && (
        <Overlay title="Thêm công việc" onClose={() => setAdding(false)}>
          <div className="tabs" role="tablist" aria-label="Loại việc cần giao">
            <button type="button" role="tab" aria-selected={mode === 'epic'} className={mode === 'epic' ? 'tab active' : 'tab'} onClick={() => setMode('epic')}>Yêu cầu cho công ty</button>
            <button type="button" role="tab" aria-selected={mode === 'job'} className={mode === 'job' ? 'tab active' : 'tab'} onClick={() => setMode('job')}>Việc lớn cho 1 team</button>
            <button type="button" role="tab" aria-selected={mode === 'task'} className={mode === 'task' ? 'tab active' : 'tab'} onClick={() => setMode('task')}>Việc lẻ</button>
          </div>
          {mode === 'epic' && <EpicForm disabled={blocked} onCreated={(epic) => { setEpics((prev) => upsertById(prev, epic)); setAdding(false); setPanel('work'); void selectEpic(epic.id); }} />}
          {app && mode === 'job' && (
            <JobForm teams={workTeams} disabled={blocked} onCreated={(job) => { setJobs((prev) => upsertById(prev, job)); setAdding(false); setPanel('work'); void selectJob(job.id); }} />
          )}
          {app && mode === 'task' && (
            <TaskForm teams={app.teams} engines={engines} disabled={blocked} onCreated={(t) => { setTasks((prev) => upsertById(prev, t)); setAdding(false); setPanel('work'); selectLooseTask(t.id); }} />
          )}
        </Overlay>
      )}

      {panel === 'usage' && company && (
        <Overlay title="Mức dùng hạn mức" onClose={() => setPanel(null)}>
          <QuotaPanel company={company} now={now} />
        </Overlay>
      )}
      {panel === 'engines' && (
        <Overlay title="Liên kết AI" size="lg" onClose={() => setPanel(null)}>
          <EnginesPanel
            engines={engines}
            now={now}
            onChange={(list) => {
              setEngines(list);
              void refresh();
            }}
            onRecheck={() => loadEngines(true)}
          />
        </Overlay>
      )}
      {panel === 'board' && app && (
        <Overlay title="Bảng kanban" size="xl" onClose={() => setPanel(null)}>
          <Board tasks={tasks} teams={app.teams} onSelect={(t) => openTaskFromAnywhere(t.id)} />
        </Overlay>
      )}
      {panel === 'load' && (
        <Overlay title="Tải của team" size="lg" onClose={() => setPanel(null)}>
          <TeamLoadPanel signature={signature} />
        </Overlay>
      )}
      {panel === 'report' && (
        <Overlay title="Báo cáo" size="lg" onClose={() => setPanel(null)}>
          <Report signature={signature} />
        </Overlay>
      )}
      {panel === 'schedules' && (
        <Overlay title="Mẫu và việc định kỳ" size="lg" onClose={() => setPanel(null)}>
          <Schedules
            signature={signature}
            onOpenRun={(kind, id) => {
              setPanel('work');
              if (kind === 'epic') void selectEpic(id);
              else void selectJob(id);
            }}
          />
        </Overlay>
      )}

      {panel === 'work' && (
        <Overlay title="Công việc" size="xl" onClose={() => setPanel(null)}>
          <WorkPanel
            epics={epics}
            jobs={jobs}
            tasks={tasks}
            needs={requests}
            now={now}
            selected={selectedTask ? { kind: 'task', id: selectedTask.id } : selectedJob ? { kind: 'job', id: selectedJob.id } : selectedEpic ? { kind: 'epic', id: selectedEpic.id } : null}
            selectedRoot={chain.epic ? { kind: 'epic', id: chain.epic.id } : chain.job ? { kind: 'job', id: chain.job.id } : chain.task ? { kind: 'task', id: chain.task.id } : null}
            onOpen={(item) => {
              if (item.kind === 'epic') void selectEpic(item.id);
              else if (item.kind === 'job') void selectJob(item.id);
              else openTaskFromAnywhere(item.id);
            }}
            crumbs={[
              ...(chain.epic ? [{ key: `e${chain.epic.id}`, label: `Yêu cầu #${chain.epic.id}`, onClick: chain.job || chain.task ? () => void selectEpic(chain.epic!.id) : undefined }] : []),
              ...(chain.job ? [{ key: `j${chain.job.id}`, label: `Việc lớn #${chain.job.id}`, onClick: chain.task ? () => void selectJob(chain.job!.id, true) : undefined }] : []),
              ...(chain.task ? [{ key: `t${chain.task.id}`, label: `Việc #${chain.task.id}` }] : []),
            ] satisfies Crumb[]}
          >
            {selectedTask ? (
              <TaskDetail
                task={selectedTask}
                engines={engines}
                events={eventsByTask[selectedTask.id] ?? []}
                now={now}
                onStop={(id) => void act(`/api/tasks/${id}/stop`)}
              />
            ) : selectedJob ? (
              <JobDetail
                job={selectedJob}
                tasks={jobTasks}
                selectedTaskId={selectedTaskId}
                onSelectTask={(id) => void selectTask(id)}
                onStop={(id) => void act(`/api/jobs/${id}/stop`)}
                onReplan={(id) => void act(`/api/jobs/${id}/replan`)}
              />
            ) : selectedEpic ? (
              <EpicDetail
                epic={selectedEpic}
                jobs={epicJobs}
                directorTasks={directorTasks}
                selectedJobId={selectedJobId}
                selectedTaskId={selectedTaskId}
                onSelectJob={(id) => void selectJob(id, true)}
                onSelectTask={(id) => { setSelectedJobId(null); void selectTask(id); }}
                onAct={(action, feedback) => actEpic(selectedEpic.id, action, feedback)}
              />
            ) : (
              <TaskDetail task={null} events={[]} now={now} onStop={() => {}} />
            )}
          </WorkPanel>
        </Overlay>
      )}
    </main>
  );
}
