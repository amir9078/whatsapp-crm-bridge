import type { CrmType } from './enums.js';

export interface CrmCredentials {
  accessToken: string;
  refreshToken?: string;
  /** ISO 8601 expiry of the access token. */
  expiresAt?: string;
  meta?: Record<string, unknown>;
}

export interface CrmRecord {
  id: string;
  type: 'contact' | 'lead' | 'deal';
  displayName?: string;
  properties?: Record<string, unknown>;
}

export interface ContactInput {
  phoneE164: string;
  displayName?: string;
  email?: string;
}

export interface NoteInput {
  body: string;
  /** ISO 8601 timestamp the note should be dated to. */
  occurredAt?: string;
}

export interface CrmNoteRef {
  id: string;
}

/** Capability flags so the sync engine adapts per CRM (see docs/03 §6). */
export interface CrmCapabilities {
  supportsNoteUpdate: boolean;
  supportsActivities: boolean;
  rateLimitPerMin: number;
}

/**
 * One contract every CRM implements. Adding a CRM = writing one adapter; nothing else in the
 * system changes. Implemented per-CRM in `@wcb/crm` (M6). Spec: docs/03 §6.
 */
export interface CrmAdapter {
  readonly type: CrmType;
  readonly capabilities: CrmCapabilities;

  // ── Auth (OAuth2) ──
  getAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<CrmCredentials>;
  refresh(creds: CrmCredentials): Promise<CrmCredentials>;

  // ── Lead matching ──
  findContactByPhone(phone: string, creds: CrmCredentials): Promise<CrmRecord[]>;
  createContact(input: ContactInput, creds: CrmCredentials): Promise<CrmRecord>;

  // ── Sync target ──
  appendNote(recordId: string, note: NoteInput, creds: CrmCredentials): Promise<CrmNoteRef>;
  updateNote?(noteId: string, note: NoteInput, creds: CrmCredentials): Promise<void>;
  logActivity?(recordId: string, activity: NoteInput, creds: CrmCredentials): Promise<void>;
}
