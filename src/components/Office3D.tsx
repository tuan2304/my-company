'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { STATUS_LABEL, TASK_KIND_LABEL } from '@/lib/format';
import { engineLines, taskModelLabel } from '@/lib/engines';
import type { EngineInfo, Epic, Job, Task, TeamSummary } from '@/lib/types';
import { diffFlows, type Snapshot } from '@/office/flow';
import { countByTeam, layoutBuilding } from '@/office/layout';
import { createOfficeScene, type ViewMode } from '@/office/create';
import type { OfficeScene } from '@/office/scene-types';
import { OfficeSim } from '@/office/sim';
import { useTheme } from '@/lib/theme';
import ContestPanel from './ContestPanel';
import { Icon } from './ui';
import { IDLE_VIEW, lampOf, ownerRequests, viewOf, type Lamp } from '@/office/status';

interface Props {
  teams: TeamSummary[];
  tasks: Task[];
  jobs: Job[];
  epics: Epic[];
  /** Dòng nhật ký công cụ gần nhất của từng việc đang chạy (để biết ai đang đọc code, ai đang chạy lệnh). */
  lastTool: Record<number, string>;
  /** Các AI đã liên kết và model thật của chúng (rỗng nếu chưa tải): hiện trong thẻ nhân viên. */
  engines?: EngineInfo[];
  /** Thời điểm công ty nghỉ giải lao tới (hết hạn mức Pro), 0 nếu không nghỉ. */
  pausedUntil: number;
  now: number;
  onOpenTask: (id: number) => void;
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

const MODE_KEY = 'my-company.office-mode';
function readMode(): ViewMode {
  try {
    const saved = window.localStorage.getItem(MODE_KEY);
    if (saved === '2d' || saved === '3d') return saved;
  } catch {
    // trình duyệt chặn lưu trữ: dùng mặc định theo thiết bị
  }
  // Chưa chọn lần nào: điện thoại/máy bảng cảm ứng mặc định 2D (nhẹ hơn nhiều), máy tính để bàn mặc định 3D.
  if (typeof window === 'undefined') return '3d';
  return window.matchMedia?.('(max-width: 860px), (pointer: coarse)').matches ? '2d' : '3d';
}

const OPEN: Task['status'][] = ['running', 'queued', 'paused_quota', 'waiting_answer', 'submitted'];
const LAMP_TEXT: Record<Lamp, string> = {
  needs_you: 'Chờ bạn quyết',
  overload: 'Quá tải',
  working: 'Đang làm',
  waiting: 'Chờ duyệt bài',
  queued: 'Có việc đang chờ',
  failed: 'Việc vừa bị lỗi',
  idle: 'Đang rảnh',
};
const LEGEND: { color: string; text: string }[] = [
  { color: '#22c55e', text: 'Đang làm' },
  { color: '#3b82f6', text: 'Chờ Trưởng nhóm duyệt bài' },
  { color: '#f59e0b', text: 'Có việc đang chờ (chồng giấy trên bàn)' },
  { color: '#f97316', text: 'Quá tải: nhấp nháy, toát mồ hôi' },
  { color: '#ef4444', text: 'Việc vừa bị lỗi: gãi đầu' },
  { color: '#facc15', text: 'Chờ bạn quyết: nhấp nháy, giơ tay' },
  { color: '#94a3b8', text: 'Đang rảnh' },
];
const FLOW_GAP_MS = 350; // nhiều tờ giấy cùng lúc thì cho bay lần lượt

export default function Office3D({ teams, tasks, jobs, epics, lastTool, engines = [], pausedUntil, now, onOpenTask }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const previous = useRef<Snapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [webgl] = useState(webglAvailable);
  const [preferred, setPreferred] = useState<ViewMode>(readMode);
  const [floor, setFloor] = useState(0);
  const [legendOpen, setLegendOpen] = useState(false);
  const dark = useTheme() === 'dark';
  const [reducedMotion] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // Không có WebGL thì tự dùng bản 2D pixel art (vẫn đầy đủ tính năng) thay vì hiện danh sách.
  const mode: ViewMode = webgl ? preferred : '2d';
  // Bố cục chỉ dựng lại khi đội hình thật sự đổi (không phải mỗi lần dữ liệu máy chủ làm mới).
  const rosterKey = JSON.stringify(teams.map((t) => [t.id, t.name, t.lead, t.members.map((m) => [m.name, m.role, m.title, m.model, m.isLead])]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const building = useMemo(() => layoutBuilding(teams), [rosterKey]);
  // Mỗi tầng một bộ mô phỏng, giữ ở đây (không phải trong bộ vẽ) để đổi 3D ↔ 2D hay đổi tầng mà mọi người không bị đặt lại từ bàn.
  const sims = useMemo(() => building.floors.map((f) => new OfficeSim(f, !reducedMotion)), [building, reducedMotion]);
  const floorIndex = Math.min(floor, building.floors.length - 1);
  const layout = building.floors[floorIndex];
  const sim = sims[floorIndex];
  const minute = Math.floor(now / 60_000); // đèn lỗi chỉ cần chính xác tới phút, đừng tính lại mỗi giây
  const views = useMemo(
    () => viewOf({ tasks, jobs, epics, lastTool, now: minute * 60_000 + 59_999 }),
    [tasks, jobs, epics, lastTool, minute],
  );
  const requests = useMemo(() => ownerRequests(epics, jobs, tasks), [epics, jobs, tasks]);
  const counts = useMemo(() => countByTeam(building), [building]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const office = createOfficeScene(mode, host, layout, { dark, reducedMotion, onSelect: setSelected }, sim);
    sceneRef.current = office;
    // Cho phép kiểm thử bằng trình duyệt tự động tìm vị trí nhân vật trên màn hình (không phải biến toàn cục).
    (host as HTMLDivElement & { officeApi?: OfficeScene }).officeApi = office;
    return () => {
      office.dispose();
      sceneRef.current = null;
    };
  }, [layout, mode, sim, reducedMotion, dark]);

  // Các tầng đang không xem vẫn chạy ngầm (mọi người vẫn làm việc), để khi sang tầng đó thấy đúng cảnh hiện tại.
  useEffect(() => {
    const id = setInterval(() => {
      const ts = performance.now();
      sims.forEach((s, i) => {
        if (i !== floorIndex) s.step(ts, Date.now());
      });
    }, 400);
    return () => clearInterval(id);
  }, [sims, floorIndex]);

  useEffect(() => {
    for (const s of sims) s.setViews(views);
    sceneRef.current?.setViews(views);
  }, [views, sims, layout, mode]);

  useEffect(() => {
    const until = pausedUntil > 0 ? pausedUntil : null;
    for (const s of sims) s.setBreak(until);
    sceneRef.current?.setBreak(until);
  }, [pausedUntil, sims, layout, mode]);

  useEffect(() => {
    sceneRef.current?.setOwnerWaiting(requests.length);
  }, [requests.length, layout, mode]);

  useEffect(() => {
    sceneRef.current?.select(selected);
  }, [selected, layout, mode]);

  // Giấy chỉ bay theo thay đổi xảy ra khi bạn đang xem tab này; mở tab giữa chừng thì bắt đầu từ trạng thái hiện tại.
  useEffect(() => {
    const next: Snapshot = { tasks, jobs, epics };
    const before = previous.current;
    previous.current = next;
    if (!before || !sceneRef.current) return undefined;
    const timers = diffFlows(before, next).map((flow, i) => setTimeout(() => sceneRef.current?.sendFlow(flow), i * FLOW_GAP_MS));
    return () => timers.forEach(clearTimeout);
  }, [tasks, jobs, epics, layout, mode]);

  // Thi đấu skill: Trưởng nhóm có hai bản đang chờ bạn chọn. Bấm vào người đó thì mở thẳng cửa sổ so sánh.
  const awaitingContest = selected ? jobs.find((j) => j.lead === selected && j.status === 'awaiting_choice') ?? null : null;
  const [contestPinned, setContestPinned] = useState<number | null>(null); // cửa sổ đang mở do bạn thao tác (giữ mở cả sau khi chọn xong)
  const [contestClosed, setContestClosed] = useState<string | null>(null);
  const contestKey = awaitingContest ? `${selected}:${awaitingContest.id}` : null;
  const contestJob = contestPinned ?? (awaitingContest && contestClosed !== contestKey ? awaitingContest.id : null);

  const person = building.people.find((p) => p.name === selected) ?? null;
  const personView = person ? views[person.name] ?? IDLE_VIEW : IDLE_VIEW;
  const personLamp = lampOf(personView);
  const personTasks = person
    ? tasks.filter((t) => t.member === person.name).sort((a, b) => b.id - a.id)
    : [];
  const open = personTasks.filter((t) => OPEN.includes(t.status));
  const recent = personTasks.filter((t) => !OPEN.includes(t.status)).slice(0, 3);
  const teamLabels = [...new Map(building.floors.flatMap((f) => f.zones).map((z) => [z.id.split('~')[0], z.name])).entries()].map(([id, name]) => `${name}: ${counts[id] ?? 0}`);
  const directors = building.people.filter((p) => p.isDirector).length;

  return (
    <div className="office-stage">
      <div
        ref={hostRef}
        className="office-canvas"
        data-testid="office-canvas"
        data-people={building.people.length}
        data-floor={floorIndex + 1}
        data-webgl={webgl ? 'ok' : 'none'}
        data-mode={mode}
        role="img"
        aria-label={`Văn phòng ${mode === '3d' ? 'ba chiều' : 'pixel art nhìn từ trên xuống'}, tầng ${floorIndex + 1}, có ${building.people.length} người. Kéo để dịch chuyển, cuộn để phóng to, bấm vào một người để xem việc họ đang làm.`}
      />
      <div className="scrim scrim-top" aria-hidden="true" />
      <div className="scrim scrim-bottom" aria-hidden="true" />

      <div className="stage-notices" aria-live="polite">
        {pausedUntil > now && (
          <p className="pill pill-warn" data-testid="office-break">Hết hạn mức Pro: cả công ty đang nghỉ giải lao, tự làm tiếp khi hạn mức hồi.</p>
        )}
        {!webgl && <p className="pill pill-warn">Trình duyệt không bật được WebGL nên dùng bản 2D pixel art.</p>}
      </div>

      <div className="stage-tools">
        <div className="segmented" role="group" aria-label="Kiểu hiển thị">
          {(['3d', '2d'] as const).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`office-mode-${m}`}
              className={mode === m ? 'seg active' : 'seg'}
              aria-pressed={mode === m}
              disabled={m === '3d' && !webgl}
              title={m === '3d' ? 'Cảnh 3D isometric' : 'Cảnh 2D pixel art nhìn từ trên xuống'}
              onClick={() => {
                setPreferred(m);
                try {
                  window.localStorage.setItem(MODE_KEY, m);
                } catch {
                  // trình duyệt chặn lưu trữ: chỉ không nhớ được lựa chọn
                }
              }}
            >
              {m === '3d' ? '3D' : '2D'}
            </button>
          ))}
        </div>
        {building.floors.length > 1 && (
          <div className="segmented" role="group" aria-label="Tầng">
            {building.floors.map((f, i) => {
              const needsYou = f.people.some((p) => views[p.name]?.needsYou);
              return (
                <button
                  key={f.floor}
                  type="button"
                  data-testid={`office-floor-${i + 1}`}
                  className={i === floorIndex ? 'seg active' : 'seg'}
                  aria-pressed={i === floorIndex}
                  title={`Tầng ${i + 1}: ${f.people.length} người`}
                  onClick={() => setFloor(i)}
                >
                  Tầng {i + 1}{needsYou && <span className="seg-dot" role="img" aria-label="có việc chờ bạn" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="stage-info">
        <p className="stage-summary" data-testid="office-summary">
          {building.people.length} người{building.floors.length > 1 ? `, ${building.floors.length} tầng` : ''}
          <span className="stage-summary-teams"> · {[...(directors ? [`Ban giám đốc ${directors}`] : []), ...teamLabels].join(' · ')}</span>
        </p>
        <button type="button" className="glass-btn" aria-expanded={legendOpen} onClick={() => setLegendOpen((v) => !v)}>
          <Icon name="help" size={16} /> Chú giải
        </button>
      </div>

      {legendOpen && (
        <aside className="popover legend-pop" aria-label="Chú giải">
          <div className="popover-head">
            <h3>Chú giải</h3>
            <button type="button" className="icon-btn" aria-label="Đóng chú giải" onClick={() => setLegendOpen(false)}><Icon name="x" size={16} /></button>
          </div>
          <p className="muted">Kéo chuột để dịch chuyển, cuộn để phóng to, bấm một nhân vật để xem việc họ đang làm. Đổi 3D | 2D thì mọi người vẫn đứng đúng chỗ. Hết chỗ làm việc thì tòa nhà mở thêm tầng.</p>
          <ul className="legend">
            {LEGEND.map((item) => (
              <li key={item.text}><span className="dot" style={{ background: item.color }} /> {item.text}</li>
            ))}
          </ul>
          <p className="muted">Vương miện vàng là Trưởng nhóm. Đọc code thì ra thư viện, chạy lệnh thì vào phòng server, Giám đốc lập kế hoạch thì ra bảng trắng. Giấy bay giữa các bàn là việc được giao, nộp, trả lại hoặc cất vào phòng Hồ sơ. Lúc rảnh nhân viên đi pha cà phê, họp đứng, ngắm cửa sổ, đọc sách; có việc là quay về bàn ngay.</p>
        </aside>
      )}

      {person && (
        <aside className="popover person-pop" aria-live="polite" aria-label={`Việc của ${person.name}`}>
          <div className="popover-head">
            <div>
              <h3>{person.name}{person.isLead && <span className="crown"> · Trưởng nhóm</span>}</h3>
              <p className="muted">{person.title} · {person.teamName} · {person.model}</p>
              {engineLines(engines, person.model, { lead: person.isLead }).length > 0 && (
                <ul className="list-plain person-engines" aria-label="Model theo từng AI đã liên kết">
                  {engineLines(engines, person.model, { lead: person.isLead }).map((line) => (
                    <li key={line.id}><span className="muted">{line.label}</span> <strong>{line.model}</strong></li>
                  ))}
                </ul>
              )}
            </div>
            <button type="button" className="icon-btn" aria-label="Bỏ chọn" onClick={() => setSelected(null)}><Icon name="x" size={16} /></button>
          </div>
          <p>
            <span className={`chip ${personLamp === 'working' ? 'status-running' : personLamp === 'failed' ? 'status-failed' : personLamp === 'needs_you' ? 'status-submitted' : ''}`}>{LAMP_TEXT[personLamp]}</span>
            {personView.detail && <span className="muted"> {personView.detail}</span>}
          </p>
          {personView.overload && <p className="muted">Đã chạm trần tải ({personView.queued} việc chờ). Việc mới nên giao cho người khác.</p>}
          {awaitingContest && (
            <p>
              <button type="button" onClick={() => { setContestClosed(null); setContestPinned(awaitingContest.id); }}>Xem hai bản và chọn</button>
            </p>
          )}
          {open.length === 0 && <p className="muted">Hiện không có việc nào đang mở.</p>}
          <ul className="list-plain">
            {open.map((t) => (
              <li key={t.id}>
                <button type="button" className="row" onClick={() => onOpenTask(t.id)}>
                  <span className="row-title">#{t.id} {t.title}</span>
                  <span className="row-sub">{TASK_KIND_LABEL[t.kind]}{t.model ? ` · ${taskModelLabel(t, engines)}` : ''}</span>
                  <span className={`chip status-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                </button>
              </li>
            ))}
          </ul>
          {recent.length > 0 && (
            <>
              <h4>Gần đây</h4>
              <ul className="list-plain">
                {recent.map((t) => (
                  <li key={t.id}>
                    <button type="button" className="row" onClick={() => onOpenTask(t.id)}>
                      <span className="row-title">#{t.id} {t.title}</span>
                      <span className="row-sub">{TASK_KIND_LABEL[t.kind]}</span>
                      <span className={`chip status-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      )}

      {contestJob !== null && (
        <ContestPanel
          key={contestJob}
          jobId={contestJob}
          onChosen={() => setContestPinned(contestJob)}
          onClose={() => { setContestPinned(null); setContestClosed(contestKey); }}
        />
      )}
    </div>
  );
}
