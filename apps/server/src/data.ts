// Data-subject rights + retention (M8, docs/04 §5.3 + §5.5): machine-readable export,
// hard-delete per contact, full wipe, and the retention purge used by the sweeper.
// Credentials are deliberately excluded from exports.
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@wcb/db';

export interface DataRouteDeps {
  prisma: PrismaClient;
}

/** Hard-delete messages older than `days`, with their sync ledger rows. */
export async function purgeOldMessages(
  prisma: PrismaClient,
  days: number,
): Promise<{ messages: number }> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const old = await prisma.message.findMany({
    where: { timestamp: { lt: cutoff } },
    select: { id: true },
  });
  if (old.length === 0) return { messages: 0 };
  const ids = old.map((m) => m.id);
  await prisma.$transaction([
    prisma.syncLog.deleteMany({ where: { messageId: { in: ids } } }),
    prisma.message.deleteMany({ where: { id: { in: ids } } }),
  ]);
  return { messages: ids.length };
}

/** Everything tied to one contact: sync ledger → messages → mappings → conversations → contact. */
async function eraseContact(prisma: PrismaClient, contactId: string): Promise<void> {
  const conversations = await prisma.conversation.findMany({
    where: { contactId },
    select: { id: true },
  });
  const conversationIds = conversations.map((c) => c.id);
  await prisma.$transaction([
    prisma.syncLog.deleteMany({ where: { conversationId: { in: conversationIds } } }),
    prisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } }),
    prisma.leadMapping.deleteMany({ where: { contactId } }),
    prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } }),
    prisma.contact.delete({ where: { id: contactId } }),
  ]);
}

export function registerDataRoutes(app: FastifyInstance, { prisma }: DataRouteDeps): void {
  /** Right of access / portability: one JSON bundle of all chat data. No credentials. */
  app.get('/api/v1/data/export', async (req, reply) => {
    const [connections, contacts, conversations, mappings, integration] = await Promise.all([
      prisma.waConnection.findMany(),
      prisma.contact.findMany(),
      prisma.conversation.findMany({
        include: { messages: { orderBy: { timestamp: 'asc' } } },
      }),
      prisma.leadMapping.findMany(),
      prisma.crmIntegration.findFirst(),
    ]);
    const stamp = new Date().toISOString();
    void reply.header(
      'content-disposition',
      `attachment; filename="wcb-export-${stamp.slice(0, 10)}.json"`,
    );
    return {
      exportedAt: stamp,
      schemaVersion: 1,
      waConnections: connections,
      contacts,
      conversations,
      leadMappings: mappings,
      crmIntegration: integration
        ? { crmType: integration.crmType, status: integration.status, config: integration.config }
        : null, // credentials intentionally omitted
    };
  });

  /** Right to erasure: hard-delete one contact and every trace of their conversations. */
  app.delete('/api/v1/contacts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const contact = await prisma.contact.findUnique({ where: { id } });
    if (!contact) return reply.code(404).send({ error: 'contact not found' });
    await eraseContact(prisma, id);
    return { ok: true, deletedContactId: id };
  });

  /** Full local wipe (keeps the WhatsApp link + CRM integration). Requires ?confirm=ALL. */
  app.delete('/api/v1/data', async (req, reply) => {
    const { confirm } = req.query as { confirm?: string };
    if (confirm !== 'ALL') {
      return reply
        .code(400)
        .send({ error: 'destructive: re-send with ?confirm=ALL to wipe all chat data' });
    }
    const [syncLogs, messages, mappings, conversations, contacts] = await prisma.$transaction([
      prisma.syncLog.deleteMany(),
      prisma.message.deleteMany(),
      prisma.leadMapping.deleteMany(),
      prisma.conversation.deleteMany(),
      prisma.contact.deleteMany(),
    ]);
    return {
      ok: true,
      deleted: {
        syncLogs: syncLogs.count,
        messages: messages.count,
        leadMappings: mappings.count,
        conversations: conversations.count,
        contacts: contacts.count,
      },
    };
  });
}
