// CRM sync worker (M6): debounced per-conversation flush → lead matching → one
// running-thread note per conversation, rewritten in place. Never blocks message delivery;
// failures retry with backoff and land in sync_log. Spec: docs/03 §5–6.
import type { PrismaClient } from '@wcb/db';
import {
  getActiveIntegration,
  getLeadMapping,
  listUnsyncedMessages,
  markMessagesSynced,
  recordSyncFailure,
  upsertLeadMapping,
} from '@wcb/db';
import type { DbContact, DbCrmIntegration, DbLeadMapping } from '@wcb/db';
import { buildTranscriptHtml } from '@wcb/crm';
import type { CrmAdapter, CrmCredentials, WhatsAppEvent } from '@wcb/shared';
import { openCreds } from './creds.js';

export interface CrmSyncConfig {
  /** Create a CRM contact automatically when the phone has no match (default false). */
  autoCreate?: boolean;
  /** Quiet period after the last message before flushing to the CRM. */
  debounceMs?: number;
  /** Max messages kept in the running-thread note. */
  transcriptLimit?: number;
}

export interface CrmSyncWorkerDeps {
  prisma: PrismaClient;
  emit: (event: WhatsAppEvent) => void;
  /** Adapter registry keyed by CrmType; tests inject fakes. */
  adapters: Record<string, CrmAdapter>;
  /** APP_ENCRYPTION_KEY — needed to open sealed credentials (M8). */
  encryptionKey?: string;
  defaultDebounceMs?: number;
  maxAttempts?: number;
  log?: (msg: string, err?: unknown) => void;
}

/** Heuristic over CRM error text (Odoo: "Record does not exist or has been deleted"). */
function isMissingRecordError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /does not exist|not found|missing|deleted/i.test(msg);
}

export class CrmSyncWorker {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly flushing = new Set<string>();
  private debounceMs: number;
  private readonly maxAttempts: number;
  private stopped = false;

  constructor(private readonly deps: CrmSyncWorkerDeps) {
    this.debounceMs = deps.defaultDebounceMs ?? 8_000;
    this.maxAttempts = deps.maxAttempts ?? 5;
  }

  /** Call on every new message; coalesces bursts into one CRM write per conversation. */
  notify(conversationId: string): void {
    this.schedule(conversationId, this.debounceMs);
  }

