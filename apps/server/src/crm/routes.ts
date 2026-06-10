// CRM REST endpoints (M6): integration settings (consumed by the M7 settings screen),
// per-conversation sync status, and the manual unmatched → create/link actions.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@wcb/db';
import {
  getActiveIntegration,
  getAnyIntegration,
  getLeadMapping,
  saveIntegration,
  syncCounts,
  upsertLeadMapping,
} from '@wcb/db';
import type { DbCrmIntegration } from '@wcb/db';
import { odooCredentials } from '@wcb/crm';
import type { CrmAdapter, CrmCredentials } from '@wcb/shared';
import type { CrmSyncWorker } from './sync.js';
import { openCreds, sealCreds } from './creds.js';

export interface CrmRouteDeps {
  prisma: PrismaClient;
  worker: CrmSyncWorker;
  adapters: Record<string, CrmAdapter>;
  /** APP_ENCRYPTION_KEY — when set, stored credentials are sealed at rest (M8). */
  encryptionKey?: string;
}

const OdooCredsBody = z.object({
  baseUrl: z.string().url(),
  db: z.string().min(1),
  username: z.string().min(1),
  /** Optional on update — omitted means "keep the stored key". */
  apiKey: z.string().min(1).optional(),
});

const IntegrationBody = z.object({
  crmType: z.literal('odoo'), // v1: Odoo; each new CRM widens this union
  credentials: OdooCredsBody,
  config: z
    .object({
      autoCreate: z.boolean().optional(),
      debounceMs: z.number().int().min(1_000).max(300_000).optional(),
      transcriptLimit: z.number().int().min(10).max(1_000).optional(),
    })
    .default({}),
  status: z.enum(['active', 'disabled']).default('active'),
});

const LinkBody = z.object({
  crmRecordId: z.string().min(1),
  crmRecordName: z.string().optional(),
  crmRecordUrl: z.string().optional(),
});

/** Never return the API key to the browser — coordinates plus a hint only. */
function maskIntegration(row: DbCrmIntegration, encryptionKey?: string) {
  const creds = row.credentials ? openCreds(row.credentials, encryptionKey) : undefined;
  const key = creds?.accessToken ?? '';
  return {
    id: row.id,
    crmType: row.crmType,
    status: row.status,
    config: JSON.parse(row.config || '{}') as Record<string, unknown>,
    credentials: creds
      ? {
          ...(creds.meta ?? {}),
          apiKeySet: key.length > 0,
          apiKeyHint: key ? `…${key.slice(-4)}` : null,
        }
      : null,
  };
}

