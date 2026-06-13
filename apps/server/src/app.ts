// Fastify + Socket.IO server: REST API + real-time push, connector events → DB → WS.
// Spec: docs/03 §3–4 (API), docs/05 §2–4 (flows, idempotency). Auth arrives in M7.
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Server as IOServer } from 'socket.io';
import { z } from 'zod';
import {
  ingestInboundMessage,
  listConversations,
  listMessages,
  syncContactDirectory,
  Prisma,
  type PrismaClient,
} from '@wcb/db';
import type { ConnectorEvent, CrmAdapter, WhatsAppEvent } from '@wcb/shared';
import { createCrmAdapters } from '@wcb/crm';
import { toConversationDto, toSharedMessage } from './mappers.js';
import { CrmSyncWorker } from './crm/sync.js';
import { registerCrmRoutes } from './crm/routes.js';
import { Auth, bearerToken, type AuthConfig } from './auth.js';
import { purgeOldMessages, registerDataRoutes } from './data.js';
import { ConnectorManager, type ConnectorFactory } from './connector-manager.js';

export interface ServerDeps {
  prisma: PrismaClient;
  /** Builds a connector per connection id (M10). Real = BaileysConnector; tests inject a fake. */
  connectorFactory: ConnectorFactory;
  /** Root auth_state folder; each connection lives in `<baseAuthDir>/<id>`. */
  baseAuthDir: string;
  /** CRM adapter registry override (tests inject fakes). Defaults to the real adapters. */
  crmAdapters?: Record<string, CrmAdapter>;
  /** Sync debounce override (tests use a few ms). */
  crmDebounceMs?: number;
  /** Single-user auth (M7). No password → auth disabled (local dev). */
  auth?: AuthConfig;
  /** APP_ENCRYPTION_KEY (M8) — seals CRM credentials at rest. */
  encryptionKey?: string;
  /** Purge messages older than N days (M8). 0/undefined = keep forever. */
  retentionDays?: number;
}

export interface BuiltServer {
  app: FastifyInstance;
  io: IOServer;
  crmWorker: CrmSyncWorker;
  manager: ConnectorManager;
}

const SendBody = z.object({
  body: z.string().min(1),
  clientMessageId: z.string().optional(),
});

const LoginBody = z.object({ password: z.string().min(1) });

const AddConnectionBody = z.object({ label: z.string().max(60).optional() });

/** Routes reachable without a token (the login flow itself + liveness probes). */
const PUBLIC_PATHS = new Set(['/api/v1/health', '/api/v1/auth/status', '/api/v1/auth/login']);

