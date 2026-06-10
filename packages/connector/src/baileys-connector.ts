import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
} from '@whiskeysockets/baileys';
import { useEncryptedMultiFileAuthState } from './auth-state.js';
import type { WAMessage, WASocket, proto } from '@whiskeysockets/baileys';
import pino from 'pino';
import type {
  ConnectionStatus,
  ConnectorEvent,
  ConnectorEventHandler,
  InboundMessage,
  MediaMeta,
  MessageStatus,
  MessageType,
  SendMessageInput,
  SendMessageResult,
  WhatsAppConnector,
} from '@wcb/shared';

type PinoLogger = ReturnType<typeof pino>;

export interface BaileysConnectorOptions {
  /** Folder for the multi-file auth state (treat as a credential; gitignored). Default "auth_state". */
  authDir?: string;
  /**
   * 32-byte hex key → auth_state files are AES-256-GCM encrypted at rest (M8).
   * Defaults to APP_ENCRYPTION_KEY so every entry point (server, CLI, scripts) is covered.
   */
  encryptionKey?: string;
  logger?: PinoLogger;
}

/**
 * Baileys implementation of {@link WhatsAppConnector}. Holds one WhatsApp multi-device
 * session, persists auth state to disk, auto-reconnects, and emits {@link ConnectorEvent}s.
 * Spec: docs/05-realtime-sync.md §1–3.
 */
export class BaileysConnector implements WhatsAppConnector {
  readonly provider = 'baileys' as const;

  private sock?: WASocket;
  private status: ConnectionStatus = 'disconnected';
  private readonly handlers = new Set<ConnectorEventHandler>();
  private readonly authDir: string;
  private readonly encryptionKey?: string;
  private readonly logger: PinoLogger;

