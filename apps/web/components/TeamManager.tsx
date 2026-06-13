'use client';
// Multi-number management (M10): list each salesperson's WhatsApp inbox, add a new one
// (shows its own QR to scan), and remove one. Live status/QR via the shared socket.
import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  deleteJson,
  getJson,
  inboxColor,
  inboxName,
  postJson,
  type InboxDto,
} from '../lib/api';
import { getSocket } from '../lib/socket';

function MiniQr({ value }: { value: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { margin: 1, width: 360 })
      .then((u) => !cancelled && setUrl(u))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [value]);
  return url ? <img className="team-qr" src={url} alt="WhatsApp pairing QR" /> : <div className="spinner" />;
}

const statusLabel: Record<string, string> = {
  connected: 'Connected',
  qr_pending: 'Scan the QR',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  banned: 'Banned by WhatsApp',
};

export function TeamManager() {
  const [inboxes, setInboxes] = useState<InboxDto[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInboxes(await getJson<InboxDto[]>('/api/v1/connections'));
    } catch {
      /* next poll/socket event retries */
    }
  }, []);

  useEffect(() => {
    void load();
    const s = getSocket();
    const onConn = (e: { connectionId: string; status: string; qr?: string }) =>
      setInboxes((prev) => {
        const i = prev.findIndex((x) => x.id === e.connectionId);
        if (i < 0) return prev; // unknown until the next load()
        const next = [...prev];
        next[i] = { ...next[i]!, status: e.status, qr: e.qr };
        return next;
      });
    s.on('connection.status', onConn);
    const poll = setInterval(() => void load(), 4000); // catch new inboxes + label/phone updates
    return () => {
      s.off('connection.status', onConn);
      clearInterval(poll);
    };
  }, [load]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await postJson('/api/v1/connections', { label: name.trim() || undefined });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Remove this number? Its chats and CRM links here will be deleted.')) return;
    setBusy(true);
    setError(null);
    try {
      await deleteJson(`/api/v1/connections/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>WhatsApp numbers (your team)</h2>
      <p className="settings__hint">
        Add each salesperson’s WhatsApp number — every conversation is logged to the right CRM
        contact and attributed to that person. Each number links with its own QR.
      </p>

      <div className="team-list">
        {inboxes.map((ib) => (
          <div className="team-row" key={ib.id}>
            <div className="team-row__head">
              <span className="inbox-dot" style={{ background: inboxColor(ib.id) }} />
              <div className="team-row__name">{inboxName(ib)}</div>
              <span
                className={`team-status ${ib.status === 'connected' ? 'ok' : ib.status === 'banned' ? 'bad' : 'warn'}`}
              >
                {statusLabel[ib.status] ?? ib.status}
              </span>
              {inboxes.length > 1 && (
                <button className="crm-btn danger team-remove" disabled={busy} onClick={() => void remove(ib.id)}>
                  Remove
                </button>
              )}
            </div>
            {ib.status !== 'connected' && ib.qr && (
              <div className="team-qrbox">
                <MiniQr value={ib.qr} />
                <div className="team-qrhint">
                  On {inboxName(ib)}’s phone: WhatsApp → Linked devices → Link a device → scan.
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="team-add">
        <input
          placeholder="Salesperson name (e.g. Ahmed)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <button className="crm-btn" disabled={busy} onClick={() => void add()}>
          + Add number
        </button>
      </div>
      {error && <div className="crm-flash" style={{ margin: '4px 0 0' }}>{error}</div>}
    </section>
  );
}
