'use client';

import { useEffect, useRef, type ReactNode } from 'react';

const PATHS = {
  work: 'M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5zM8 5V4M16 5V4M4 10h16',
  board: 'M4 5h5v14H4zM10.5 5h5v9h-5zM17 5h3v6h-3z',
  users: 'M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11zM3.5 19c.4-3 2.6-4.8 5.5-4.8s5.1 1.8 5.5 4.8M16 4.9a3 3 0 0 1 0 5.8M17.5 14.4c1.6.5 2.7 2 3 4.1',
  calendar: 'M5 6.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1zM8 4v4M16 4v4M4 11h16',
  report: 'M5 20V10M10 20V4M15 20v-7M20 20V8',
  gauge: 'M4.5 16a8 8 0 1 1 15 0M12 13.5l3.5-4.5M8 19h8',
  bell: 'M6.5 16.5v-5a5.5 5.5 0 0 1 11 0v5l1.5 1.5h-14zM10 20.5a2.2 2.2 0 0 0 4 0',
  bellOff: 'M6.5 16.5v-5c0-.9.2-1.7.6-2.4M17.5 11.5v5l1.5 1.5H8M10 20.5a2.2 2.2 0 0 0 4 0M4 4l16 16M9.8 5.7a5.5 5.5 0 0 1 7.7 5.8',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 5l12 7-12 7z',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 3v1.8M12 19.2V21M3 12h1.8M19.2 12H21M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M5.6 18.4l1.3-1.3M17.1 6.9l1.3-1.3',
  moon: 'M19.5 14.2A7.5 7.5 0 0 1 9.8 4.5a7.5 7.5 0 1 0 9.7 9.7z',
  logout: 'M14 4.5H7a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 7 19.5h7M10 12h10M17 8.5L20.5 12 17 15.5',
  chat: 'M5 5.5h14a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1h-7l-4.5 3.5V16H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1zM8 9.5h8M8 12.5h5',
  volume: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
  volumeOff: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 9.5l5 5M21 9.5l-5 5',
  plus: 'M12 5v14M5 12h14',
  stop: 'M8 4.5h8L19.5 8v8L16 19.5H8L4.5 16V8z',
  x: 'M6 6l12 12M18 6L6 18',
  help: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM9.6 9.5a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2.9-1.2 1.8M12 16.6v.1',
  chevron: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L20 20',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 4l9 15.5H3zM12 10v4.5M12 17.2v.1',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  building: 'M5 20V5.5A1.5 1.5 0 0 1 6.5 4h7A1.5 1.5 0 0 1 15 5.5V20M15 9.5h2.5A1.5 1.5 0 0 1 19 11v9M3.5 20h17M8.5 8h3M8.5 11.5h3M8.5 15h3',
} as const;

export type IconName = keyof typeof PATHS;

/** Bộ icon nét mảnh, cùng một độ dày (không dùng emoji thay icon). */
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface OverlayProps {
  title: string;
  onClose: () => void;
  /** md: biểu mẫu; xl: bảng lớn có hai cột. */
  size?: 'md' | 'lg' | 'xl';
  children: ReactNode;
}

/** Khung hiện đè lên văn phòng: mờ nền, Esc hoặc bấm ra ngoài để đóng, giữ tiêu điểm bàn phím bên trong, trả tiêu điểm về nút đã mở nó. */
export function Overlay({ title, onClose, size = 'md', children }: OverlayProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
    };
  }, []);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`dialog dialog-${size}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialog}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Đóng" title="Đóng (Esc)" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

/** Ngăn kéo bên phải, không chặn thao tác: vẫn xem và kéo văn phòng được trong lúc mở. */
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="drawer" aria-label={title}>
      <div className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" aria-label="Đóng" title="Đóng (Esc)" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </aside>
  );
}
