import { z } from 'zod';
import { ConnectionStatus, CrmType, MessageStatus, SyncStatus } from './enums.js';
import { MessageSchema } from './message.js';
import { ConversationSchema } from './conversation.js';

/** Bump when an event payload shape changes (see docs/03 §7). */
export const SCHEMA_VERSION = 1;

const base = {
  ts: z.number().int(),
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
};

export const ConnectionStatusEvent = z.object({
  type: z.literal('connection.status'),
  connectionId: z.string(),
  status: ConnectionStatus,
  /** Present while status is `qr_pending`. */
  qr: z.string().optional(),
  ...base,
});

export const MessageCreatedEvent = z.object({
  type: z.literal('message.created'),
  conversationId: z.string(),
  message: MessageSchema,
  ...base,
});

export const MessageStatusEvent = z.object({
  type: z.literal('message.status'),
  conversationId: z.string().optional(),
  messageId: z.string(),
  waMessageId: z.string().optional(),
  clientMessageId: z.string().optional(),
  status: MessageStatus,
  ...base,
});

export const ConversationUpdatedEvent = z.object({
  type: z.literal('conversation.updated'),
  conversationId: z.string(),
  conversation: ConversationSchema,
  ...base,
});

export const ContactMatchedEvent = z.object({
  type: z.literal('contact.matched'),
  contactId: z.string(),
  crmType: CrmType,
  crmRecordId: z.string(),
  ...base,
});

export const CrmSyncStatusEvent = z.object({
  type: z.literal('crm.sync.status'),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
  status: SyncStatus,
  error: z.string().optional(),
  ...base,
});

/** The single event envelope that flows over the bus and WebSocket. Spec: docs/03 §4, docs/05. */
export const WhatsAppEvent = z.discriminatedUnion('type', [
  ConnectionStatusEvent,
  MessageCreatedEvent,
  MessageStatusEvent,
  ConversationUpdatedEvent,
  ContactMatchedEvent,
  CrmSyncStatusEvent,
]);
export type WhatsAppEvent = z.infer<typeof WhatsAppEvent>;
export type WhatsAppEventType = WhatsAppEvent['type'];

/** Handler for the canonical (server-side) event stream pushed to the bus / WebSocket. */
export type WhatsAppEventHandler = (event: WhatsAppEvent) => void;
