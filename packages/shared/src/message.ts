import { z } from 'zod';
import { MessageDirection, MessageStatus, MessageType } from './enums.js';

/** Attachment metadata. The blob itself lives in object storage; `url` is its key/signed URL. */
export const MediaMetaSchema = z.object({
  url: z.string().optional(),
  mimeType: z.string().optional(),
  fileName: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  durationSec: z.number().nonnegative().optional(),
  thumbnailUrl: z.string().optional(),
});
export type MediaMeta = z.infer<typeof MediaMetaSchema>;

/** A single message. `waMessageId` + `(conversationId)` are the idempotency key. Spec: docs/03 §2. */
export const MessageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  /** Provider message id — used to dedupe inbound and reconcile status. */
  waMessageId: z.string().optional(),
  /** Client-generated id for optimistic send + dedupe. */
  clientMessageId: z.string().optional(),
  direction: MessageDirection,
  type: MessageType,
  /** Text body or media caption. */
  body: z.string().optional(),
  media: MediaMetaSchema.optional(),
  status: MessageStatus.optional(),
  senderName: z.string().optional(),
  /** When the message was sent/received (provider time), ISO 8601. */
  timestamp: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof MessageSchema>;
