// CRM-sync persistence helpers (M6): integration config, lead mappings, and the sync_log
// idempotency ledger. Spec: docs/03 §5–6.
import type { LeadMapping, PrismaClient } from '@prisma/client';

export function getActiveIntegration(prisma: PrismaClient) {
  return prisma.crmIntegration.findFirst({
    where: { status: 'active' },
    orderBy: { createdAt: 'asc' },
  });
}

export function getAnyIntegration(prisma: PrismaClient) {
  return prisma.crmIntegration.findFirst({ orderBy: { createdAt: 'asc' } });
}

/** Single-integration v1: one row, replaced on save. Multi-CRM later = drop the findFirst. */
export async function saveIntegration(
  prisma: PrismaClient,
  data: { crmType: string; credentials?: string | null; config?: string; status?: string },
) {
  const existing = await prisma.crmIntegration.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!existing) return prisma.crmIntegration.create({ data });
  return prisma.crmIntegration.update({ where: { id: existing.id }, data });
}

export function getLeadMapping(prisma: PrismaClient, contactId: string, crmIntegrationId: string) {
  return prisma.leadMapping.findUnique({
    where: { contactId_crmIntegrationId: { contactId, crmIntegrationId } },
  });
}

export function upsertLeadMapping(
  prisma: PrismaClient,
  contactId: string,
  crmIntegrationId: string,
  data: Partial<
    Pick<
      LeadMapping,
      'status' | 'crmRecordType' | 'crmRecordId' | 'crmRecordName' | 'crmRecordUrl' | 'crmNoteId' | 'lastSyncedAt'
    >
  >,
) {
  return prisma.leadMapping.upsert({
    where: { contactId_crmIntegrationId: { contactId, crmIntegrationId } },
    create: { contactId, crmIntegrationId, ...data },
    update: data,
  });
}

/** Messages in a conversation not yet successfully synced to this integration. */
export function listUnsyncedMessages(
  prisma: PrismaClient,
  conversationId: string,
  crmIntegrationId: string,
) {
  return prisma.message.findMany({
    where: { conversationId, syncLogs: { none: { crmIntegrationId, status: 'success' } } },
    orderBy: { timestamp: 'asc' },
  });
}

/** Idempotent success marker: UNIQUE(messageId, crmIntegrationId) makes retries no-ops. */
export async function markMessagesSynced(
  prisma: PrismaClient,
  messageIds: string[],
  conversationId: string,
  crmIntegrationId: string,
): Promise<void> {
  const syncedAt = new Date();
  await prisma.$transaction(
    messageIds.map((messageId) =>
      prisma.syncLog.upsert({
        where: { messageId_crmIntegrationId: { messageId, crmIntegrationId } },
        create: {
          messageId,
          conversationId,
          crmIntegrationId,
          status: 'success',
          attempts: 1,
          syncedAt,
        },
        update: { status: 'success', attempts: { increment: 1 }, syncedAt, lastError: null },
      }),
    ),
  );
}

/**
 * Record a failed flush for every affected message; past `maxAttempts` the rows flip to
 * dead_letter. Returns the highest attempt count seen (drives the caller's backoff).
 */
export async function recordSyncFailure(
  prisma: PrismaClient,
  messageIds: string[],
  conversationId: string,
  crmIntegrationId: string,
  error: string,
  maxAttempts = 5,
): Promise<number> {
  let maxSeen = 0;
  for (const messageId of messageIds) {
    const row = await prisma.syncLog.upsert({
      where: { messageId_crmIntegrationId: { messageId, crmIntegrationId } },
      create: {
        messageId,
        conversationId,
        crmIntegrationId,
        status: 'failed',
        attempts: 1,
        lastError: error,
      },
      update: { status: 'failed', attempts: { increment: 1 }, lastError: error },
    });
    if (row.attempts >= maxAttempts) {
      await prisma.syncLog.update({ where: { id: row.id }, data: { status: 'dead_letter' } });
    }
    maxSeen = Math.max(maxSeen, row.attempts);
  }
  return maxSeen;
}

/** Counters for the UI's CRM panel: how much of this conversation is still unsynced/failing. */
export async function syncCounts(
  prisma: PrismaClient,
  conversationId: string,
  crmIntegrationId: string,
): Promise<{ pending: number; failed: number }> {
  const [pending, failed] = await Promise.all([
    prisma.message.count({
      where: { conversationId, syncLogs: { none: { crmIntegrationId, status: 'success' } } },
    }),
    prisma.syncLog.count({
      where: { conversationId, crmIntegrationId, status: { in: ['failed', 'dead_letter'] } },
    }),
  ]);
  return { pending, failed };
}
