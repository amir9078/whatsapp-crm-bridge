'use client';
import { useState } from 'react';
import type { ConversationDto } from '../lib/api';

const AVATAR_COLORS = ['#2E9E78', '#3F7AE0', '#C06BD6', '#E08B3F', '#D6536B', '#4FA8B8', '#8B6FD6'];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? '#2E9E78';
}

export function initials(name: string): string {
  const parts = name.replace('+', '').split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  return name.replace('+', '').slice(0, 2).toUpperCase();
}

export function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function ChatList({
  conversations,
  selectedId,
  phone,
  onSelect,
}: {
  conversations: ConversationDto[];
  selectedId: string | null;
  phone?: string;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = q
    ? conversations.filter((c) =>
        (c.contact.displayName ?? c.contact.phoneE164).toLowerCase().includes(q),
      )
    : conversations;

  return (
    <section className="list">
      <div className="list__top">
        <div className="wordmark">
          Chat<span>Bridge</span>
        </div>
        <div className="conn">
          <span className="dot" /> Connected{phone ? ` as ${phone}` : ''} · WhatsApp
        </div>
        <div className="search">
          <input
            placeholder="Search chats or contacts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="threads">
        {filtered.length === 0 ? (
          <div className="empty">
            No conversations yet.
            <br />
            Messages will appear here as they arrive — recent chats sync in shortly after linking.
          </div>
        ) : (
          filtered.map((c) => {
            const name = c.contact.displayName ?? c.contact.phoneE164;
            return (
              <button
                key={c.id}
                className={`thread ${c.id === selectedId ? 'active' : ''}`}
                onClick={() => onSelect(c.id)}
              >
                <div className="av" style={{ background: avatarColor(c.contact.phoneE164) }}>
                  {initials(name)}
                </div>
                <div className="t-main">
                  <div className="t-name">{name}</div>
                  <div className="t-prev">{c.contact.phoneE164}</div>
                </div>
                <div className="t-side">
                  <span className="t-time">{fmtTime(c.lastMessageAt)}</span>
                  {c.unreadCount > 0 && <span className="t-badge">{c.unreadCount}</span>}
                </div>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}
