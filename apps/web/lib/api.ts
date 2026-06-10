import type { Message } from '@wcb/shared';
import { getToken } from './auth';

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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const isUnauthorized = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 401;

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function handle<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail || `${label} → ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: authHeaders() });
  return handle<T>(res, `GET ${path}`);
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  return handle<T>(res, `POST ${path}`);
}

export async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  return handle<T>(res, `PUT ${path}`);
}

export async function deleteJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { method: 'DELETE', headers: authHeaders() });
  return handle<T>(res, `DELETE ${path}`);
}

/** Authenticated download (e.g. the data export) saved via a temporary object URL. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new ApiError(res.status, `GET ${path} → ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export type { Message };
