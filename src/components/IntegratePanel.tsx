'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { IntegrationInfo, PushMainInfo } from '@/lib/types';

interface Props {
  kind: 'task' | 'job' | 'epic';
  id: number;
}

interface SectionProps extends Props {
  /** Tăng lên khi khối kia vừa làm gì đó với git: khối này xem trước lại. */
  version: number;
  onChanged: () => void;
}

/**
 * "Đưa vào dự án" (gộp vào nhánh đang mở, không push) và "Push lên main" (gộp vào main rồi push lên GitHub).
 * Nơi gọi đặt `key` theo việc và trạng thái để khối này được tạo lại (xem trước mới) khi chúng đổi. Chỉ chạy khi bạn bấm.
 */
export default function IntegratePanel({ kind, id }: Props) {
  const [version, setVersion] = useState(0);
  const onChanged = useCallback(() => setVersion((v) => v + 1), []);
  return (
    <>
      <IntegrateSection kind={kind} id={id} version={version} onChanged={onChanged} />
      <PushMainSection kind={kind} id={id} version={version} onChanged={onChanged} />
    </>
  );
}

/**
 * "Đưa vào dự án": gộp nhánh company/... của một việc đã xong vào nhánh đang mở ở thư mục dự án.
 * Hệ thống kiểm tra trước (thư mục dự án sạch, không xung đột) và nói rõ vì sao chưa đưa được.
 */
