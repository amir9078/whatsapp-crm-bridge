'use client';
// CRM context panel (M6): shows the matched CRM record + sync state for the open
// conversation; unmatched numbers get "create" / "link existing" actions (docs/03 §5).
import { useCallback, useEffect, useState } from 'react';
import { getJson, postJson } from '../lib/api';
import { getSocket } from '../lib/socket';

interface CrmRecordDto {
  id: string;
  displayName?: string;
  url?: string;
  properties?: { phone?: string; mobile?: string; email?: string };
}

interface CrmPanelDto {
  integration: { crmType: string; status: string } | null;
  mapping: {
    status: 'matched' | 'unmatched' | 'ambiguous';
    crmRecordId: string | null;
    crmRecordName: string | null;
    crmRecordUrl: string | null;
    lastSyncedAt: string | null;
  } | null;
  pending: number;
  failed: number;
}

const crmLabel = (type: string): string =>
  type === 'odoo' ? 'Odoo' : type.charAt(0).toUpperCase() + type.slice(1);

export function CrmPanel({ conversationId }: { conversationId: string }) {
  const [data, setData] = useState<CrmPanelDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CrmRecordDto[] | null>(null);

  const refetch = useCallback(async () => {
    try {
      setData(await getJson<CrmPanelDto>(`/api/v1/conversations/${conversationId}/crm`));
    } catch {
      /* server briefly unavailable — next event refetches */
    }
  }, [conversationId]);

  useEffect(() => {
    setData(null);
    setQuery('');
    setResults(null);
    setFlash(null);
    void refetch();
    const s = getSocket();
    const onSync = (e: { conversationId?: string; status: string; error?: string }) => {
      if (e.conversationId !== conversationId) return;
      if (e.status === 'failed' || e.status === 'dead_letter') {
        setFlash(`Sync failed: ${e.error ?? 'unknown error'}`);
      } else if (e.status === 'success') {
        setFlash(null);
      }
      void refetch();
    };
    const onMatched = () => void refetch();
    s.on('crm.sync.status', onSync);
    s.on('contact.matched', onMatched);
    return () => {
      s.off('crm.sync.status', onSync);
      s.off('contact.matched', onMatched);
    };
  }, [conversationId, refetch]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setFlash(null);
    try {
      await fn();
      await refetch();
    } catch (err) {
      setFlash(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const search = () =>
    act(async () => {
      if (query.trim().length < 2) return;
      setResults(
        await getJson<CrmRecordDto[]>(
          `/api/v1/crm/contacts/search?q=${encodeURIComponent(query.trim())}`,
        ),
      );
    });

  const link = (r: CrmRecordDto) =>
    act(async () => {
      await postJson(`/api/v1/conversations/${conversationId}/crm/link`, {
        crmRecordId: r.id,
        crmRecordName: r.displayName,
        crmRecordUrl: r.url,
      });
      setResults(null);
      setQuery('');
    });

  const createRecord = () =>
    act(() => postJson(`/api/v1/conversations/${conversationId}/crm/create`, {}));

  const syncNow = () => act(() => postJson(`/api/v1/conversations/${conversationId}/crm/sync`, {}));

  if (!data) {
    return (
      <aside className="crm">
        <div className="crm__head">CRM</div>
        <div className="crm__hint">Loading…</div>
      </aside>
    );
  }

  if (!data.integration) {
    return (
      <aside className="crm">
        <div className="crm__head">CRM</div>
        <div className="crm__hint">
          No CRM connected yet.
          <br />
          Connect one in <a href="/settings">Settings</a> and conversations will be logged
          automatically.
        </div>
      </aside>
    );
  }

  const name = crmLabel(data.integration.crmType);
  const mapping = data.mapping;

  return (
    <aside className="crm">
      <div className="crm__head">
        CRM · {name}
        {data.integration.status !== 'active' && <span className="crm-chip warn">paused</span>}
      </div>

      {mapping?.status === 'matched' ? (
        <div className="crm-card">
          <div className="crm-card__name">{mapping.crmRecordName ?? `#${mapping.crmRecordId}`}</div>
          <div className="crm-card__meta">
            {name} contact #{mapping.crmRecordId}
          </div>
          {mapping.crmRecordUrl && (
            <a className="crm-link" href={mapping.crmRecordUrl} target="_blank" rel="noreferrer">
              Open in {name} ↗
            </a>
          )}
          <div className="crm-sync">
            {data.pending > 0 ? (
              <span className="crm-chip warn">{data.pending} unsynced</span>
            ) : (
              <span className="crm-chip ok">synced</span>
            )}
            {mapping.lastSyncedAt && (
              <span className="crm-sync__time">
                {new Date(mapping.lastSyncedAt).toLocaleString([], {
                  day: '2-digit',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            )}
          </div>
          <button className="crm-btn ghost" disabled={busy} onClick={() => void syncNow()}>
            Sync now
          </button>
        </div>
      ) : (
        <div className="crm-card">
          <div className="crm-card__name">
            {mapping?.status === 'ambiguous' ? 'Multiple matches' : 'Not in your CRM'}
          </div>
          <div className="crm-card__meta">
            {mapping?.status === 'ambiguous'
              ? `Several ${name} records share this number — pick the right one below.`
              : `No ${name} record matches this number.`}
          </div>
          {mapping?.status !== 'ambiguous' && (
            <button className="crm-btn" disabled={busy} onClick={() => void createRecord()}>
              + Create in {name}
            </button>
          )}
          <div className="crm-search">
            <input
              placeholder={`Search ${name} records…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void search();
              }}
            />
            <button className="crm-btn ghost" disabled={busy} onClick={() => void search()}>
              Search
            </button>
          </div>
          {results && results.length === 0 && <div className="crm__hint">No records found.</div>}
          {results?.map((r) => (
            <button key={r.id} className="crm-result" disabled={busy} onClick={() => void link(r)}>
              <span className="crm-result__name">{r.displayName ?? `#${r.id}`}</span>
              <span className="crm-result__meta">
                {r.properties?.phone ?? r.properties?.mobile ?? r.properties?.email ?? ''}
              </span>
              <span className="crm-result__action">Link</span>
            </button>
          ))}
        </div>
      )}

      {flash && <div className="crm-flash">{flash}</div>}
      <div className="crm__foot">
        Conversations auto-log to one running note on the matched record.
      </div>
    </aside>
  );
}
