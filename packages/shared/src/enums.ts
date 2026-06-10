import { z } from 'zod';

/** WhatsApp connection provider. */
export const Provider = z.enum(['baileys', 'cloud_api']);
export type Provider = z.infer<typeof Provider>;

/** Lifecycle of a WhatsApp connection/session. */
export const ConnectionStatus = z.enum([
  'disconnected',
  'connecting',
  'qr_pending',
  'connected',
  'banned',
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const MessageDirection = z.enum(['in', 'out']);
export type MessageDirection = z.infer<typeof MessageDirection>;

export const MessageType = z.enum([
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'contact',
  'system',
]);
export type MessageType = z.infer<typeof MessageType>;

/** Delivery lifecycle of a message. */
export const MessageStatus = z.enum(['queued', 'sent', 'delivered', 'read', 'failed']);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const CrmType = z.enum(['odoo', 'hubspot', 'salesforce', 'zoho', 'pipedrive', 'custom']);
export type CrmType = z.infer<typeof CrmType>;

/** Result of resolving a WhatsApp contact to a CRM record (docs/03 §5). */
export const CrmMatchStatus = z.enum(['matched', 'unmatched', 'ambiguous']);
export type CrmMatchStatus = z.infer<typeof CrmMatchStatus>;

/** State of syncing a message/conversation to a CRM. */
export const SyncStatus = z.enum(['pending', 'success', 'failed', 'dead_letter']);
export type SyncStatus = z.infer<typeof SyncStatus>;
