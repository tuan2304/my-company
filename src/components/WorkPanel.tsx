'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EPIC_STATUS_LABEL, formatAgo, JOB_STATUS_LABEL, STATUS_LABEL } from '@/lib/format';
import type { Epic, EpicStatus, Job, JobStatus, Task, TaskStatus } from '@/lib/types';
import {
  defaultTab, groupWork, KIND_TAG, TAB_LABEL, tabOf, type NeedRef, type WorkItem, type WorkKind, type WorkTab,
} from '@/lib/work-groups';
import { Icon } from './ui';

export interface Crumb {
  key: string;
  label: string;
  onClick?: () => void;
}

interface Props {
  epics: Epic[];
  jobs: Job[];
  tasks: Task[];
  needs: NeedRef[];
  now: number;
  /** Việc đang mở ở cột phải (tầng sâu nhất), và việc cấp cao nhất chứa nó: dùng để tô dòng và tự chuyển thẻ. */
  selected: { kind: WorkKind; id: number } | null;
  selectedRoot: { kind: WorkKind; id: number } | null;
  onOpen: (item: WorkItem) => void;
  crumbs: Crumb[];
  children: ReactNode;
}

const TABS: WorkTab[] = ['need', 'active', 'done', 'stopped'];
const PAGE = 40;

/** Màu vạch bên trái của từng mục: đỏ = lỗi, vàng = chờ bạn, xanh dương = đang chạy, xanh lá = xong, xám = chờ/dừng. */
const TONE: Record<string, string> = {
  approve: 'warn', asking: 'warn', failed: 'bad',
  working: 'info', reviewing: 'violet', waiting: 'muted',
  today: 'ok', yesterday: 'ok', earlier: 'ok',
  stopped: 'muted', rejected: 'muted',
};

function statusText(item: WorkItem): string {
  if (item.status === 'asking') return 'Đang hỏi bạn';
  if (item.kind === 'epic') return EPIC_STATUS_LABEL[item.status as EpicStatus] ?? item.status;
  if (item.kind === 'job') return JOB_STATUS_LABEL[item.status as JobStatus] ?? item.status;
  if (item.status === 'submitted') return 'Chờ Trưởng nhóm duyệt';
  return STATUS_LABEL[item.status as TaskStatus] ?? item.status;
}

const ROLE_OF: Record<WorkKind, string> = { epic: 'Giám đốc', job: 'Trưởng nhóm', task: '' };

const EMPTY: Record<WorkTab, string> = {
  need: 'Không có việc nào chờ bạn.',
  active: 'Không có việc nào đang chạy.',
  done: 'Chưa có việc nào xong.',
  stopped: 'Không có việc nào bị dừng.',
};

/**
 * Bảng Công việc: bốn thẻ theo trạng thái (Cần bạn / Đang làm / Xong / Đã dừng), mỗi thẻ chia mục nhỏ, có ô tìm.
 * Cột phải chỉ hiện MỘT tầng (cái đang mở) với đường dẫn để quay lên yêu cầu/việc lớn chứa nó.
 */
