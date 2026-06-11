import { Prisma, type PrismaClient } from '@prisma/client';
import type { ContactSync, InboundMessage } from '@wcb/shared';

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
  const contact = await resolveContact(prisma, inbound);

  let conversation;
  try {
    conversation = await prisma.conversation.upsert({
      where: { contactId_waConnectionId: { contactId: contact.id, waConnectionId } },
      create: { contactId: contact.id, waConnectionId },
      update: {},
    });
  } catch (err) {
    // Prisma upserts aren't atomic on SQLite — concurrent first-messages can both try to
    // create the conversation. The loser picks up the winner's row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      conversation = await prisma.conversation.findUnique({
        where: { contactId_waConnectionId: { contactId: contact.id, waConnectionId } },
      });
    }
    if (!conversation) throw err;
  }

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

/**
 * Find-or-create the contact for an inbound message, LID-aware (docs: WhatsApp privacy
 * LIDs). Resolution order: existing row by lidJid (survives connector restarts where the
 * in-memory lid directory is empty) → row by phoneE164 → create. Never lets a LID-derived
 * pseudo-number displace a real phone row, and never clobbers an address-book name with a
 * push name (the directory is authoritative for names — see syncContactDirectory).
 */
async function resolveContact(prisma: PrismaClient, inbound: InboundMessage) {
  if (inbound.lidJid) {
    const byLid = await prisma.contact.findFirst({ where: { lidJid: inbound.lidJid } });
    if (byLid) return byLid;
  }
  const existing = await prisma.contact.findUnique({ where: { phoneE164: inbound.phoneE164 } });
  if (existing) {
    return prisma.contact.update({
      where: { id: existing.id },
      data: {
        waId: inbound.remoteJid,
        ...(inbound.lidJid ? { lidJid: inbound.lidJid } : {}),
        ...(!existing.displayName && !inbound.fromMe && inbound.senderName
          ? { displayName: inbound.senderName }
          : {}),
      },
    });
  }
  try {
    return await prisma.contact.create({
      data: {
        phoneE164: inbound.phoneE164,
        waId: inbound.remoteJid,
        lidJid: inbound.lidJid,
        displayName: !inbound.fromMe ? inbound.senderName : undefined,
      },
    });
  } catch (err) {
    // P2002: two messages from a brand-new contact raced — the loser reuses the winner's row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.contact.findUnique({
        where: { phoneE164: inbound.phoneE164 },
      });
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Apply a WhatsApp directory batch (history sync / contacts.upsert): set names and LID
 * mappings, and ABSORB any LID-pseudo contact created before the directory arrived —
 * its conversations/messages are re-pointed at the real phone contact.
 *
 * Name-only entries (lid + displayName, no phone — all WhatsApp reveals on lid-migrated
 * accounts) just name the lid contact in place.
 */
export async function syncContactDirectory(
  prisma: PrismaClient,
  entries: ContactSync[],
): Promise<{ updated: number; merged: number }> {
  let updated = 0;
  let merged = 0;
  for (const entry of entries) {
    if (!entry.phoneE164) {
      if (!entry.lidJid) continue;
      // Find the contact this lid chat created (by lidJid, or by its pseudo-number).
      const lidPhone = `+${entry.lidJid.split('@')[0] ?? ''}`;
      const existing = await prisma.contact.findFirst({
        where: { OR: [{ lidJid: entry.lidJid }, { phoneE164: lidPhone }] },
      });
      if (existing && entry.displayName) {
        await prisma.contact.update({
          where: { id: existing.id },
          data: { displayName: entry.displayName, lidJid: entry.lidJid },
        });
        updated++;
      }
      continue;
    }

    const real = await prisma.contact.upsert({
      where: { phoneE164: entry.phoneE164 },
      create: {
        phoneE164: entry.phoneE164,
        waId: entry.waId,
        lidJid: entry.lidJid,
        displayName: entry.displayName,
      },
      update: {
        waId: entry.waId,
        ...(entry.lidJid ? { lidJid: entry.lidJid } : {}),
        ...(entry.displayName ? { displayName: entry.displayName } : {}),
      },
    });
    updated++;

    if (!entry.lidJid) continue;
    // A chat may have arrived before this directory entry, creating a contact keyed by
    // the LID digits. Merge it into the real contact.
    const lidPhone = `+${entry.lidJid.split('@')[0] ?? ''}`;
    const ghost = await prisma.contact.findUnique({ where: { phoneE164: lidPhone } });
    if (!ghost || ghost.id === real.id) continue;
    const ghostConversations = await prisma.conversation.findMany({
      where: { contactId: ghost.id },
    });
    for (const conv of ghostConversations) {
      const target = await prisma.conversation.findUnique({
        where: {
          contactId_waConnectionId: {
            contactId: real.id,
            waConnectionId: conv.waConnectionId,
          },
        },
      });
      if (target) {
        // Real contact already has a conversation on this connection — move messages over.
        await prisma.$transaction([
          prisma.message.updateMany({
            where: { conversationId: conv.id },
            data: { conversationId: target.id },
          }),
          prisma.syncLog.updateMany({
            where: { conversationId: conv.id },
            data: { conversationId: target.id },
          }),
          prisma.conversation.delete({ where: { id: conv.id } }),
        ]);
      } else {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { contactId: real.id },
        });
      }
    }
    await prisma.leadMapping.deleteMany({ where: { contactId: ghost.id } });
    await prisma.contact.delete({ where: { id: ghost.id } });
    merged++;
  }
  return { updated, merged };
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
