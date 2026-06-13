import type { PrismaClient } from '@prisma/client';

/**
 * Chat list, newest activity first, with the contact attached.
 *
 * `nulls: 'last'` is load-bearing for dev/prod parity: a conversation with no activity yet
 * (lastMessageAt = NULL) sorts to the BOTTOM. Without it, Postgres' default (NULLS FIRST on
 * DESC) floats empty conversations to the TOP of the inbox, while SQLite sorts them last —
 * so the bug only shows up in the Docker/Postgres deployment, never in dev or tests.
 */
export function listConversations(prisma: PrismaClient, limit = 50) {
  return prisma.conversation.findMany({
    take: limit,
    orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    include: { contact: true },
  });
}

/** Message history for one conversation, oldest→newest (UI renders top-down). */
export function listMessages(prisma: PrismaClient, conversationId: string, limit = 100) {
  return prisma.message.findMany({
    where: { conversationId },
    orderBy: { timestamp: 'asc' },
    take: limit,
  });
}
