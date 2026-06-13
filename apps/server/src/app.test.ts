// M4 acceptance: with a WS test client, new messages arrive live; POST /messages sends
// (via the connector) and echoes back with status. Uses a fake connector — no phone needed.
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
  SendMessageInput,
  SendMessageResult,
  WhatsAppConnector,
} from '@wcb/shared';
import { createPrisma, ensureConnection, type PrismaClient } from '@wcb/db';
import { buildServer, type BuiltServer } from './app.js';

class FakeConnector implements WhatsAppConnector {
  readonly provider = 'baileys' as const;
  readonly sent: SendMessageInput[] = [];
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
    this.sent.push(input);
    return { waMessageId: `FAKE-OUT-${this.sent.length}`, clientMessageId: input.clientMessageId };
  }
  on(handler: ConnectorEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  fire(event: ConnectorEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

function waitForEvent<T>(socket: Socket, name: string, timeoutMs = 5000): Promise<T> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timeout waiting for ${name}`)), timeoutMs);
    socket.once(name, (payload: T) => {
      clearTimeout(timer);
      res(payload);
    });
  });
}

const here = dirname(fileURLToPath(import.meta.url));
const dbPkgDir = resolve(here, '..', '..', '..', 'packages', 'db');
const tmp = mkdtempSync(join(tmpdir(), 'wcb-server-test-'));

let prisma: PrismaClient;
let built: BuiltServer;
let baseUrl: string;
let ws: Socket;
const fake = new FakeConnector();

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
    connectorFactory: () => fake,
    baseAuthDir: join(tmp, 'auth'),
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const address = built.app.server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  ws = ioClient(baseUrl, { transports: ['websocket'] });
  const hello = await waitForEvent<{ status: string }>(ws, 'connection.status');
  assert.equal(hello.status, 'connected'); // new clients learn current state immediately
});

after(async () => {
  ws.close();
  built.io.close();
  await built.app.close();
  await prisma.$disconnect();
  rmSync(tmp, { recursive: true, force: true });
});

test('inbound connector message reaches the WS client live and lands in the API', async () => {
  const eventPromise = waitForEvent<{ conversationId: string; message: { body?: string } }>(
    ws,
    'message.created',
  );
  fake.fire({
    type: 'message',
    message: {
      waMessageId: 'WAMID-IN-1',
      fromMe: false,
      remoteJid: '971501234567@s.whatsapp.net',
      phoneE164: '+971501234567',
      type: 'text',
      body: 'Hi! Is the premium package available?',
      senderName: 'Sarah Mensah',
      timestamp: new Date().toISOString(),
    },
  });

  const event = await eventPromise;
  assert.equal(event.message.body, 'Hi! Is the premium package available?');

  const res = await fetch(`${baseUrl}/api/v1/conversations`);
  assert.equal(res.status, 200);
  const conversations = (await res.json()) as Array<{
    id: string;
    unreadCount: number;
    contact: { displayName: string | null };
  }>;
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0]?.contact.displayName, 'Sarah Mensah');
  assert.equal(conversations[0]?.unreadCount, 1);
});

test('POST message → connector send, 202 echo with status, WS broadcast', async () => {
  const list = await (await fetch(`${baseUrl}/api/v1/conversations`)).json() as Array<{ id: string }>;
  const conversationId = list[0]?.id;
  assert.ok(conversationId);

  const eventPromise = waitForEvent<{ message: { clientMessageId?: string; status?: string } }>(
    ws,
    'message.created',
  );
  const res = await fetch(`${baseUrl}/api/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'Yes! $12,000, about 6 weeks.', clientMessageId: 'c_test_1' }),
  });
  assert.equal(res.status, 202);
  const echoed = (await res.json()) as {
    status?: string;
    clientMessageId?: string;
    waMessageId?: string;
    direction: string;
  };
  assert.equal(echoed.status, 'sent');
  assert.equal(echoed.clientMessageId, 'c_test_1');
  assert.equal(echoed.direction, 'out');
  assert.ok(echoed.waMessageId?.startsWith('FAKE-OUT-'));

  assert.equal(fake.sent[0]?.toPhoneE164, '+971501234567'); // really went to the connector
  const event = await eventPromise;
  assert.equal(event.message.clientMessageId, 'c_test_1');

  // duplicate echo from WhatsApp (fromMe upsert) must NOT create a second row
  fake.fire({
    type: 'message',
    message: {
      waMessageId: echoed.waMessageId,
      fromMe: true,
      remoteJid: '971501234567@s.whatsapp.net',
      phoneE164: '+971501234567',
      type: 'text',
      body: 'Yes! $12,000, about 6 weeks.',
      timestamp: new Date().toISOString(),
    },
  });
  await new Promise((r) => setTimeout(r, 300));
  const messages = (await (
    await fetch(`${baseUrl}/api/v1/conversations/${conversationId}/messages`)
  ).json()) as unknown[];
  assert.equal(messages.length, 2); // 1 in + 1 out, no dupe
});

test('delivery receipts update status and broadcast message.status', async () => {
  const eventPromise = waitForEvent<{ status: string; clientMessageId?: string }>(
    ws,
    'message.status',
  );
  fake.fire({ type: 'message-status', waMessageId: 'FAKE-OUT-1', status: 'read' });
  const event = await eventPromise;
  assert.equal(event.status, 'read');
  assert.equal(event.clientMessageId, 'c_test_1');
});

test('contacts directory event names existing chats (address book → chat list)', async () => {
  fake.fire({
    type: 'contacts',
    contacts: [
      {
        waId: '971501234567@s.whatsapp.net',
        phoneE164: '+971501234567',
        lidJid: '186165810446339@lid',
        displayName: 'Sarah From Directory',
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 300));
  const conversations = (await (await fetch(`${baseUrl}/api/v1/conversations`)).json()) as Array<{
    contact: { displayName: string | null; phoneE164: string };
  }>;
  const sarah = conversations.find((c) => c.contact.phoneE164 === '+971501234567');
  assert.equal(sarah?.contact.displayName, 'Sarah From Directory');
});