  constructor(opts: BaileysConnectorOptions = {}) {
    this.authDir = opts.authDir ?? 'auth_state';
    this.encryptionKey = opts.encryptionKey ?? (process.env.APP_ENCRYPTION_KEY || undefined);
    this.logger = opts.logger ?? pino({ level: 'silent' });
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  on(handler: ConnectorEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(event: ConnectorEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.emit({ type: 'connection', status });
  }

  async connect(): Promise<void> {
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(
      this.authDir,
      this.encryptionKey,
    );

    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      version = undefined; // fall back to Baileys' bundled default
    }

    this.setStatus('connecting');

    const sock = makeWASocket({
      version,
      auth: state,
      logger: this.logger,
      browser: ['ChatBridge', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.setStatus('qr_pending');
        this.emit({ type: 'qr', qr });
      }
      if (connection === 'open') {
        this.setStatus('connected');
      } else if (connection === 'close') {
        const statusCode = statusCodeOf(lastDisconnect?.error);
        if (statusCode === DisconnectReason.loggedOut) {
          this.setStatus('disconnected'); // link revoked — a fresh QR scan is required
        } else {
          this.setStatus('connecting');
          this.connect().catch((err: unknown) => this.logger.error(err));
        }
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const message of messages) {
        const inbound = this.toInbound(message);
        if (inbound) this.emit({ type: 'message', message: inbound });
      }
    });

    // Existing chats delivered by WhatsApp's multi-device history sync after pairing.
    // Ingest dedupes by waMessageId, so replays are safe; historySync skips unread bumps.
    sock.ev.on('messaging-history.set', ({ messages }) => {
      for (const message of messages) {
        const inbound = this.toInbound(message);
        if (inbound) this.emit({ type: 'message', message: { ...inbound, historySync: true } });
      }
    });

    sock.ev.on('messages.update', (updates) => {
      for (const update of updates) {
        const id = update.key?.id ?? undefined;
        const mapped = mapStatus(update.update?.status);
        if (id && mapped) this.emit({ type: 'message-status', waMessageId: id, status: mapped });
      }
    });
  }

  async disconnect(): Promise<void> {
    try {
      await this.sock?.logout();
    } catch {
      // ignore — best effort
    }
    this.sock = undefined;
    this.setStatus('disconnected');
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    if (!this.sock) throw new Error('WhatsApp is not connected');
    const jid = phoneToJid(input.toPhoneE164);
    const sent = await this.sock.sendMessage(jid, { text: input.body });
    return { waMessageId: sent?.key?.id ?? undefined, clientMessageId: input.clientMessageId };
  }

  private toInbound(message: WAMessage): InboundMessage | undefined {
    const remoteJid = message.key.remoteJid ?? '';
    if (!remoteJid || remoteJid === 'status@broadcast') return undefined;
    if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast')) return undefined; // 1:1 only
    const { type, body, media } = extractContent(message.message);
    return {
      waMessageId: message.key.id ?? undefined,
      fromMe: message.key.fromMe ?? false,
      remoteJid,
      phoneE164: jidToPhone(remoteJid),
      type,
      body,
      media,
      senderName: message.pushName ?? undefined,
      timestamp: new Date(toSeconds(message.messageTimestamp) * 1000).toISOString(),
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function phoneToJid(phoneE164: string): string {
  const digits = phoneE164.replace(/[^0-9]/g, '');
  return `${digits}@s.whatsapp.net`;
}

function jidToPhone(jid: string): string {
  const user = jid.split('@')[0] ?? '';
  const digits = (user.split(':')[0] ?? '').replace(/[^0-9]/g, '');
  return `+${digits}`;
}

/** Read a Boom-style `error.output.statusCode` without depending on @hapi/boom. */
function statusCodeOf(error: unknown): number | undefined {
  if (error !== null && typeof error === 'object' && 'output' in error) {
    return (error as { output?: { statusCode?: number } }).output?.statusCode;
  }
  return undefined;
}

/** WhatsApp timestamps can be a number or a protobuf Long. */
function toSeconds(value: unknown): number {
  if (typeof value === 'number') return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    'toNumber' in value &&
    typeof (value as { toNumber: unknown }).toNumber === 'function'
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Date.now() / 1000;
}

/** proto.WebMessageInfo.Status: 2 SERVER_ACK, 3 DELIVERY_ACK, 4 READ, 5 PLAYED. */
function mapStatus(status: number | null | undefined): MessageStatus | undefined {
  switch (status) {
    case 2:
      return 'sent';
    case 3:
      return 'delivered';
    case 4:
    case 5:
      return 'read';
    default:
      return undefined;
  }
}

function extractContent(content: proto.IMessage | null | undefined): {
  type: MessageType;
  body?: string;
  media?: MediaMeta;
} {
  if (!content) return { type: 'system' };
  if (content.conversation) return { type: 'text', body: content.conversation };
  if (content.extendedTextMessage?.text) {
    return { type: 'text', body: content.extendedTextMessage.text };
  }
  if (content.imageMessage) {
    return {
      type: 'image',
      body: content.imageMessage.caption ?? undefined,
      media: { mimeType: content.imageMessage.mimetype ?? undefined },
    };
  }
  if (content.videoMessage) {
    return {
      type: 'video',
      body: content.videoMessage.caption ?? undefined,
      media: { mimeType: content.videoMessage.mimetype ?? undefined },
    };
  }
  if (content.audioMessage) {
    return {
      type: 'audio',
      media: {
        mimeType: content.audioMessage.mimetype ?? undefined,
        durationSec: content.audioMessage.seconds ?? undefined,
      },
    };
  }
  if (content.documentMessage) {
    return {
      type: 'document',
      body: content.documentMessage.caption ?? undefined,
      media: {
        fileName: content.documentMessage.fileName ?? undefined,
        mimeType: content.documentMessage.mimetype ?? undefined,
      },
    };
  }
  if (content.stickerMessage) return { type: 'sticker' };
  if (content.locationMessage) return { type: 'location' };
  if (content.contactMessage || content.contactsArrayMessage) return { type: 'contact' };
  return { type: 'system' };
}