export function registerCrmRoutes(app: FastifyInstance, deps: CrmRouteDeps): void {
  const { prisma, worker, adapters, encryptionKey } = deps;

  const activeContext = async (): Promise<
    { integration: DbCrmIntegration; adapter: CrmAdapter; creds: CrmCredentials } | undefined
  > => {
    const integration = await getActiveIntegration(prisma);
    if (!integration?.credentials) return undefined;
    const adapter = adapters[integration.crmType];
    if (!adapter) return undefined;
    return { integration, adapter, creds: openCreds(integration.credentials, encryptionKey) };
  };

  app.get('/api/v1/crm/integration', async () => {
    const row = await getAnyIntegration(prisma);
    return row ? maskIntegration(row, encryptionKey) : null;
  });

  app.put('/api/v1/crm/integration', async (req, reply) => {
    const parsed = IntegrationBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', detail: parsed.error.flatten() });
    }
    const { crmType, credentials, config, status } = parsed.data;

    let apiKey = credentials.apiKey;
    if (!apiKey) {
      const existing = await getAnyIntegration(prisma);
      const stored = existing?.credentials
        ? openCreds(existing.credentials, encryptionKey)
        : undefined;
      apiKey = stored?.accessToken;
      if (!apiKey) return reply.code(400).send({ error: 'apiKey is required' });
    }

    const row = await saveIntegration(prisma, {
      crmType,
      credentials: sealCreds(odooCredentials({ ...credentials, apiKey }), encryptionKey),
      config: JSON.stringify(config),
      status,
    });
    return maskIntegration(row, encryptionKey);
  });

  app.post('/api/v1/crm/integration/test', async (req, reply) => {
    const parsed = IntegrationBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', detail: parsed.error.flatten() });
    }
    const adapter = adapters[parsed.data.crmType];
    if (!adapter) return reply.code(400).send({ error: `no adapter for ${parsed.data.crmType}` });

    let apiKey = parsed.data.credentials.apiKey;
    if (!apiKey) {
      const existing = await getAnyIntegration(prisma);
      const stored = existing?.credentials
        ? openCreds(existing.credentials, encryptionKey)
        : undefined;
      apiKey = stored?.accessToken;
      if (!apiKey) return reply.code(400).send({ error: 'apiKey is required' });
    }
    return adapter.testConnection(odooCredentials({ ...parsed.data.credentials, apiKey }));
  });

  /** Free-text record search for the manual "link existing" picker. */
  app.get('/api/v1/crm/contacts/search', async (req, reply) => {
    const { q } = req.query as { q?: string };
    if (!q || q.trim().length < 2) return [];
    const ctx = await activeContext();
    if (!ctx) return reply.code(409).send({ error: 'no active CRM integration' });
    if (!ctx.adapter.searchContacts) return [];
    return ctx.adapter.searchContacts(q.trim(), ctx.creds);
  });

  /** CRM panel state for one conversation: integration, match, and sync counters. */
  app.get('/api/v1/conversations/:id/crm', async (req, reply) => {
    const { id } = req.params as { id: string };
    const conversation = await prisma.conversation.findUnique({ where: { id } });
    if (!conversation) return reply.code(404).send({ error: 'conversation not found' });

    const integration = await getActiveIntegration(prisma);
    if (!integration) return { integration: null, mapping: null, pending: 0, failed: 0 };

    const mapping = await getLeadMapping(prisma, conversation.contactId, integration.id);
    const counts = await syncCounts(prisma, id, integration.id);
    return {
      integration: { crmType: integration.crmType, status: integration.status },
      mapping: mapping
        ? {
            status: mapping.status,
            crmRecordId: mapping.crmRecordId,
            crmRecordName: mapping.crmRecordName,
            crmRecordUrl: mapping.crmRecordUrl,
            lastSyncedAt: mapping.lastSyncedAt?.toISOString() ?? null,
          }
        : null,
      ...counts,
    };
  });

  /** Manually link this conversation's contact to an existing CRM record. */
  app.post('/api/v1/conversations/:id/crm/link', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = LinkBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', detail: parsed.error.flatten() });
    }
    const conversation = await prisma.conversation.findUnique({ where: { id } });
    if (!conversation) return reply.code(404).send({ error: 'conversation not found' });
    const ctx = await activeContext();
    if (!ctx) return reply.code(409).send({ error: 'no active CRM integration' });

    await upsertLeadMapping(prisma, conversation.contactId, ctx.integration.id, {
      status: 'matched',
      crmRecordType: 'contact',
      crmRecordId: parsed.data.crmRecordId,
      crmRecordName: parsed.data.crmRecordName ?? null,
      crmRecordUrl: parsed.data.crmRecordUrl ?? null,
      crmNoteId: null, // fresh record → fresh running note
    });
    void worker.flushNow(id); // sync in the background; UI hears crm.sync.status over WS
    return reply.code(202).send({ ok: true });
  });

  /** Create a CRM record for this conversation's contact, then link + sync. */
  app.post('/api/v1/conversations/:id/crm/create', async (req, reply) => {
    const { id } = req.params as { id: string };
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: { contact: true },
    });
    if (!conversation) return reply.code(404).send({ error: 'conversation not found' });
    const ctx = await activeContext();
    if (!ctx) return reply.code(409).send({ error: 'no active CRM integration' });

    let record;
    try {
      record = await ctx.adapter.createContact(
        {
          phoneE164: conversation.contact.phoneE164,
          displayName: conversation.contact.displayName ?? undefined,
        },
        ctx.creds,
      );
    } catch (err) {
      return reply.code(502).send({
        error: 'CRM create failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    await upsertLeadMapping(prisma, conversation.contactId, ctx.integration.id, {
      status: 'matched',
      crmRecordType: record.type,
      crmRecordId: record.id,
      crmRecordName: record.displayName ?? null,
      crmRecordUrl: record.url ?? null,
      crmNoteId: null,
    });
    void worker.flushNow(id);
    return reply.code(202).send({ ok: true, record });
  });

  /** Manual "sync now" from the panel. */
  app.post('/api/v1/conversations/:id/crm/sync', async (req, reply) => {
    const { id } = req.params as { id: string };
    void worker.flushNow(id);
    return reply.code(202).send({ ok: true });
  });
}