function IntegrateSection({ kind, id, version, onChanged }: SectionProps) {
  const [info, setInfo] = useState<IntegrationInfo | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await api<IntegrationInfo>(`/api/integrate/${kind}/${id}`));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Không kiểm tra được.');
    }
  }, [kind, id]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load, version]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/integrate/${kind}/${id}`, { method: 'POST' });
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Đưa vào dự án thất bại.');
      setConfirming(false);
    } finally {
      setBusy(false);
      onChanged(); // xem trước lại cả hai khối: gộp vào main ở máy thì khối push đổi sang "chưa push"
    }
  }

  if (loadError) return <p className="error">{loadError}</p>;
  if (!info || info.state === 'not_ready' || !info.branch) return null;

  if (info.state === 'integrated') {
    const done = info.integration;
    return (
      <section className="integrate">
        <h3>Đã đưa vào dự án</h3>
        <p className="ok-text">
          {done
            ? <>Đã gộp <code>{done.branch}</code> vào nhánh <code>{done.target}</code> lúc {new Date(done.merged_at).toLocaleString('vi-VN')}{done.commit_id ? <> (commit <code>{done.commit_id.slice(0, 8)}</code>)</> : null}.</>
            : <>{info.reason}</>}
        </p>
      </section>
    );
  }

  if (info.state === 'missing') {
    return (
      <section className="integrate">
        <h3>Đưa vào dự án</h3>
        <p className="muted">{info.reason}</p>
      </section>
    );
  }

  const target = info.target ?? 'nhánh hiện tại';
  const list = info.state === 'conflict' ? info.conflictFiles : info.state === 'blocked' ? info.dirtyFiles : info.files;
  return (
    <section className={`integrate ${info.state === 'ready' ? 'ready' : ''}`}>
      <h3>Đưa vào dự án</h3>
      {info.state === 'ready' ? (
        <p>
          Gộp nhánh <code>{info.branch}</code> vào nhánh <code>{target}</code> đang mở ở thư mục dự án ({info.files.length} file). Không push gì lên mạng.
        </p>
      ) : (
        <p className="notice">{info.reason}</p>
      )}
      {list.length > 0 && (
        <details>
          <summary>{info.state === 'conflict' ? 'File xung đột' : info.state === 'blocked' ? 'File đang thay đổi ở dự án' : 'File sẽ đưa vào'} ({list.length})</summary>
          <ul className="files">{list.map((f) => <li key={f}>{f}</li>)}</ul>
        </details>
      )}
      {info.state === 'ready' && info.stat && <pre className="stat-pre">{info.stat}</pre>}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        {info.state === 'ready' && !confirming && (
          <button type="button" onClick={() => setConfirming(true)}>Đưa vào dự án</button>
        )}
        {info.state === 'ready' && confirming && (
          <>
            <button type="button" disabled={busy} onClick={() => void run()}>{busy ? 'Đang gộp…' : `Xác nhận gộp vào ${target}`}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>Hủy</button>
          </>
        )}
        {info.state !== 'ready' && (
          <button type="button" className="secondary" onClick={() => void load()}>Kiểm tra lại</button>
        )}
      </div>
    </section>
  );
}

/**
 * "Push lên main": gộp nhánh vào main (không đổi nhánh đang mở ở thư mục dự án) rồi `git push origin main`.
 * Không bao giờ force push. Push lỗi thì phần đã gộp ở máy vẫn giữ và có nút "Push lại".
 */
function PushMainSection({ kind, id, version, onChanged }: SectionProps) {
  const [info, setInfo] = useState<PushMainInfo | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await api<PushMainInfo>(`/api/push-main/${kind}/${id}`));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Không kiểm tra được.');
    }
  }, [kind, id]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load, version]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/push-main/${kind}/${id}`, { method: 'POST' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Push thất bại.');
    } finally {
      setConfirming(false);
      setBusy(false);
      onChanged();
    }
  }

  if (loadError) return <p className="error">{loadError}</p>;
  if (!info || info.state === 'not_ready' || info.state === 'missing' || !info.branch) return null;
  const target = info.target ?? 'main';
  const remoteRef = `${info.remote}/${target}`;

  if (info.state === 'pushed') {
    return (
      <section className="integrate">
        <h3>Push lên {target}</h3>
        <p className="ok-text">
          Đã có trên <code>{remoteRef}</code>{info.commit ? <> (commit <code>{info.commit.slice(0, 8)}</code>)</> : null}.
        </p>
      </section>
    );
  }

  const canAct = info.state === 'ready' || info.state === 'unpushed';
  const actLabel = info.state === 'unpushed' ? (error ? 'Push lại' : `Push lên ${remoteRef}`) : `Gộp vào ${target} và push`;
  const list = info.state === 'conflict' ? info.conflictFiles : info.state === 'blocked' ? info.dirtyFiles : info.state === 'ready' ? info.files : [];
  return (
    <section className={`integrate ${canAct ? 'ready' : ''}`}>
      <h3>Push lên {target}</h3>
      {info.state === 'ready' && (
        <p>
          Gộp nhánh <code>{info.branch}</code> vào <code>{target}</code> ({info.files.length} file)
          {info.current && info.current !== target ? <>, không đổi nhánh <code>{info.current}</code> bạn đang mở</> : null}, rồi push lên <code>{remoteRef}</code>. Không force push.
        </p>
      )}
      {info.state === 'unpushed' && (
        <p><code>{target}</code> ở máy đã có thay đổi của nhánh này nhưng <code>{remoteRef}</code> chưa có. Bấm để push (không force push).</p>
      )}
      {!canAct && <p className="notice">{info.reason}</p>}
      {list.length > 0 && (
        <details>
          <summary>{info.state === 'conflict' ? 'File xung đột' : info.state === 'blocked' ? 'File đang thay đổi ở dự án' : 'File sẽ đưa vào'} ({list.length})</summary>
          <ul className="files">{list.map((f) => <li key={f}>{f}</li>)}</ul>
        </details>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        {canAct && !confirming && (
          <button type="button" onClick={() => setConfirming(true)}>{actLabel}</button>
        )}
        {canAct && confirming && (
          <>
            <button type="button" disabled={busy} onClick={() => void run()}>{busy ? 'Đang push…' : `Xác nhận push lên ${remoteRef}`}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>Hủy</button>
          </>
        )}
        {!canAct && (
          <button type="button" className="secondary" onClick={() => void load()}>Kiểm tra lại</button>
        )}
      </div>
    </section>
  );
}
