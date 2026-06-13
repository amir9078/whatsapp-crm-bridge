// M8 acceptance (server side): CRM creds sealed at rest but fully usable; export bundle is
// complete and credential-free; per-contact erasure and full wipe cascade cleanly;
// retention purge removes only what is out of window.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type {
  ConnectionStatus,
  ConnectorEvent,
  ConnectorEventHandler,
  ContactInput,
  CrmAdapter,
  CrmRecord,
  SendMessageInput,
  SendMessageResult,
  WhatsAppConnector,
} from '@wcb/shared';
import { isEncrypted } from '@wcb/shared/crypto';
import { createPrisma, ensureConnection, type PrismaClient } from '@wcb/db';
import { buildServer, type BuiltServer } from './app.js';
import { purgeOldMessages } from './data.js';

const KEY = randomBytes(32).toString('hex');

class FakeConnector implements WhatsAppConnector {
  readonly provider = 'baileys' as const;
  private readonly handlers = new Set<ConnectorEventHandler>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  getStatus(): ConnectionStatus {
    return 'connected';
  }
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    return { waMessageId: 'X', clientMessageId: input.clientMessageId };
  }
  on(handler: ConnectorEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  fire(event: ConnectorEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

class FakeCrm implements CrmAdapter {
  readonly type = 'odoo' as const;
  readonly authKind = 'api_key' as const;
  readonly capabilities = { supportsNoteUpdate: true, supportsActivities: false, rateLimitPerMin: 600 };
  lastCredsSeen?: string;
  notes = 0;
  async testConnection(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async findContactByPhone(_phone: string, creds: { accessToken: string }): Promise<CrmRecord[]> {
    this.lastCredsSeen = creds.accessToken;
    return [{ id: '5', type: 'contact', displayName: 'Known Person' }];
  }
  async createContact(input: ContactInput): Promise<CrmRecord> {
    return { id: '6', type: 'contact', displayName: input.displayName };
  }
  async appendNote(): Promise<{ id: string }> {
    this.notes++;
    return { id: `n-${this.notes}` };
  }
  async updateNote(): Promise<void> {
    this.notes++;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const dbPkgDir = resolve(here, '..', '..', '..', 'packages', 'db');
const tmp = mkdtempSync(join(tmpdir(), 'wcb-data-test-'));

let prisma: PrismaClient;
let built: BuiltServer;
let baseUrl: string;
const fakeWa = new FakeConnector();
const fakeCrm = new FakeCrm();

function fireInbound(phoneE164: string, body: string, timestamp = new Date()): void {
  fakeWa.fire({
    type: 'message',
    message: {
      waMessageId: `IN-${Math.random()}`,
      fromMe: false,
      remoteJid: `${phoneE164.slice(1)}@s.whatsapp.net`,
      phoneE164,
      type: 'text',
      body,
      timestamp: timestamp.toISOString(),
    },
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

before(async () => {
  process.env.DATABASE_URL = `file:${join(tmp, 'test.db').replace(/\\/g, '/')}`;
  execSync('pnpm exec prisma db push --skip-generate', {
    cwd: dbPkgDir,
    env: process.env,
    stdio: 'pipe',
  });
  prisma = createPrisma();
  await ensureConnection(prisma, { phoneE164: '+971500000001' });
  built = await buildServer({
    prisma,
    connectorFactory: () => fakeWa,
    baseAuthDir: join(tmp, 'auth'),
    crmAdapters: { odoo: fakeCrm },
    crmDebounceMs: 30,
    encryptionKey: KEY,
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const address = built.app.server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  built.crmWorker.stop();
  built.io.close();
  await built.app.close();
  await prisma.$disconnect();
  rmSync(tmp, { recursive: true, force: true });
});

test('CRM creds are sealed in the DB yet decrypt transparently for sync', async () => {
  const put = await fetch(`${baseUrl}/api/v1/crm/integration`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      crmType: 'odoo',
      credentials: {
        baseUrl: 'https://crm.example.com',
        db: 'prod',
        username: 'api@x.com',
        apiKey: 'SUPER-SECRET-KEY-1234',
      },
      config: {},
    }),
  });
  assert.equal(put.status, 200);
  const masked = (await put.json()) as { credentials: { apiKeyHint: string } };
  assert.equal(masked.credentials.apiKeyHint, '…1234');

  // At rest: enc:v1 payload, no secret substring anywhere in the row.
  const row = await prisma.crmIntegration.findFirstOrThrow();
  assert.ok(row.credentials && isEncrypted(row.credentials));
  assert.ok(!row.credentials.includes('SUPER-SECRET'));

  // In use: the sync worker opens them and hands the real key to the adapter.
  fireInbound('+971501112233', 'hello, sealed world');
  await sleep(400);
  assert.equal(fakeCrm.lastCredsSeen, 'SUPER-SECRET-KEY-1234');
  assert.ok(fakeCrm.notes >= 1);
});

test('export bundle has all chat data and zero credentials', async () => {
  const res = await fetch(`${baseUrl}/api/v1/data/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="wcb-export-/);
  const text = await res.text();
  assert.ok(!text.includes('SUPER-SECRET'), 'no secrets in the export');
  assert.ok(!text.includes('enc:v1:'), 'no sealed blobs in the export either');
  const bundle = JSON.parse(text) as {
    contacts: unknown[];
    conversations: Array<{ messages: Array<{ body: string }> }>;
    crmIntegration: { crmType: string } | null;
  };
  assert.equal(bundle.contacts.length, 1);
  assert.equal(bundle.conversations[0]?.messages[0]?.body, 'hello, sealed world');
  assert.equal(bundle.crmIntegration?.crmType, 'odoo');
});

test('right to erasure: contact delete cascades through every table', async () => {
  const contact = await prisma.contact.findFirstOrThrow();
  const res = await fetch(`${baseUrl}/api/v1/contacts/${contact.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(await prisma.contact.count(), 0);
  assert.equal(await prisma.conversation.count(), 0);
  assert.equal(await prisma.message.count(), 0);
  assert.equal(await prisma.leadMapping.count(), 0);
  assert.equal(await prisma.syncLog.count(), 0);
});

test('retention purge deletes only out-of-window messages', async () => {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fireInbound('+971509998877', 'ancient history', old);
  fireInbound('+971509998877', 'fresh news');
  await sleep(300);
  assert.equal(await prisma.message.count(), 2);

  const purged = await purgeOldMessages(prisma, 30);
  assert.equal(purged.messages, 1);
  const left = await prisma.message.findMany();
  assert.equal(left.length, 1);
  assert.equal(left[0]?.body, 'fresh news');
  assert.equal(await prisma.syncLog.count({ where: { messageId: { not: left[0]!.id } } }), 0);
});

test('full wipe requires explicit confirmation', async () => {
  assert.equal((await fetch(`${baseUrl}/api/v1/data`, { method: 'DELETE' })).status, 400);
  const res = await fetch(`${baseUrl}/api/v1/data?confirm=ALL`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(await prisma.message.count(), 0);
  assert.equal(await prisma.contact.count(), 0);
  // WhatsApp link + CRM integration survive a data wipe.
  assert.equal(await prisma.waConnection.count(), 1);
  assert.equal(await prisma.crmIntegration.count(), 1);
});
