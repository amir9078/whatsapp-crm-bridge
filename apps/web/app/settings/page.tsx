'use client';
// Settings (M7): WhatsApp connection status, CRM (Odoo) credentials + sync options, logout.
// CRM creds live in the DB via PUT /crm/integration — no .env editing required.
import { useCallback, useEffect, useState } from 'react';
import {
  deleteJson,
  downloadFile,
  getJson,
  isUnauthorized,
  postJson,
  putJson,
  type ConnectionDto,
} from '../../lib/api';
import { clearToken } from '../../lib/auth';

interface IntegrationDto {
  id: string;
  crmType: string;
  status: string;
  config: { autoCreate?: boolean; debounceMs?: number; transcriptLimit?: number };
  credentials: {
    baseUrl?: string;
    db?: string;
    username?: string;
    apiKeySet?: boolean;
    apiKeyHint?: string | null;
  } | null;
}

interface OdooForm {
  baseUrl: string;
  db: string;
  username: string;
  apiKey: string;
  autoCreate: boolean;
  debounceSec: number;
}

const DEFAULT_FORM: OdooForm = {
  baseUrl: '',
  db: '',
  username: '',
  apiKey: '',
  autoCreate: false,
  debounceSec: 8,
};

export default function SettingsPage() {
  const [conn, setConn] = useState<ConnectionDto | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [form, setForm] = useState<OdooForm>(DEFAULT_FORM);
  const [apiKeyHint, setApiKeyHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const set = (patch: Partial<OdooForm>) => setForm((f) => ({ ...f, ...patch }));

  const load = useCallback(async () => {
    try {
      const [c, integ, auth] = await Promise.all([
        getJson<ConnectionDto>('/api/v1/connection'),
        getJson<IntegrationDto | null>('/api/v1/crm/integration'),
        getJson<{ authRequired: boolean }>('/api/v1/auth/status'),
      ]);
      setConn(c);
      setAuthRequired(auth.authRequired);
      if (integ?.credentials) {
        setForm({
          baseUrl: integ.credentials.baseUrl ?? '',
          db: integ.credentials.db ?? '',
          username: integ.credentials.username ?? '',
          apiKey: '',
          autoCreate: integ.config.autoCreate ?? false,
          debounceSec: Math.round((integ.config.debounceMs ?? 8000) / 1000),
        });
        setApiKeyHint(integ.credentials.apiKeyHint ?? null);
      }
    } catch (err) {
      if (isUnauthorized(err)) window.location.href = '/';
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const body = () => ({
    crmType: 'odoo' as const,
    credentials: {
      baseUrl: form.baseUrl.trim(),
      db: form.db.trim(),
      username: form.username.trim(),
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
    },
    config: {
      autoCreate: form.autoCreate,
      debounceMs: Math.max(1, form.debounceSec) * 1000,
    },
  });

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const test = () =>
    act(async () => {
      const res = await postJson<{ ok: boolean; detail?: string }>(
        '/api/v1/crm/integration/test',
        body(),
      );
      setNotice(
        res.ok
          ? { kind: 'ok', text: 'Connection OK — Odoo accepted the credentials.' }
          : { kind: 'err', text: res.detail ?? 'Connection failed.' },
      );
    });

  const save = () =>
    act(async () => {
      await putJson('/api/v1/crm/integration', body());
      setForm((f) => ({ ...f, apiKey: '' }));
      setNotice({ kind: 'ok', text: 'Saved. New messages will sync to Odoo.' });
      await load();
    });

  const logout = () => {
    clearToken();
    window.location.href = '/';
  };

  const exportData = () =>
    act(async () => {
      await downloadFile(
        '/api/v1/data/export',
        `wcb-export-${new Date().toISOString().slice(0, 10)}.json`,
      );
      setNotice({ kind: 'ok', text: 'Export downloaded.' });
    });

  const wipeData = () => {
    if (
      !window.confirm(
        'Delete ALL chats, contacts and CRM links stored by this app? ' +
          'Your WhatsApp link and CRM settings are kept. This cannot be undone.',
      )
    )
      return;
    void act(async () => {
      const res = await deleteJson<{ deleted: { messages: number } }>('/api/v1/data?confirm=ALL');
      setNotice({ kind: 'ok', text: `Deleted — ${res.deleted.messages} messages wiped.` });
    });
  };

  const formReady = form.baseUrl && form.db && form.username && (form.apiKey || apiKeyHint);

  return (
    <div className="settings">
      <div className="settings__card">
        <div className="settings__head">
          <a className="settings__back" href="/">
            ←
          </a>
          <h1>Settings</h1>
          {authRequired && (
            <button className="crm-btn ghost settings__logout" onClick={logout}>
              Log out
            </button>
          )}
        </div>

        <section>
          <h2>WhatsApp</h2>
          <div className="settings__row">
            <span className={`dot ${conn?.status === 'connected' ? '' : 'dot--warn'}`} />
            {conn === null
              ? 'Checking connection…'
              : conn.status === 'connected'
                ? 'Connected — chats are syncing.'
                : `Status: ${conn.status}. Open the inbox to scan the QR code.`}
          </div>
        </section>

        <section>
          <h2>CRM — Odoo</h2>
          <p className="settings__hint">
            Conversations are logged as one running note on the matched contact. Create an API
            key in Odoo under <i>Settings → My Profile → Account Security → New API Key</i>.
          </p>
          <label>
            Odoo URL
            <input
              placeholder="https://yourcompany.odoo.com"
              value={form.baseUrl}
              onChange={(e) => set({ baseUrl: e.target.value })}
            />
          </label>
          <div className="settings__grid">
            <label>
              Database
              <input
                placeholder="yourcompany"
                value={form.db}
                onChange={(e) => set({ db: e.target.value })}
              />
            </label>
            <label>
              Username (login email)
              <input
                placeholder="api-user@yourcompany.com"
                value={form.username}
                onChange={(e) => set({ username: e.target.value })}
              />
            </label>
          </div>
          <label>
            API key
            <input
              type="password"
              placeholder={apiKeyHint ? `saved (${apiKeyHint}) — leave blank to keep` : 'API key'}
              value={form.apiKey}
              onChange={(e) => set({ apiKey: e.target.value })}
            />
          </label>
          <div className="settings__grid">
            <label className="settings__check">
              <input
                type="checkbox"
                checked={form.autoCreate}
                onChange={(e) => set({ autoCreate: e.target.checked })}
              />
              Auto-create unknown contacts in Odoo
            </label>
            <label>
              Sync quiet period (seconds)
              <input
                type="number"
                min={1}
                max={300}
                value={form.debounceSec}
                onChange={(e) => set({ debounceSec: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="settings__actions">
            <button
              className="crm-btn ghost"
              disabled={busy || !formReady}
              onClick={() => void test()}
            >
              Test connection
            </button>
            <button className="crm-btn" disabled={busy || !formReady} onClick={() => void save()}>
              Save
            </button>
          </div>
          {notice && (
            <div className={notice.kind === 'ok' ? 'settings__ok' : 'crm-flash'}>{notice.text}</div>
          )}
        </section>

        <section>
          <h2>Your data</h2>
          <p className="settings__hint">
            Everything lives in your own database. Export it as JSON anytime, or wipe the local
            chat archive (your WhatsApp link and CRM settings are kept).
          </p>
          <div className="settings__actions" style={{ justifyContent: 'flex-start' }}>
            <button className="crm-btn ghost" disabled={busy} onClick={() => void exportData()}>
              Download export (JSON)
            </button>
            <button className="crm-btn danger" disabled={busy} onClick={wipeData}>
              Delete all chat data…
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
