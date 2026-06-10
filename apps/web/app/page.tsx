'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '@wcb/shared';
import { getJson, postJson, type ConnectionDto, type ConversationDto } from '../lib/api';
import { getSocket } from '../lib/socket';
import { QrScreen } from '../components/QrScreen';
import { ChatList } from '../components/ChatList';
import { ConversationView } from '../components/ConversationView';
import { CrmPanel } from '../components/CrmPanel';

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

export default function Home() {
  const [connStatus, setConnStatus] = useState('connecting');
  const [qr, setQr] = useState<string>();
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const syncConnection = useCallback(async () => {
    try {
      const c = await getJson<ConnectionDto>('/api/v1/connection');
      setConnStatus(c.status);
      setQr(c.qr);
    } catch {
      setConnStatus('server_offline');
    }
  }, []);

  useEffect(() => {
    void syncConnection();
    void refreshConversations();

    const s = getSocket();
    // Catch-up on (re)connect — events fired before our listeners attached are lost (docs/05 §6).
    const onSocketConnect = () => {
      void syncConnection();
      void refreshConversations();
    };
    s.on('connect', onSocketConnect);
    const onConnection = (e: { status: string; qr?: string }) => {
      setConnStatus(e.status);
      setQr(e.qr);
      if (e.status === 'connected') void refreshConversations();
    };
    const onCreated = (e: { conversationId: string; message: Message }) => {
      if (e.conversationId === selectedRef.current) {
        setMessages((prev) => upsert(prev, e.message));
      }
      void refreshConversations();
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
  }, [refreshConversations, syncConnection]);

  // Safety net while pairing: poll until connected even if the socket misbehaves (docs/05 §6).
  useEffect(() => {
    if (connStatus === 'connected') return;
    const timer = setInterval(() => void syncConnection(), 5000);
    return () => clearInterval(timer);
  }, [connStatus, syncConnection]);

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

  if (connStatus !== 'connected') {
    return <QrScreen status={connStatus} qr={qr} />;
  }

  const selected = conversations.find((c) => c.id === selectedId) ?? null;
  return (
    <div className={`app${selected ? ' with-crm' : ''}`}>
      <nav className="rail">
        <div className="logo">C</div>
        <div className="spacer" />
        <div className="conn-pill">CONNECTED</div>
      </nav>
      <ChatList
        conversations={conversations}
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
              Your chats are synced in real time and logged to your CRM automatically.
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
