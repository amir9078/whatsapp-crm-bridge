import type { PrismaClient } from '@prisma/client';

/**
 * Chat list, newest activity first, with the contact attached.
 *
 * `nulls: 'last'` is load-bearing for dev/prod parity: a conversation with no activity yet
 * (lastMessageAt = NULL) sorts to the BOTTOM. Without it, Postgres' default (NULLS FIRST on
 * DESC) floats empty conversations to the TOP of the inbox, while SQLite sorts them last —
 * so the bug only shows up in the Docker/Postgres deployment, never in dev or tests.
 */
export function listConversations(prisma: PrismaClient, limit = 2000) {
  return prisma.conversation.findMany({
    take: limit,
    orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    include: { contact: true, waConnection: true },
  });
}

/**
 * Message history for one conversation, oldest→newest (UI renders top-down). Returns the
 * most recent `limit` messages (then re-sorted ascending) so very long chats stay bounded
 * while always showing the latest, not the oldest.
 */
export async function listMessages(prisma: PrismaClient, conversationId: string, limit = 1000) {
  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
  return rows.reverse();
}
