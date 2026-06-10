// M6 acceptance: a conversation appears as (and keeps updating) ONE running note on the
// right CRM record; unmatched numbers are flagged and fixable via the link endpoint.
// Real server + real SQLite + real WS; the CRM itself is a fake adapter.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient, type Socket } from 'socket.io-client';
import type {
  ConnectionStatus,
  ConnectorEvent,
  ConnectorEventHandler,
  ContactInput,
  CrmAdapter,
  CrmCredentials,
  CrmRecord,
  NoteInput,
  SendMessageInput,
  SendMessageResult,
  WhatsAppConnector,
} from '@wcb/shared';
import { createPrisma, ensureConnection, type PrismaClient } from '@wcb/db';
import { buildServer, type BuiltServer } from './app.js';

class FakeConnector implements WhatsAppConnector {
  readonly provider = 'baileys' as const;
  private status: ConnectionStatus = 'disconnected';
  private readonly handlers = new Set<ConnectorEventHandler>();
  async connect(): Promise<void> {
    this.status = 'connected';
    this.fire({ type: 'connection', status: 'connected' });
  }
  async disconnect(): Promise<void> {
    this.status = 'disconnected';
  }
  getStatus(): ConnectionStatus {
    return this.status;
  }
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    return { waMessageId: `OUT-${Math.random()}`, clientMessageId: input.clientMessageId };
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
  readonly records: CrmRecord[] = [
    { id: '11', type: 'contact', displayName: 'Sarah Mensah', properties: { phone: '+971501234567' } },
  ];
  readonly notes = new Map<string, { recordId: string; body: string }>();
  appendCalls = 0;
  updateCalls = 0;
  failNext = 0; // make the next N note-writes throw (retry-path test)
  private nextNoteId = 1;

  async testConnection(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async findContactByPhone(phone: string): Promise<CrmRecord[]> {
    return this.records.filter((r) => r.properties?.phone === phone);
  }
  async searchContacts(query: string): Promise<CrmRecord[]> {
    return this.records.filter((r) => r.displayName?.toLowerCase().includes(query.toLowerCase()));
  }
  async createContact(input: ContactInput): Promise<CrmRecord> {
    const rec: CrmRecord = {
      id: String(100 + this.records.length),
      type: 'contact',
      displayName: input.displayName ?? input.phoneE164,
      properties: { phone: input.phoneE164 },
    };
    this.records.push(rec);
    return rec;
  }
  async appendNote(recordId: string, note: NoteInput): Promise<{ id: string }> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('CRM down (fake)');
    }
    this.appendCalls++;
    const id = `note-${this.nextNoteId++}`;
    this.notes.set(id, { recordId, body: note.body });
    return { id };
  }
  async updateNote(noteId: string, note: NoteInput): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('CRM down (fake)');
    }
    this.updateCalls++;
    const existing = this.notes.get(noteId);
    if (!existing) throw new Error(`note ${noteId} missing`);
    existing.body = note.body;
  }
}

function waitFor<T>(
  socket: Socket,
  name: string,
  pred: (payload: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      socket.off(name, handler);
      rej(new Error(`timeout waiting for ${name}`));
    }, timeoutMs);
    const handler = (payload: T): void => {
      if (!pred(payload)) return;
      clearTimeout(timer);
      socket.off(name, handler);
      res(payload);
    };
    socket.on(name, handler);
  });
}

const here = dirname(fileURLToPath(import.meta.url));
const dbPkgDir = resolve(here, '..', '..', '..', 'packages', 'db');
const tmp = mkdtempSync(join(tmpdir(), 'wcb-crm-test-'));

let prisma: PrismaClient;
let built: BuiltServer;
let baseUrl: string;
let ws: Socket;
const fakeWa = new FakeConnector();
const fakeCrm = new FakeCrm();

function fireInbound(phoneE164: string, body: string, senderName?: string): void {
  fakeWa.fire({
    type: 'message',
    message: {
      waMessageId: `IN-${Math.random()}`,
      fromMe: false,
      remoteJid: `${phoneE164.slice(1)}@s.whatsapp.net`,
      phoneE164,
      type: 'text',
      body,
      senderName,
      timestamp: new Date().toISOString(),
    },
  });
}

before(async () => {
  process.env.DATABASE_URL = `file:${join(tmp, 'test.db').replace(/\\/g, '/')}`;
  execSync('pnpm exec prisma db push --skip-generate', {
    cwd: dbPkgDir,
    env: process.env,
    stdio: 'pipe',
  });
  prisma = createPrisma();
  await prisma.crmIntegration.create({
    data: {
      crmType: 'odoo',
      credentials: JSON.stringify({
        accessToken: 'k',
        meta: { baseUrl: 'http://fake', db: 'db', username: 'u' },
      } satisfies CrmCredentials),
      config: JSON.stringify({ autoCreate: false }),
    },
  });
  const waConnectionId = await ensureConnection(prisma, { phoneE164: '+971500000001' });
  built = await buildServer({
    prisma,
    connector: fakeWa,
    waConnectionId,
    crmAdapters: { odoo: fakeCrm },
    crmDebounceMs: 40,
  });
  await fakeWa.connect();
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const address = built.app.server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  ws = ioClient(baseUrl, { transports: ['websocket'] });
  await waitFor<{ status: string }>(ws, 'connection.status', (e) => e.status === 'connected');
});

