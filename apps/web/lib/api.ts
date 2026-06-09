import type { Message } from '@wcb/shared';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface ConversationDto {
  id: string;
  contactId: string;
  waConnectionId: string;
  lastMessageAt: string | null;
  unreadCount: number;
  createdAt: string;
  contact: {
    id: string;
    phoneE164: string;
    displayName: string | null;
    waId: string | null;
  };
}

export interface ConnectionDto {
  id: string;
  status: string;
  qr?: string;
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export type { Message };