  /** Immediate flush — used by the manual link/create/sync-now endpoints and tests. */
  async flushNow(conversationId: string): Promise<void> {
    const timer = this.timers.get(conversationId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(conversationId);
    }
    await this.flush(conversationId);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(conversationId: string, delayMs: number): void {
    if (this.stopped) return;
    const existing = this.timers.get(conversationId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      conversationId,
      setTimeout(() => {
        this.timers.delete(conversationId);
        this.flush(conversationId).catch((err: unknown) =>
          this.deps.log?.(`crm flush crashed for ${conversationId}`, err),
        );
      }, delayMs),
    );
  }

  private adapterFor(crmType: string): CrmAdapter | undefined {
    return this.deps.adapters[crmType];
  }

  private emitSync(
    conversationId: string,
    status: 'pending' | 'success' | 'failed' | 'dead_letter',
    error?: string,
  ): void {
    this.deps.emit({
      type: 'crm.sync.status',
      conversationId,
      status,
      error,
      ts: Date.now(),
      schemaVersion: 1,
    });
  }

  private async flush(conversationId: string): Promise<void> {
    // Serialize per conversation: a flush in flight + a new message → run again after.
    if (this.flushing.has(conversationId)) {
      this.schedule(conversationId, this.debounceMs);
      return;
    }
    this.flushing.add(conversationId);
    try {
      await this.doFlush(conversationId);
    } finally {
      this.flushing.delete(conversationId);
    }
  }

  private async doFlush(conversationId: string): Promise<void> {
    const { prisma } = this.deps;
    const integration = await getActiveIntegration(prisma);
    if (!integration?.credentials) return; // no CRM connected — nothing to do
    const adapter = this.adapterFor(integration.crmType);
    if (!adapter) {
      this.deps.log?.(`no adapter for CRM type "${integration.crmType}"`);
      return;
    }
    const creds = openCreds(integration.credentials, this.deps.encryptionKey);
    const config = JSON.parse(integration.config || '{}') as CrmSyncConfig;
    if (config.debounceMs && config.debounceMs > 0) this.debounceMs = config.debounceMs;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true },
    });
    if (!conversation) return;

    const unsynced = await listUnsyncedMessages(prisma, conversationId, integration.id);
    if (unsynced.length === 0) return;

    try {
      // ── 1. Lead matching (docs/03 §5): cached mapping, else search, else create/flag ──
      let mapping = await getLeadMapping(prisma, conversation.contactId, integration.id);
      if (!mapping || mapping.status !== 'matched') {
        mapping = await this.resolveMapping(adapter, creds, config, conversation.contact, integration);
      }
      if (mapping.status !== 'matched' || !mapping.crmRecordId) {
        // Not an error: surfaced in the UI for a human to create/link (docs/03 §5).
        this.emitSync(conversationId, 'pending', mapping.status);
        return;
      }

      // ── 2. Running-thread note (docs/03 §6.2): whole conversation, one note ──
      const all = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { timestamp: 'asc' },
      });
      const body = buildTranscriptHtml({
        contactName: conversation.contact.displayName ?? conversation.contact.phoneE164,
        phoneE164: conversation.contact.phoneE164,
        messages: all.map((m) => ({
          direction: m.direction as 'in' | 'out',
          type: m.type,
          body: m.body,
          senderName: m.senderName,
          timestamp: m.timestamp,
        })),
        limit: config.transcriptLimit ?? 200,
      });

      let noteId = mapping.crmNoteId;
      if (noteId && adapter.capabilities.supportsNoteUpdate && adapter.updateNote) {
        try {
          await adapter.updateNote(noteId, { body }, creds);
        } catch (err) {
          // Start a fresh note ONLY if the old one is gone from the CRM. Transient failures
          // must propagate to the retry path — falling back there would duplicate notes.
          if (!isMissingRecordError(err)) throw err;
          noteId = (await adapter.appendNote(mapping.crmRecordId, { body }, creds)).id || null;
        }
      } else {
        noteId = (await adapter.appendNote(mapping.crmRecordId, { body }, creds)).id || null;
      }

      // ── 3. Idempotency ledger + bookkeeping ──
      await markMessagesSynced(prisma, unsynced.map((m) => m.id), conversationId, integration.id);
      await upsertLeadMapping(prisma, conversation.contactId, integration.id, {
        crmNoteId: noteId,
        lastSyncedAt: new Date(),
      });
      this.emitSync(conversationId, 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = await recordSyncFailure(
        prisma,
        unsynced.map((m) => m.id),
        conversationId,
        integration.id,
        message,
        this.maxAttempts,
      );
      this.deps.log?.(`crm sync failed for ${conversationId} (attempt ${attempts})`, err);
      if (attempts >= this.maxAttempts) {
        this.emitSync(conversationId, 'dead_letter', message);
      } else {
        this.emitSync(conversationId, 'failed', message);
        const backoff = Math.min(this.debounceMs * 2 ** attempts, 300_000);
        this.schedule(conversationId, backoff);
      }
    }
  }

  private async resolveMapping(
    adapter: CrmAdapter,
    creds: CrmCredentials,
    config: CrmSyncConfig,
    contact: DbContact,
    integration: DbCrmIntegration,
  ): Promise<DbLeadMapping> {
    const { prisma, emit } = this.deps;
    const matches = await adapter.findContactByPhone(contact.phoneE164, creds);

    if (matches.length === 1 || (matches.length === 0 && config.autoCreate)) {
      const record =
        matches.length === 1
          ? matches[0]!
          : await adapter.createContact(
              { phoneE164: contact.phoneE164, displayName: contact.displayName ?? undefined },
              creds,
            );
      const mapping = await upsertLeadMapping(prisma, contact.id, integration.id, {
        status: 'matched',
        crmRecordType: record.type,
        crmRecordId: record.id,
        crmRecordName: record.displayName ?? null,
        crmRecordUrl: record.url ?? null,
      });
      emit({
        type: 'contact.matched',
        contactId: contact.id,
        crmType: adapter.type,
        crmRecordId: record.id,
        ts: Date.now(),
        schemaVersion: 1,
      });
      return mapping;
    }

    // 0 matches (no auto-create) → unmatched; >1 → never guess (docs/03 §5).
    return upsertLeadMapping(prisma, contact.id, integration.id, {
      status: matches.length === 0 ? 'unmatched' : 'ambiguous',
    });
  }
}
