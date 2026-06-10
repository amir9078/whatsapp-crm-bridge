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
  Prisma,
  type PrismaClient,
} from '@wcb/db';
import type { ConnectorEvent, CrmAdapter, WhatsAppConnector, WhatsAppEvent } from '@wcb/shared';
import { createCrmAdapters } from '@wcb/crm';
import { toConversationDto, toSharedMessage } from './mappers.js';
import { CrmSyncWorker } from './crm/sync.js';
import { registerCrmRoutes } from './crm/routes.js';
import { Auth, bearerToken, type AuthConfig } from './auth.js';

export interface ServerDeps {
  prisma: PrismaClient;
  connector: WhatsAppConnector;
  waConnectionId: string;
  /** CRM adapter registry override (tests inject fakes). Defaults to the real adapters. */
  crmAdapters?: Record<string, CrmAdapter>;
  /** Sync debounce override (tests use a few ms). */
  crmDebounceMs?: number;
  /** Single-user auth (M7). No password → auth disabled (local dev). */
  auth?: AuthConfig;
}

export interface BuiltServer {
  app: FastifyInstance;
  io: IOServer;
  crmWorker: CrmSyncWorker;
}

const SendBody = z.object({
  body: z.string().min(1),
  clientMessageId: z.string().optional(),
});

const LoginBody = z.object({ password: z.string().min(1) });

/** Routes reachable without a token (the login flow itself + liveness probes). */
const PUBLIC_PATHS = new Set(['/api/v1/health', '/api/v1/auth/status', '/api/v1/auth/login']);

export async function buildServer({
  prisma,
  connector,
  waConnectionId,
  crmAdapters,
  crmDebounceMs,
  auth: authConfig,
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

  let lastQr: string | undefined;

  const emit = (event: WhatsAppEvent): void => {
    io.emit(event.type, event);
  };

  // CRM sync runs in the background off message events — never blocks delivery (docs/03 §6.3).
  const adapters = crmAdapters ?? createCrmAdapters();
  const crmWorker = new CrmSyncWorker({
    prisma,
    emit,
    adapters,
    defaultDebounceMs: crmDebounceMs,
    log: (msg, err) => app.log.error({ err }, msg),
  });
  app.addHook('onClose', () => crmWorker.stop());

  // ── connector events → DB → WebSocket (the two-path inbound flow, docs/05 §2) ──
  async function handleConnectorEvent(event: ConnectorEvent): Promise<void> {
    switch (event.type) {
      case 'qr':
        lastQr = event.qr;
        emit({
          type: 'connection.status',
          connectionId: waConnectionId,
          status: 'qr_pending',
          qr: event.qr,
          ts: Date.now(),
          schemaVersion: 1,
        });
        break;
      case 'connection':
        if (event.status === 'connected') lastQr = undefined;
        await prisma.waConnection
          .update({ where: { id: waConnectionId }, data: { status: event.status } })
          .catch(() => undefined);
        emit({
          type: 'connection.status',
          connectionId: waConnectionId,
          status: event.status,
          ts: Date.now(),
          schemaVersion: 1,
        });
        break;
      case 'message': {
        const result = await ingestInboundMessage(prisma, waConnectionId, event.message);
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

  connector.on((event) => {
    handleConnectorEvent(event).catch((err: unknown) => app.log.error(err));
  });

  // New browser connections immediately learn the current state (QR or connected).
  io.on('connection', (socket) => {
    socket.emit('connection.status', {
      type: 'connection.status',
      connectionId: waConnectionId,
      status: connector.getStatus(),
      qr: lastQr,
      ts: Date.now(),
      schemaVersion: 1,
    } satisfies WhatsAppEvent);
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

  app.get('/api/v1/connection', async () => ({
    id: waConnectionId,
    status: connector.getStatus(),
    qr: lastQr,
  }));

  app.get('/api/v1/conversations', async () => {
    const rows = await listConversations(prisma);
    return rows.map(toConversationDto);
  });

  app.get('/api/v1/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const conversation = await prisma.conversation.findUnique({ where: { id } });
    if (!conversation) return reply.code(404).send({ error: 'conversation not found' });
    const rows = await listMessages(prisma, id, 500);
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

  registerCrmRoutes(app, { prisma, worker: crmWorker, adapters });

  return { app, io, crmWorker };
}
