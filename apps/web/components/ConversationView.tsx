'use client';
import { useEffect, useRef, useState } from 'react';
import type { Message } from '@wcb/shared';
import type { ConversationDto } from '../lib/api';
import { avatarColor, initials } from './ChatList';

function Ticks({ status }: { status?: string }) {
  if (!status || status === 'queued') return <span className="ticks">🕓</span>;
  if (status === 'failed') return <span className="ticks failed">!</span>;
  const read = status === 'read';
  const double = status === 'delivered' || read;
  return <span className={`ticks ${read ? 'read' : ''}`}>{double ? '✓✓' : '✓'}</span>;
}

function bubbleBody(m: Message): React.ReactNode {
  if (m.type === 'text' || m.body) return <span className="txt">{m.body}</span>;
  return <span className="media-hint">[{m.type}]</span>;
}

export function ConversationView({
  conversation,
  messages,
  onSend,
}: {
  conversation: ConversationDto;
  messages: Message[];
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const msgsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Scroll ONLY the message container. scrollIntoView walks every scrollable ancestor —
    // when a browser extension inflates the document, it scrolls the whole page and
    // shoves the app's headers out of the viewport.
    const el = msgsRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  const name = conversation.contact.displayName ?? conversation.contact.phoneE164;

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };

  return (
    <main className="conv">
      <header className="conv__head">
        <div
          className="av"
          style={{ background: avatarColor(conversation.contact.phoneE164), width: 44, height: 44, fontSize: 15 }}
        >
          {initials(name)}
        </div>
        <div>
          <div className="nm">{name}</div>
          <div className="st">{conversation.contact.phoneE164}</div>
        </div>
      </header>
      <div className="msgs" ref={msgsRef}>
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.direction}`}>
            <div className="bubble">
              {bubbleBody(m)}
              <span className="meta">
                {new Date(m.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {m.direction === 'out' && <Ticks status={m.status} />}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="composer">
        <div className="field">
          <textarea
            rows={1}
            placeholder="Type a message…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <button className="send" onClick={submit} title="Send">
          ➤
        </button>
      </div>
    </main>
  );
}
