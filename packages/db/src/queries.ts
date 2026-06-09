import type { PrismaClient } from '@prisma/client';

/** Chat list, newest activity first, with the contact attached. */
export function listConversations(prisma: PrismaClient, limit = 50) {
  return prisma.conversation.findMany({
    take: limit,
    orderBy: { lastMessageAt: 'desc' },
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
