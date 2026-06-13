// WaConnection helpers (M10): each connection = one salesperson's WhatsApp number/session.
// Conversations are already keyed by (contactId, waConnectionId), so every salesperson's
// thread with a customer is a distinct conversation — no cross-salesperson mixing.
import type { PrismaClient, WaConnection } from '@prisma/client';

export function listWaConnections(prisma: PrismaClient): Promise<WaConnection[]> {
  return prisma.waConnection.findMany({ orderBy: { createdAt: 'asc' } });
}

export function getWaConnection(prisma: PrismaClient, id: string): Promise<WaConnection | null> {
  return prisma.waConnection.findUnique({ where: { id } });
}

export function createWaConnection(
  prisma: PrismaClient,
  label?: string,
): Promise<WaConnection> {
  return prisma.waConnection.create({ data: { label: label?.trim() || null } });
}

export function updateWaConnection(
  prisma: PrismaClient,
  id: string,
  data: Partial<Pick<WaConnection, 'label' | 'phoneE164' | 'status'>>,
): Promise<WaConnection> {
  return prisma.waConnection.update({ where: { id }, data });
}

/**
 * Hard-delete a connection and everything under it: its conversations' sync logs and
 * messages, the conversations, then the connection. Contacts are shared across
 * connections, so they are left intact.
 */
export async function deleteWaConnection(prisma: PrismaClient, id: string): Promise<void> {
  const conversations = await prisma.conversation.findMany({
    where: { waConnectionId: id },
    select: { id: true },
  });
  const conversationIds = conversations.map((c) => c.id);
  await prisma.$transaction([
    prisma.syncLog.deleteMany({ where: { conversationId: { in: conversationIds } } }),
    prisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } }),
    prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } }),
    prisma.waConnection.delete({ where: { id } }),
  ]);
}
