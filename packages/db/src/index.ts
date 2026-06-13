// @wcb/db — Prisma client + idempotent persistence (SQLite dev / Postgres prod).
// Spec: docs/03-api-and-data-design.md §2, docs/05 §4.
export { createPrisma, Prisma, PrismaClient } from './client.js';
export {
  ensureConnection,
  ingestInboundMessage,
  syncContactDirectory,
  updateMessageStatus,
} from './ingest.js';
export type { IngestResult } from './ingest.js';
export { listConversations, listMessages } from './queries.js';
export {
  listWaConnections,
  getWaConnection,
  createWaConnection,
  updateWaConnection,
  deleteWaConnection,
} from './connections.js';
export {
  getActiveIntegration,
  getAnyIntegration,
  saveIntegration,
  getLeadMapping,
  upsertLeadMapping,
  listUnsyncedMessages,
  markMessagesSynced,
  recordSyncFailure,
  syncCounts,
} from './crm.js';
export type {
  Contact as DbContact,
  Conversation as DbConversation,
  CrmIntegration as DbCrmIntegration,
  LeadMapping as DbLeadMapping,
  Message as DbMessage,
  SyncLog as DbSyncLog,
  WaConnection as DbWaConnection,
} from '@prisma/client';
