import type { DbContact, DbConversation, DbMessage } from '@wcb/db';
import type { Message } from '@wcb/shared';

/** Prisma row → canonical shared Message (what the API and WebSocket speak). */
export function toSharedMessage(row: DbMessage): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    waMessageId: row.waMessageId ?? undefined,
    clientMessageId: row.clientMessageId ?? undefined,
    direction: row.direction as Message['direction'],
    type: row.type as Message['type'],
    body: row.body ?? undefined,
    media: row.mediaMeta ? (JSON.parse(row.mediaMeta) as Message['media']) : undefined,
    status: (row.status ?? undefined) as Message['status'],
    senderName: row.senderName ?? undefined,
    timestamp: row.timestamp.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

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

export function toConversationDto(row: DbConversation & { contact: DbContact }): ConversationDto {
  return {
    id: row.id,
    contactId: row.contactId,
    waConnectionId: row.waConnectionId,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    unreadCount: row.unreadCount,
    createdAt: row.createdAt.toISOString(),
    contact: {
      id: row.contact.id,
      phoneE164: row.contact.phoneE164,
      displayName: row.contact.displayName,
      waId: row.contact.waId,
    },
  };
}
