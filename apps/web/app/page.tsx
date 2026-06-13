'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '@wcb/shared';
import {
  getJson,
  isUnauthorized,
  postJson,
  type ConversationDto,
  type InboxDto,
} from '../lib/api';
import { clearToken, getToken } from '../lib/auth';
import { getSocket } from '../lib/socket';
import { QrScreen } from '../components/QrScreen';
import { ChatList } from '../components/ChatList';
import { ConversationView } from '../components/ConversationView';
import { CrmPanel } from '../components/CrmPanel';
import { LoginScreen } from '../components/LoginScreen';

function upsert(list: Message[], incoming: Message): Message[] {
  const i = list.findIndex(
    (m) =>
      m.id === incoming.id ||
      (incoming.clientMessageId && m.clientMessageId === incoming.clientMessageId),
  );
  if (i >= 0) {
    const next = [...list];
    next[i] = { ...next[i], ...incoming };
    return next;
  }
  return [...list, incoming].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Auth gate (M7): ask the server if a password is required, then render login or the app. */
export default function Home() {
  const [gate, setGate] = useState<'checking' | 'login' | 'ok'>('checking');

  useEffect(() => {
    void (async () => {
      try {
        const { authRequired } = await getJson<{ authRequired: boolean }>('/api/v1/auth/status');
        if (!authRequired || !getToken()) {
          setGate(authRequired ? 'login' : 'ok');
          return;
        }
        try {
          await getJson('/api/v1/connection'); // probe: is the stored token still valid?
          setGate('ok');
        } catch (err) {
          if (isUnauthorized(err)) {
            clearToken();
            setGate('login');
          } else {
            setGate('ok'); // server hiccup — the app shell shows its offline state
          }
        }
      } catch {
        setGate('ok'); // can't reach the server at all — fall through to offline UI
      }
    })();
  }, []);

  if (gate === 'checking') {
    return <QrScreen status="connecting" qr={undefined} />;
  }
  if (gate === 'login') {
    return <LoginScreen onSuccess={() => setGate('ok')} />;
  }
  return <AppShell />;
}

function AppShell() {
  const [inboxes, setInboxes] = useState<InboxDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inboxFilter, setInboxFilter] = useState<string | null>(null); // null = all salespeople
  const [messages, setMessages] = useState<Message[]>([]);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await getJson<ConversationDto[]>('/api/v1/conversations'));
    } catch {
      /* server briefly unavailable — next event retries */
    }
  }, []);

  // Coalesce event-driven refetches: WhatsApp's history sync after pairing streams
  // thousands of message.created events in minutes — one request per event exhausts the
  // browser (ERR_INSUFFICIENT_RESOURCES). Leading call + at most one trailing per second.
  const refreshThrottle = useRef<{ timer: ReturnType<typeof setTimeout> | null; pending: boolean }>({
    timer: null,
    pending: false,
  });
  const scheduleRefresh = useCallback(() => {
    const t = refreshThrottle.current;
    if (t.timer) {
      t.pending = true;
      return;
    }
    void refreshConversations();
    t.timer = setTimeout(() => {
      t.timer = null;
      if (t.pending) {
        t.pending = false;
        scheduleRefresh();
      }
    }, 1000);
  }, [refreshConversations]);
  useEffect(() => {
    const t = refreshThrottle.current;
    return () => {
      if (t.timer) clearTimeout(t.timer);
    };
  }, []);

  const openConversation = useCallback(
    async (id: string) => {
      setSelectedId(id);
      try {
        setMessages(await getJson<Message[]>(`/api/v1/conversations/${id}/messages`));
        await postJson(`/api/v1/conversations/${id}/read`, {});
        await refreshConversations();
      } catch {
        /* ignore */
      }
    },
    [refreshConversations],
  );

  const syncInboxes = useCallback(async () => {
    try {
      setInboxes(await getJson<InboxDto[]>('/api/v1/connections'));
      setLoaded(true);
    } catch (err) {
      if (isUnauthorized(err)) {
        clearToken();
        window.location.reload();
        return;
      }
      setLoaded(true); // server hiccup — show whatever state we have
    }
  }, []);

  useEffect(() => {
    void syncInboxes();
    void refreshConversations();

    const s = getSocket();
    // Catch-up on (re)connect — events fired before our listeners attached are lost (docs/05 §6).
    const onSocketConnect = () => {
      void syncInboxes();
      void refreshConversations();
    };
    s.on('connect', onSocketConnect);
    // connection.status now carries a connectionId — update just that salesperson's inbox.
    const onConnection = (e: { connectionId: string; status: string; qr?: string }) => {
      setInboxes((prev) => {
        const i = prev.findIndex((x) => x.id === e.connectionId);
        if (i < 0) {
          return [...prev, { id: e.connectionId, label: null, phoneE164: null, status: e.status, qr: e.qr }];
        }
        const next = [...prev];
        next[i] = { ...next[i]!, status: e.status, qr: e.qr };
        return next;
      });
      if (e.status === 'connected') scheduleRefresh();
    };
    const onCreated = (e: { conversationId: string; message: Message }) => {
      if (e.conversationId === selectedRef.current) {
        setMessages((prev) => upsert(prev, e.message));
      }
      scheduleRefresh();
    };
    const onStatus = (e: {
      messageId: string;
      clientMessageId?: string;
      waMessageId?: string;
      status: Message['status'];
    }) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === e.messageId ||
          (e.waMessageId && m.waMessageId === e.waMessageId) ||
          (e.clientMessageId && m.clientMessageId === e.clientMessageId)
            ? { ...m, status: e.status }
            : m,
        ),
      );
    };
    s.on('connection.status', onConnection);
    s.on('message.created', onCreated);
    s.on('message.status', onStatus);
    return () => {
      s.off('connect', onSocketConnect);
      s.off('connection.status', onConnection);
      s.off('message.created', onCreated);
      s.off('message.status', onStatus);
    };
  }, [refreshConversations, scheduleRefresh, syncInboxes]);

  const anyConnected = inboxes.some((i) => i.status === 'connected');

  // Safety net while onboarding the first number: poll until something connects (docs/05 §6).
  useEffect(() => {
    if (anyConnected) return;
    const timer = setInterval(() => void syncInboxes(), 5000);
    return () => clearInterval(timer);
  }, [anyConnected, syncInboxes]);

  const send = useCallback(
    (text: string) => {
      const id = selectedRef.current;
      if (!id) return;
      const clientMessageId = `c_${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      // optimistic bubble (docs/05 §3) — reconciled by clientMessageId
      setMessages((prev) =>
        upsert(prev, {
          id: `tmp-${clientMessageId}`,
          conversationId: id,
          clientMessageId,
          direction: 'out',
          type: 'text',
          body: text,
          status: 'queued',
          timestamp: now,
          createdAt: now,
        }),
      );
      postJson<Message>(`/api/v1/conversations/${id}/messages`, { body: text, clientMessageId })
        .then((real) => setMessages((prev) => upsert(prev, real)))
        .catch(() =>
          setMessages((prev) =>
            prev.map((m) =>
              m.clientMessageId === clientMessageId ? { ...m, status: 'failed' } : m,
            ),
          ),
        );
    },
    [],
  );

  // Onboarding: until at least one number is linked, show the QR for the first inbox.
  if (!anyConnected) {
    const first = inboxes[0];
    return <QrScreen status={loaded ? (first?.status ?? 'connecting') : 'connecting'} qr={first?.qr} />;
  }

  const filtered =
    inboxFilter === null ? conversations : conversations.filter((c) => c.inbox.id === inboxFilter);
  const selected = filtered.find((c) => c.id === selectedId) ?? null;
  return (
    <div className={`app${selected ? ' with-crm' : ''}`}>
      <nav className="rail">
        <div className="logo">C</div>
        <div className="spacer" />
        <a className="rail-btn" href="/settings" title="Manage numbers & settings">
          ⚙
        </a>
        <div className="conn-pill">{anyConnected ? 'CONNECTED' : 'OFFLINE'}</div>
      </nav>
      <ChatList
        conversations={filtered}
        inboxes={inboxes}
        inboxFilter={inboxFilter}
        onFilter={setInboxFilter}
        selectedId={selectedId}
        onSelect={(id) => void openConversation(id)}
      />
      {selected ? (
        <>
          <ConversationView conversation={selected} messages={messages} onSend={send} />
          <CrmPanel conversationId={selected.id} />
        </>
      ) : (
        <main className="conv">
          <div className="conv-empty">
            <div>
              <div className="big">Select a conversation</div>
              Every salesperson’s chats in one place — synced live and logged to your CRM,
              attributed to the right person.
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
