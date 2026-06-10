import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
} from '@whiskeysockets/baileys';
import type { Contact as BaileysContact, WASocket } from '@whiskeysockets/baileys';
import { rm } from 'node:fs/promises';
import pino from 'pino';
import type {
  ConnectionStatus,
  ConnectorEvent,
  ConnectorEventHandler,
  MessageStatus,
  SendMessageInput,
  SendMessageResult,
  WhatsAppConnector,
} from '@wcb/shared';
import { useEncryptedMultiFileAuthState } from './auth-state.js';
import { contactsToSync, phoneToJid, toInboundMessage } from './message-mapping.js';

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
  /** LID → phone JID directory, fed by history sync + contacts events (message-mapping.ts). */
  private readonly lidToPn = new Map<string, string>();

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

  /** Feed the LID directory and forward address-book names to the server. */
  private ingestContacts(contacts: ReadonlyArray<Partial<BaileysContact>>): void {
    const synced = contactsToSync(contacts);
    if (synced.length === 0) return;
    for (const c of synced) {
      if (c.lidJid) this.lidToPn.set(c.lidJid, c.waId);
    }
    this.emit({ type: 'contacts', contacts: synced });
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
          // Device was unlinked from the phone — these creds are dead. Wipe them and
          // reconnect so the UI gets a fresh QR instead of a permanent dead session.
          void this.resetSession();
        } else {
          this.setStatus('connecting');
          this.connect().catch((err: unknown) => this.logger.error(err));
        }
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const message of messages) {
        const inbound = toInboundMessage(message, this.lidToPn);
        if (inbound) this.emit({ type: 'message', message: inbound });
      }
    });

    // Existing chats delivered by WhatsApp's multi-device history sync after pairing.
    // Contacts FIRST: they carry the lid→phone directory and address-book names the
    // message mapping depends on. Ingest dedupes by waMessageId, so replays are safe.
    sock.ev.on('messaging-history.set', ({ contacts, messages }) => {
      this.ingestContacts(contacts ?? []);
      for (const message of messages) {
        const inbound = toInboundMessage(message, this.lidToPn);
        if (inbound) this.emit({ type: 'message', message: { ...inbound, historySync: true } });
      }
    });

    sock.ev.on('contacts.upsert', (contacts) => this.ingestContacts(contacts));
    sock.ev.on('contacts.update', (contacts) => this.ingestContacts(contacts));

    sock.ev.on('messages.update', (updates) => {
      for (const update of updates) {
        const id = update.key?.id ?? undefined;
        const mapped = mapStatus(update.update?.status);
        if (id && mapped) this.emit({ type: 'message-status', waMessageId: id, status: mapped });
      }
    });
  }

  /** Wipe dead credentials and restart pairing (emits a fresh QR). */
  private async resetSession(): Promise<void> {
    this.sock = undefined;
    try {
      await rm(this.authDir, { recursive: true, force: true });
    } catch (err) {
      this.logger.error(err);
    }
    this.setStatus('disconnected');
    this.connect().catch((err: unknown) => this.logger.error(err));
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
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Read a Boom-style `error.output.statusCode` without depending on @hapi/boom. */
function statusCodeOf(error: unknown): number | undefined {
  if (error !== null && typeof error === 'object' && 'output' in error) {
    return (error as { output?: { statusCode?: number } }).output?.statusCode;
  }
  return undefined;
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
