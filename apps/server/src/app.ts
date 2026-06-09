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
import type { ConnectorEvent, WhatsAppConnector, WhatsAppEvent } from '@wcb/shared';
import { toConversationDto, toSharedMessage } from './mappers.js';

export interface ServerDeps {
  prisma: PrismaClient;
  connector: WhatsAppConnector;
  waConnectionId: string;
}

export interface BuiltServer {
  app: FastifyInstance;
  io: IOServer;
}

const SendBody = z.object({
  body: z.string().min(1),
  clientMessageId: z.string().optional(),
});

export async function buildServer({ prisma, connector, waConnectionId }: ServerDeps): Promise<BuiltServer> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  const io = new IOServer(app.server, { cors: { origin: true } });
  let lastQr: string | undefined;

  const emit = (event: WhatsAppEvent): void => {
    io.emit(event.type, event);
  };

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
    return reply.code(202).send(message);
  });

  return { app, io };
}
