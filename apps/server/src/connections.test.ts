// M10 acceptance: multiple salesperson inboxes. The SAME customer messaging two different
// salespeople must produce TWO separate conversations, each attributed to its own inbox —
// never mixed. Plus the add/list/remove connection API.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConnectionStatus,
  ConnectorEvent,
  ConnectorEventHandler,
  SendMessageInput,
  SendMessageResult,
  WhatsAppConnector,
} from '@wcb/shared';
import { createPrisma, type PrismaClient } from '@wcb/db';
import { buildServer, type BuiltServer } from './app.js';

/** A fake connector whose events we can fire on demand; one instance per inbox. */
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

function inbound(phoneE164: string, body: string): ConnectorEvent {
  return {
    type: 'message',
    message: {
      waMessageId: `IN-${Math.random()}`,
      fromMe: false,
      remoteJid: `${phoneE164.slice(1)}@s.whatsapp.net`,
      phoneE164,
      type: 'text',
      body,
      timestamp: new Date().toISOString(),
    },
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const dbPkgDir = resolve(here, '..', '..', '..', 'packages', 'db');
const tmp = mkdtempSync(join(tmpdir(), 'wcb-conn-test-'));

// The factory hands out one fake per connection id (the manager creates ids).
const fakes = new Map<string, FakeConnector>();
function factory(connectionId: string): WhatsAppConnector {
  const fake = new FakeConnector();
  fakes.set(connectionId, fake);
  return fake;
}

let prisma: PrismaClient;
let built: BuiltServer;
let baseUrl: string;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

before(async () => {
  process.env.DATABASE_URL = `file:${join(tmp, 'test.db').replace(/\\/g, '/')}`;
  execSync('pnpm exec prisma db push --skip-generate', {
    cwd: dbPkgDir,
    env: process.env,
    stdio: 'pipe',
  });
  prisma = createPrisma();
  // No pre-created connection: the manager creates the first inbox itself.
  built = await buildServer({ prisma, connectorFactory: factory, baseAuthDir: join(tmp, 'auth') });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const address = built.app.server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  built.crmWorker.stop();
  await built.manager.stopAll();
  built.io.close();
  await built.app.close();
  await prisma.$disconnect();
  rmSync(tmp, { recursive: true, force: true });
});

test('fresh install auto-creates one inbox', async () => {
  const conns = (await (await fetch(`${baseUrl}/api/v1/connections`)).json()) as Array<{
    id: string;
    status: string;
  }>;
  assert.equal(conns.length, 1);
  assert.equal(conns[0]?.status, 'connected');
});

test('adding a salesperson creates a second, independent inbox', async () => {
  const res = await fetch(`${baseUrl}/api/v1/connections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Sara' }),
  });
  assert.equal(res.status, 201);
  const added = (await res.json()) as { id: string; label: string };
  assert.equal(added.label, 'Sara');

  const conns = (await (await fetch(`${baseUrl}/api/v1/connections`)).json()) as unknown[];
  assert.equal(conns.length, 2);
});

test('same customer → two salespeople → TWO separate, attributed conversations', async () => {
  const conns = (await (await fetch(`${baseUrl}/api/v1/connections`)).json()) as Array<{
    id: string;
    label: string | null;
  }>;
  const inboxA = conns[0]!; // auto-created first inbox
  const inboxB = conns.find((c) => c.label === 'Sara')!;

  const customer = '+971501112233';
  fakes.get(inboxA.id)!.fire(inbound(customer, 'Hi, this is for salesperson A'));
  fakes.get(inboxB.id)!.fire(inbound(customer, 'Hi, this is for salesperson B'));
  await sleep(300);

  const convos = (await (await fetch(`${baseUrl}/api/v1/conversations`)).json()) as Array<{
    id: string;
    contact: { phoneE164: string };
    inbox: { id: string; label: string | null };
  }>;
  const forCustomer = convos.filter((c) => c.contact.phoneE164 === customer);
  // ONE customer, but TWO conversations — one per salesperson inbox.
  assert.equal(forCustomer.length, 2);
  const inboxIds = forCustomer.map((c) => c.inbox.id).sort();
  assert.deepEqual(inboxIds, [inboxA.id, inboxB.id].sort());
  // And exactly one contact row is shared between them.
  assert.equal(await prisma.contact.count({ where: { phoneE164: customer } }), 1);
});

test('replying goes out on the conversation’s OWN inbox, not another salesperson’s', async () => {
  const conns = (await (await fetch(`${baseUrl}/api/v1/connections`)).json()) as Array<{
    id: string;
    label: string | null;
  }>;
  const inboxB = conns.find((c) => c.label === 'Sara')!;
  const convos = (await (await fetch(`${baseUrl}/api/v1/conversations`)).json()) as Array<{
    id: string;
    inbox: { id: string };
  }>;
  const convOnB = convos.find((c) => c.inbox.id === inboxB.id)!;

  const before = fakes.get(inboxB.id)!.sent.length;
  const res = await fetch(`${baseUrl}/api/v1/conversations/${convOnB.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'reply from Sara', clientMessageId: 'c1' }),
  });
  assert.equal(res.status, 202);
  // The reply was sent through inbox B's connector only.
  assert.equal(fakes.get(inboxB.id)!.sent.length, before + 1);
});

test('cannot remove the only inbox; can remove an extra one', async () => {
  const conns = (await (await fetch(`${baseUrl}/api/v1/connections`)).json()) as Array<{
    id: string;
    label: string | null;
  }>;
  const sara = conns.find((c) => c.label === 'Sara')!;
  const del = await fetch(`${baseUrl}/api/v1/connections/${sara.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const left = (await (await fetch(`${baseUrl}/api/v1/connections`)).json()) as unknown[];
  assert.equal(left.length, 1);

  // The last remaining inbox is protected.
  const lastId = ((await (await fetch(`${baseUrl}/api/v1/connections`)).json()) as Array<{ id: string }>)[0]!.id;
  const blocked = await fetch(`${baseUrl}/api/v1/connections/${lastId}`, { method: 'DELETE' });
  assert.equal(blocked.status, 409);
});