after(async () => {
  ws.close();
  built.crmWorker.stop();
  built.io.close();
  await built.app.close();
  await prisma.$disconnect();
  rmSync(tmp, { recursive: true, force: true });
});

test('matched contact: conversation becomes ONE running note that keeps updating', async () => {
  const matched = waitFor<{ crmRecordId: string }>(ws, 'contact.matched', () => true);
  const synced = waitFor<{ status: string }>(ws, 'crm.sync.status', (e) => e.status === 'success');
  fireInbound('+971501234567', 'Hi! Is the premium package available?', 'Sarah Mensah');

  assert.equal((await matched).crmRecordId, '11');
  await synced;
  assert.equal(fakeCrm.appendCalls, 1);
  const note = [...fakeCrm.notes.values()][0];
  assert.equal(note?.recordId, '11');
  assert.match(note?.body ?? '', /premium package/);

  // Second message → the SAME note is updated, not a second note (docs/03 §6.2).
  const synced2 = waitFor<{ status: string }>(ws, 'crm.sync.status', (e) => e.status === 'success');
  fireInbound('+971501234567', 'Also, do you ship to Dubai Marina?', 'Sarah Mensah');
  await synced2;
  assert.equal(fakeCrm.notes.size, 1);
  assert.equal(fakeCrm.updateCalls, 1);
  assert.match([...fakeCrm.notes.values()][0]?.body ?? '', /Dubai Marina/);

  // Idempotency ledger: every message marked success exactly once.
  const logs = await prisma.syncLog.findMany();
  assert.equal(logs.filter((l) => l.status === 'success').length, 2);
});

test('unknown number → unmatched flag → manual link → syncs to the linked record', async () => {
  const flagged = waitFor<{ status: string; error?: string }>(
    ws,
    'crm.sync.status',
    (e) => e.status === 'pending' && e.error === 'unmatched',
  );
  fireInbound('+14155550123', 'Hello, found you on Google');
  await flagged;

  const conversations = (await (await fetch(`${baseUrl}/api/v1/conversations`)).json()) as Array<{
    id: string;
    contact: { phoneE164: string };
  }>;
  const conv = conversations.find((c) => c.contact.phoneE164 === '+14155550123');
  assert.ok(conv);

  // Panel state shows the unmatched flag and the not-yet-synced message.
  const panel = (await (await fetch(`${baseUrl}/api/v1/conversations/${conv.id}/crm`)).json()) as {
    mapping: { status: string } | null;
    pending: number;
  };
  assert.equal(panel.mapping?.status, 'unmatched');
  assert.equal(panel.pending, 1);

  // Human resolves it: link to an existing CRM record → backlog syncs.
  const synced = waitFor<{ conversationId?: string; status: string }>(
    ws,
    'crm.sync.status',
    (e) => e.status === 'success' && e.conversationId === conv.id,
  );
  const res = await fetch(`${baseUrl}/api/v1/conversations/${conv.id}/crm/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ crmRecordId: '99', crmRecordName: 'Walk-in Lead' }),
  });
  assert.equal(res.status, 202);
  await synced;
  const note = [...fakeCrm.notes.values()].find((n) => n.recordId === '99');
  assert.match(note?.body ?? '', /found you on Google/);
});

test('CRM outage: flush fails, is recorded, then succeeds on retry with backoff', async () => {
  fakeCrm.failNext = 1;
  const failed = waitFor<{ status: string }>(ws, 'crm.sync.status', (e) => e.status === 'failed');
  const recovered = waitFor<{ status: string }>(
    ws,
    'crm.sync.status',
    (e) => e.status === 'success',
    10_000,
  );
  fireInbound('+971501234567', 'One more question…', 'Sarah Mensah');
  await failed;
  await recovered; // backoff retry (debounce * 2^attempts = tiny in tests) heals it
  assert.equal(fakeCrm.notes.size, 2); // still one note per record, no flood
});

test('integration settings endpoints: masked read, never leaking the API key', async () => {
  const integration = (await (await fetch(`${baseUrl}/api/v1/crm/integration`)).json()) as {
    crmType: string;
    credentials: { apiKeySet: boolean; apiKeyHint: string | null } & Record<string, unknown>;
  };
  assert.equal(integration.crmType, 'odoo');
  assert.equal(integration.credentials.apiKeySet, true);
  assert.ok(!JSON.stringify(integration).includes('"k"')); // raw key never serialized
});
