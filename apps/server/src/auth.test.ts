// M7 acceptance: with AUTH_PASSWORD set, REST and WebSocket both require a valid token;
// login exchanges the password for one; health/status stay public.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import type {
  ConnectionStatus,
  ConnectorEvent,
  ConnectorEventHandler,
  SendMessageInput,
  SendMessageResult,
  WhatsAppConnector,
} from '@wcb/shared';
import { createPrisma, ensureConnection, type PrismaClient } from '@wcb/db';
import { Auth } from './auth.js';
import { buildServer, type BuiltServer } from './app.js';

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

const PASSWORD = 'correct horse battery staple';
const here = dirname(fileURLToPath(import.meta.url));
const dbPkgDir = resolve(here, '..', '..', '..', 'packages', 'db');
const tmp = mkdtempSync(join(tmpdir(), 'wcb-auth-test-'));

let prisma: PrismaClient;
let built: BuiltServer;
let baseUrl: string;

before(async () => {
  process.env.DATABASE_URL = `file:${join(tmp, 'test.db').replace(/\\/g, '/')}`;
  execSync('pnpm exec prisma db push --skip-generate', {
    cwd: dbPkgDir,
    env: process.env,
    stdio: 'pipe',
  });
  prisma = createPrisma();
  const waConnectionId = await ensureConnection(prisma, { phoneE164: '+971500000001' });
  built = await buildServer({
    prisma,
    connector: new FakeConnector(),
    waConnectionId,
    auth: { password: PASSWORD },
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

test('unit: tokens are signed, expiring, and tamper-proof', () => {
  const auth = new Auth({ password: 'pw', ttlMs: 60_000 });
  assert.equal(auth.login('nope'), null);
  const session = auth.login('pw');
  assert.ok(session);
  assert.equal(auth.verify(session.token), true);
  assert.equal(auth.verify(`${session.token}x`), false); // tampered signature
  assert.equal(auth.verify(undefined), false);

  const expired = new Auth({ password: 'pw', ttlMs: -1 }).login('pw');
  assert.equal(new Auth({ password: 'pw', ttlMs: -1 }).verify(expired?.token), false);

  const disabled = new Auth({});
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.verify(undefined), true); // no password → auth off
});

test('REST: protected without token, public health/status, login flow works', async () => {
  assert.equal((await fetch(`${baseUrl}/api/v1/conversations`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/v1/crm/integration`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/v1/health`)).status, 200);

  const status = (await (await fetch(`${baseUrl}/api/v1/auth/status`)).json()) as {
    authRequired: boolean;
  };
  assert.equal(status.authRequired, true);

  const wrong = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'guess' }),
  });
  assert.equal(wrong.status, 401);

  const ok = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(ok.status, 200);
  const { token } = (await ok.json()) as { token: string };
  assert.ok(token);

  const authed = await fetch(`${baseUrl}/api/v1/conversations`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(authed.status, 200);
});

test('WebSocket: rejected without token, accepted with one', async () => {
  const rejected = ioClient(baseUrl, { transports: ['websocket'], reconnection: false });
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error('expected connect_error')), 4000);
    rejected.on('connect_error', (err) => {
      clearTimeout(timer);
      assert.match(err.message, /unauthorized/);
      res();
    });
    rejected.on('connect', () => rej(new Error('socket connected without a token')));
  });
  rejected.close();

  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const { token } = (await login.json()) as { token: string };
  const accepted = ioClient(baseUrl, {
    transports: ['websocket'],
    reconnection: false,
    auth: { token },
  });
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timeout waiting for hello')), 4000);
    accepted.on('connection.status', () => {
      clearTimeout(timer);
      res();
    });
    accepted.on('connect_error', (err) => rej(err));
  });
  accepted.close();
});
