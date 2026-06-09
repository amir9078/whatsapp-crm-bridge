import { Prisma, type PrismaClient } from '@prisma/client';
import type { InboundMessage } from '@wcb/shared';

export interface IngestResult {
  messageId: string;
  conversationId: string;
  contactId: string;
  /** false when this exact message (by waMessageId) was already stored — duplicate ignored. */
  created: boolean;
}

/** Get-or-create the WaConnection row that owns a session (the connector's identity in the DB). */
export async function ensureConnection(
  prisma: PrismaClient,
  opts: { id?: string; phoneE164?: string; provider?: string } = {},
): Promise<string> {
  if (opts.id) {
    const existing = await prisma.waConnection.findUnique({ where: { id: opts.id } });
    if (existing) return existing.id;
  }
  const first = await prisma.waConnection.findFirst({ orderBy: { createdAt: 'asc' } });
  if (first) return first.id;
  const created = await prisma.waConnection.create({
    data: { phoneE164: opts.phoneE164, provider: opts.provider ?? 'baileys' },
  });
  return created.id;
}

/**
 * Persist one inbound/outbound message idempotently (docs/05 §4):
 * upsert contact → upsert conversation → insert message (unique on conversationId+waMessageId;
 * a replayed event is a no-op) → only then bump lastMessageAt/unread, so duplicates never
 * double-count.
 */
export async function ingestInboundMessage(
  prisma: PrismaClient,
  waConnectionId: string,
  inbound: InboundMessage,
): Promise<IngestResult> {
  const contact = await prisma.contact.upsert({
    where: { phoneE164: inbound.phoneE164 },
    create: {
      phoneE164: inbound.phoneE164,
      waId: inbound.remoteJid,
      displayName: !inbound.fromMe ? inbound.senderName : undefined,
    },
    update: {
      waId: inbound.remoteJid,
      ...(!inbound.fromMe && inbound.senderName ? { displayName: inbound.senderName } : {}),
    },
  });

  const conversation = await prisma.conversation.upsert({
    where: { contactId_waConnectionId: { contactId: contact.id, waConnectionId } },
    create: { contactId: contact.id, waConnectionId },
    update: {},
  });

  const timestamp = new Date(inbound.timestamp);
  try {
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        waMessageId: inbound.waMessageId,
        direction: inbound.fromMe ? 'out' : 'in',
        type: inbound.type,
        body: inbound.body,
        mediaMeta: inbound.media ? JSON.stringify(inbound.media) : undefined,
        status: inbound.fromMe ? 'sent' : undefined,
        senderName: inbound.senderName,
        timestamp,
      },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: timestamp,
        ...(inbound.fromMe || inbound.historySync ? {} : { unreadCount: { increment: 1 } }),
      },
    });
    return {
      messageId: message.id,
      conversationId: conversation.id,
      contactId: contact.id,
      created: true,
    };
  } catch (err) {
    // P2002 = unique violation → this waMessageId was already ingested. Replay-safe no-op.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      inbound.waMessageId
    ) {
      const existing = await prisma.message.findUnique({
        where: {
          conversationId_waMessageId: {
            conversationId: conversation.id,
            waMessageId: inbound.waMessageId,
          },
        },
      });
      if (existing) {
        return {
          messageId: existing.id,
          conversationId: conversation.id,
          contactId: contact.id,
          created: false,
        };
      }
    }
    throw err;
  }
}

/** Update a message's delivery status by provider id (from `message-status` connector events). */
export async function updateMessageStatus(
  prisma: PrismaClient,
  waMessageId: string,
  status: string,
): Promise<number> {
  const result = await prisma.message.updateMany({ where: { waMessageId }, data: { status } });
  return result.count;
}
