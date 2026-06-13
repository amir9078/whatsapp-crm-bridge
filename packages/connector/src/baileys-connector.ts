import {
  Browsers,
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
import {
  chatsToSync,
  contactsToSync,
  jidToPhone,
  lidMappingsToSync,
  phoneToJid,
  toInboundMessage,
  type RawHistoryChat,
} from './message-mapping.js';

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

  /** Feed the LID directory and forward names/mappings to the server. */
  private ingestContacts(contacts: ReadonlyArray<Partial<BaileysContact>>): void {
    const synced = contactsToSync(contacts);
    if (synced.length === 0) return;
    for (const c of synced) {
      if (c.lidJid && c.waId) this.lidToPn.set(c.lidJid, c.waId);
    }
    this.emit({ type: 'contacts', contacts: synced });
  }

  /** A message resolved its own lid↔phone pair (remoteJidAlt) — record + propagate it once. */
  private learnPairFromMessage(lidJid: string | undefined, phoneE164: string): void {
    if (!lidJid || phoneE164 === jidToPhone(lidJid)) return; // nothing new / unresolved
    if (this.lidToPn.has(lidJid)) return;
    const pnJid = phoneToJid(phoneE164);
    this.lidToPn.set(lidJid, pnJid);
    this.emit({ type: 'contacts', contacts: [{ waId: pnJid, phoneE164, lidJid }] });
  }

  /** Ask Baileys' persisted lid-mapping store about lids history sync couldn't resolve. */
  private async resolveLidsFromStore(lids: string[]): Promise<void> {
    try {
      const store = this.sock?.signalRepository?.lidMapping;
      if (!store) return;
      const pairs = (await store.getPNsForLIDs(lids)) ?? [];
      const entries = lidMappingsToSync(pairs as Array<{ pn?: string; lid?: string }>);
      for (const e of entries) {
        if (e.lidJid && e.waId) this.lidToPn.set(e.lidJid, e.waId);
      }
      if (entries.length > 0) {
        this.emit({ type: 'contacts', contacts: entries });
        console.log(`[connector] lid store resolved ${entries.length}/${lids.length} lids`);
      }
    } catch (err) {
      this.logger.error(err);
    }
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
      // Desktop identity + full history: WhatsApp only sends the deep chat history
      // (not just the recent window) to devices presenting as a desktop client.
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: true,
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
      // 'notify' = new incoming message; 'append' = messages added to a chat, INCLUDING
      // your own messages sent from the phone. Dropping 'append' (the old bug) meant
      // outgoing-from-phone messages never appeared. Ingest dedupes by waMessageId.
      if (type !== 'notify' && type !== 'append') return;
      for (const message of messages) {
        const inbound = toInboundMessage(message, this.lidToPn);
        if (inbound) {
          this.learnPairFromMessage(inbound.lidJid, inbound.phoneE164);
          this.emit({ type: 'message', message: inbound });
        }
      }
    });

    // Existing chats delivered by WhatsApp's multi-device history sync after pairing.
    // Directory FIRST: chat records (Conversation.pnJid/lidJid/name) and contacts carry
    // the lid→phone mapping and names the message mapping depends on. Depending on the
    // account, either source may be the only one populated. Ingest dedupes by
    // waMessageId, so replays are safe.
    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
      const directory = [
        ...lidMappingsToSync(lidPnMappings ?? []),
        ...chatsToSync((chats ?? []) as RawHistoryChat[]),
        ...contactsToSync(contacts ?? []),
      ];
      // lid→pn pairs feed the mapping BEFORE messages so jids resolve where possible…
      for (const c of directory) {
        if (c.lidJid && c.waId) this.lidToPn.set(c.lidJid, c.waId);
      }
      let mapped = 0;
      let skipped = 0;
      const unresolvedLids = new Set<string>();
      for (const message of messages) {
        const inbound = toInboundMessage(message, this.lidToPn);
        if (inbound) {
          mapped++;
          if (inbound.lidJid && inbound.phoneE164 === jidToPhone(inbound.lidJid)) {
            unresolvedLids.add(inbound.lidJid);
          } else {
            this.learnPairFromMessage(inbound.lidJid, inbound.phoneE164);
          }
          this.emit({ type: 'message', message: { ...inbound, historySync: true } });
        } else {
          skipped++;
        }
      }
      // …and the directory event goes out AFTER, so name-only (lid) entries find the
      // contacts those messages just created.
      if (directory.length > 0) this.emit({ type: 'contacts', contacts: directory });
      // Ops breadcrumb for self-hosters (docker logs): what each history batch contained.
      const lidPn = directory.filter((c) => c.lidJid && c.waId).length;
      const nameOnly = directory.filter((c) => !c.waId).length;
      console.log(
        `[connector] history batch: ${chats?.length ?? 0} chats + ${contacts?.length ?? 0} contacts + ` +
          `${lidPnMappings?.length ?? 0} lid-pn pairs → ${directory.length} directory entries ` +
          `(${lidPn} lid→phone, ${nameOnly} name-only), ${messages.length} messages ` +
          `(${mapped} ingested, ${skipped} skipped, ${unresolvedLids.size} lids unresolved)`,
      );
      // Baileys 7 persists lid↔pn pairs in the signal store — ask it about leftovers.
      if (unresolvedLids.size > 0) void this.resolveLidsFromStore([...unresolvedLids]);
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