export async function buildServer({
  prisma,
  connectorFactory,
  baseAuthDir,
  crmAdapters,
  crmDebounceMs,
  auth: authConfig,
  encryptionKey,
  retentionDays,
}: ServerDeps): Promise<BuiltServer> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  const auth = new Auth(authConfig);

  // Everything under /api/v1 needs a bearer token while auth is enabled (docs/04 §2).
  app.addHook('onRequest', async (req, reply) => {
    if (!auth.enabled) return;
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || PUBLIC_PATHS.has(path)) return;
    if (!auth.verify(bearerToken(req.headers.authorization))) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  const io = new IOServer(app.server, { cors: { origin: true } });
  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
    next(auth.verify(token) ? undefined : new Error('unauthorized'));
  });

  const emit = (event: WhatsAppEvent): void => {
    io.emit(event.type, event);
  };

  // CRM sync runs in the background off message events — never blocks delivery (docs/03 §6.3).
  const adapters = crmAdapters ?? createCrmAdapters();
  const crmWorker = new CrmSyncWorker({
    prisma,
    emit,
    adapters,
    encryptionKey,
    defaultDebounceMs: crmDebounceMs,
    log: (msg, err) => app.log.error({ err }, msg),
  });
  app.addHook('onClose', () => crmWorker.stop());

  // Retention sweep (M8, docs/04 §5.5): purge old messages on boot and twice a day.
  if (retentionDays && retentionDays > 0) {
    const sweep = (): void => {
      purgeOldMessages(prisma, retentionDays).catch((err: unknown) => app.log.error(err));
    };
    sweep();
    const timer = setInterval(sweep, 12 * 60 * 60 * 1000);
    timer.unref();
    app.addHook('onClose', () => clearInterval(timer));
  }

  // ── connector events (tagged by connection id) → DB → WebSocket (docs/05 §2) ──
  // Each salesperson's session flows through here under its own connectionId, so a message
  // is always ingested against the correct inbox and never mixed with another salesperson's.
  async function handleConnectorEvent(connectionId: string, event: ConnectorEvent): Promise<void> {
    switch (event.type) {
      case 'qr':
        emit({
          type: 'connection.status',
          connectionId,
          status: 'qr_pending',
          qr: event.qr,
          ts: Date.now(),
          schemaVersion: 1,
        });
        break;
      case 'connection':
        await prisma.waConnection
          .update({ where: { id: connectionId }, data: { status: event.status } })
          .catch(() => undefined);
        emit({
          type: 'connection.status',
          connectionId,
          status: event.status,
          ts: Date.now(),
          schemaVersion: 1,
        });
        break;
      case 'message': {
        const result = await ingestInboundMessage(prisma, connectionId, event.message);
        if (!result.created) break; // duplicate (e.g. echo of our own send) — already broadcast
        const row = await prisma.message.findUnique({ where: { id: result.messageId } });
        if (row) {
          emit({
            type: 'message.created',
            conversationId: result.conversationId,
            message: toSharedMessage(row),
            ts: Date.now(),
            schemaVersion: 1,
          });
        }
        crmWorker.notify(result.conversationId);
        break;
      }
      case 'contacts': {
        // WhatsApp directory batch: names + lid→phone pairs; merges lid-pseudo contacts.
        await syncContactDirectory(prisma, event.contacts);
        break;
      }
      case 'message-status': {
        const row = await prisma.message.findFirst({
          where: { waMessageId: event.waMessageId },
        });
        if (!row) break;
        await prisma.message.update({ where: { id: row.id }, data: { status: event.status } });
        emit({
          type: 'message.status',
          conversationId: row.conversationId,
          messageId: row.id,
          waMessageId: event.waMessageId,
          clientMessageId: row.clientMessageId ?? undefined,
          status: event.status,
          ts: Date.now(),
          schemaVersion: 1,
        });
        break;
      }
    }
  }

  const manager = new ConnectorManager({
    prisma,
    connectorFactory,
    baseAuthDir,
    log: (msg, err) => app.log.error({ err }, msg),
    onEvent: (connectionId, event) => {
      handleConnectorEvent(connectionId, event).catch((err: unknown) => app.log.error(err));
    },
  });
  await manager.init();
  app.addHook('onClose', () => manager.stopAll());

  // New browser connections immediately learn every inbox's current state (QR or connected).
  io.on('connection', (socket) => {
    for (const state of manager.list()) {
      socket.emit('connection.status', {
        type: 'connection.status',
        connectionId: state.id,
        status: state.status,
        qr: state.qr,
        ts: Date.now(),
        schemaVersion: 1,
      } satisfies WhatsAppEvent);
    }
  });

  // ── REST API (docs/03 §3) ──
  app.get('/api/v1/health', async () => ({ ok: true }));

  // ── Auth (M7) ──
  app.get('/api/v1/auth/status', async () => ({ authRequired: auth.enabled }));

  app.post('/api/v1/auth/login', async (req, reply) => {
    if (!auth.enabled) return reply.code(409).send({ error: 'auth is disabled' });
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const session = auth.login(parsed.data.password);
    if (!session) return reply.code(401).send({ error: 'wrong password' });
    return session; // { token, expiresAt } — client sends it as a Bearer header + socket auth
  });

  // ── Connections (M10): one WhatsApp inbox per salesperson ──
  // Singular kept for backward-compat: returns the first inbox (the original pre-M10 number).
  app.get('/api/v1/connection', async () => {
    const first = manager.list()[0];
    return first ? { id: first.id, status: first.status, qr: first.qr } : { status: 'disconnected' };
  });

  app.get('/api/v1/connections', async () => manager.list());

  app.post('/api/v1/connections', async (req, reply) => {
    const parsed = AddConnectionBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
    const state = await manager.add(parsed.data.label);
    return reply.code(201).send(state);
  });

  app.get('/api/v1/connections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const state = manager.state(id);
    if (!state) return reply.code(404).send({ error: 'connection not found' });
    return state;
  });

  app.delete('/api/v1/connections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (manager.list().length <= 1) {
      return reply.code(409).send({ error: 'cannot remove the only inbox' });
    }
    const ok = await manager.remove(id);
    if (!ok) return reply.code(404).send({ error: 'connection not found' });
    return { ok: true };
  });

  app.get('/api/v1/conversations', async () => {
    const rows = await listConversations(prisma);
    return rows.map(toConversationDto);
  });

  app.get('/api/v1/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const conversation = await prisma.conversation.findUnique({ where: { id } });
    if (!conversation) return reply.code(404).send({ error: 'conversation not found' });
    const rows = await listMessages(prisma, id, 2000);
    return rows.map(toSharedMessage);
  });

  app.post('/api/v1/conversations/:id/read', async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.conversation
      .update({ where: { id }, data: { unreadCount: 0 } })
      .catch(() => reply.code(404));
    return { ok: true };
  });

  // Send a message into an existing conversation (optimistic-UI contract, docs/05 §3).
  app.post('/api/v1/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', detail: parsed.error.flatten() });
    }
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: { contact: true },
    });
    if (!conversation) return reply.code(404).send({ error: 'conversation not found' });

    // Send from the SAME inbox that owns this conversation, so the reply goes out on the
    // right salesperson's number (never another salesperson's).
    const connector = manager.getConnector(conversation.waConnectionId);
    if (!connector) {
      return reply.code(409).send({ error: 'inbox for this conversation is not connected' });
    }

    let sendResult;
    try {
      sendResult = await connector.sendMessage({
        toPhoneE164: conversation.contact.phoneE164,
        conversationId: id,
        clientMessageId: parsed.data.clientMessageId,
        type: 'text',
        body: parsed.data.body,
      });
    } catch (err) {
      return reply.code(502).send({
        error: 'whatsapp send failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const now = new Date();
    let row;
    try {
      row = await prisma.message.create({
        data: {
          conversationId: id,
          waMessageId: sendResult.waMessageId,
          clientMessageId: parsed.data.clientMessageId,
          direction: 'out',
          type: 'text',
          body: parsed.data.body,
          status: 'sent',
          timestamp: now,
        },
      });
    } catch (err) {
      // The Baileys echo may have ingested it first — reuse that row (docs/05 §4).
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        sendResult.waMessageId
      ) {
        row = await prisma.message.findUniqueOrThrow({
          where: {
            conversationId_waMessageId: {
              conversationId: id,
              waMessageId: sendResult.waMessageId,
            },
          },
        });
      } else {
        throw err;
      }
    }
    await prisma.conversation.update({ where: { id }, data: { lastMessageAt: now } });

    const message = toSharedMessage(row);
    emit({
      type: 'message.created',
      conversationId: id,
      message,
      ts: Date.now(),
      schemaVersion: 1,
    });
    crmWorker.notify(id);
    return reply.code(202).send(message);
  });

  registerCrmRoutes(app, { prisma, worker: crmWorker, adapters, encryptionKey });
  registerDataRoutes(app, { prisma });

  return { app, io, crmWorker, manager };
}
