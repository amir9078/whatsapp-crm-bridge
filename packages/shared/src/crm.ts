import type { CrmType } from './enums.js';

/**
 * Credentials for one CRM integration. For OAuth2 CRMs `accessToken` is the OAuth access
 * token; for API-key CRMs (e.g. Odoo) it holds the API key and `meta` carries the instance
 * coordinates (base URL, database, username). Stored encrypted at rest (M8).
 */
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
  /** Deep link to the record in the CRM's own UI, when the adapter can build one. */
  url?: string;
  properties?: Record<string, unknown>;
}

export interface ContactInput {
  phoneE164: string;
  displayName?: string;
  email?: string;
}

export interface NoteInput {
  /** Note body. May contain simple HTML — adapters strip/convert as their CRM requires. */
  body: string;
  /** ISO 8601 timestamp the note should be dated to. */
  occurredAt?: string;
}

export interface CrmNoteRef {
  id: string;
}

/** How the CRM authenticates third-party apps. Drives the settings UI (form vs. OAuth flow). */
export type CrmAuthKind = 'oauth2' | 'api_key';

/** Capability flags so the sync engine adapts per CRM (see docs/03 §6). */
export interface CrmCapabilities {
  supportsNoteUpdate: boolean;
  supportsActivities: boolean;
  rateLimitPerMin: number;
}

/**
 * One contract every CRM implements. Adding a CRM = writing one adapter; nothing else in the
 * system changes. Implemented per-CRM in `@wcb/crm` (M6: Odoo). Spec: docs/03 §6.
 */
export interface CrmAdapter {
  readonly type: CrmType;
  readonly authKind: CrmAuthKind;
  readonly capabilities: CrmCapabilities;

  // ── Auth ──
  /** Cheap end-to-end credentials check (settings screen "Test connection"). */
  testConnection(creds: CrmCredentials): Promise<{ ok: boolean; detail?: string }>;
  // OAuth2 lifecycle — only for `authKind === 'oauth2'` adapters.
  getAuthUrl?(state: string): string;
  exchangeCode?(code: string): Promise<CrmCredentials>;
  refresh?(creds: CrmCredentials): Promise<CrmCredentials>;

  // ── Lead matching ──
  findContactByPhone(phone: string, creds: CrmCredentials): Promise<CrmRecord[]>;
  /** Free-text search for the manual "link existing record" picker. */
  searchContacts?(query: string, creds: CrmCredentials): Promise<CrmRecord[]>;
  createContact(input: ContactInput, creds: CrmCredentials): Promise<CrmRecord>;

  // ── Sync target ──
  appendNote(recordId: string, note: NoteInput, creds: CrmCredentials): Promise<CrmNoteRef>;
  updateNote?(noteId: string, note: NoteInput, creds: CrmCredentials): Promise<void>;
  logActivity?(recordId: string, activity: NoteInput, creds: CrmCredentials): Promise<void>;
}