export default function WorkPanel({ epics, jobs, tasks, needs, now, selected, selectedRoot, onOpen, crumbs, children }: Props) {
  const [query, setQuery] = useState('');
  // Thẻ bạn tự chọn gắn với việc đang mở lúc chọn: mở việc khác (ví dụ bấm nhân viên trong văn phòng) thì bảng tự nhảy sang thẻ chứa việc đó.
  const [choice, setChoice] = useState<{ tab: WorkTab; forKey: string } | null>(null);
  const [shown, setShown] = useState<Record<string, number>>({});

  const groups = useMemo(() => groupWork({ epics, jobs, tasks, needs, now, query }), [epics, jobs, tasks, needs, now, query]);
  const all = useMemo(() => (query ? groupWork({ epics, jobs, tasks, needs, now }) : groups), [query, groups, epics, jobs, tasks, needs, now]);

  const selKey = selected ? `${selected.kind}:${selected.id}` : '';
  const rootKey = selectedRoot ? `${selectedRoot.kind}:${selectedRoot.id}` : '';
  const home = (selected && tabOf(all, selected.kind, selected.id)) || (selectedRoot && tabOf(all, selectedRoot.kind, selectedRoot.id)) || null;
  const tab: WorkTab = choice && choice.forKey === selKey ? choice.tab : home ?? choice?.tab ?? defaultTab(all.counts);
  const sections = groups.tabs[tab];

  // Màn hình hẹp (danh sách nằm trên chi tiết): mở việc khác thì cuộn xuống phần chi tiết.
  const detailRef = useRef<HTMLElement>(null);
  const firstKey = useRef(selKey);
  useEffect(() => {
    if (!selKey || selKey === firstKey.current) return;
    firstKey.current = selKey;
    if (window.matchMedia('(max-width: 860px)').matches) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selKey]);

  return (
    <div className="work-grid">
      <section className="col work-list" aria-label="Danh sách việc">
        <div className="wtabs" role="tablist" aria-label="Lọc theo trạng thái">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`wtab ${tab === t ? 'active' : ''} wtab-${t}`}
              onClick={() => setChoice({ tab: t, forKey: selKey })}
            >
              <span>{TAB_LABEL[t]}</span>
              <span className={`wtab-count ${t === 'need' && groups.counts.need > 0 ? 'hot' : ''}`}>{groups.counts[t]}</span>
            </button>
          ))}
        </div>

        <label className="wsearch">
          <Icon name="search" size={16} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm theo tên, mã hoặc người làm" aria-label="Tìm việc" />
        </label>

        <div className="wsections" role="tabpanel" aria-label={TAB_LABEL[tab]}>
          {sections.length === 0 && (
            <p className="wempty">
              {query ? `Không có việc nào khớp “${query.trim()}” trong thẻ này.` : EMPTY[tab]}
              {!query && tab === 'need' && groups.counts.active > 0 && <> Có {groups.counts.active} việc đang chạy.</>}
            </p>
          )}
          {sections.map((section) => {
            const sectionKey = `${tab}:${section.key}`;
            const limit = shown[sectionKey] ?? PAGE;
            const items = section.items.slice(0, limit);
            return (
              <section key={section.key} className="wsection" aria-label={section.label}>
                <h3 className="wsection-head">
                  <span className={`dot tone-${TONE[section.key] ?? 'muted'}`} aria-hidden="true" />
                  {section.label}
                  <span className="wsection-count">{section.items.length}</span>
                </h3>
                <ul className="witems">
                  {items.map((item) => {
                    const key = `${item.kind}:${item.id}`;
                    const current = key === selKey || (key === rootKey && !section.items.some((i) => `${i.kind}:${i.id}` === selKey));
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          className={`witem tone-${TONE[section.key] ?? 'muted'}`}
                          aria-current={current ? 'true' : undefined}
                          onClick={() => onOpen(item)}
                        >
                          <span className="witem-title">{item.title}</span>
                          <span className="witem-meta">
                            <span className={`ktag ktag-${item.kind}`}>{KIND_TAG[item.kind]}</span>
                            <span>#{item.id}</span>
                            <span aria-hidden="true">·</span>
                            <span>{ROLE_OF[item.kind] ? `${ROLE_OF[item.kind]} ${item.who}` : item.who}</span>
                            {item.parent && <><span aria-hidden="true">·</span><span>thuộc {item.parent.kind === 'job' ? 'việc lớn' : 'yêu cầu'} #{item.parent.id}</span></>}
                          </span>
                          <span className="witem-status">
                            {statusText(item)}
                            <span className="witem-time">{formatAgo(item.at, now)}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {section.items.length > limit && (
                  <button type="button" className="secondary wmore" onClick={() => setShown((s) => ({ ...s, [sectionKey]: limit + PAGE }))}>
                    Hiện thêm {Math.min(PAGE, section.items.length - limit)} việc (còn {section.items.length - limit})
                  </button>
                )}
              </section>
            );
          })}
        </div>
      </section>

      <section className="col work-detail" aria-label="Chi tiết" ref={detailRef}>
        {crumbs.length > 1 && (
          <nav className="crumbs" aria-label="Đang xem">
            {crumbs.map((c, i) => (
              <span key={c.key} className="crumb">
                {i > 0 && <Icon name="chevronRight" size={14} />}
                {c.onClick ? (
                  <button type="button" className="linklike" onClick={c.onClick}>{c.label}</button>
                ) : (
                  <span aria-current="page">{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        {children}
      </section>
    </div>
  );
}
