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
  /** Consecutive reconnects that never reached 'open'; past the cap we wipe → fresh QR. */
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  /** True only during the async window of connect(); blocks overlapping connect() calls. */
  private connecting = false;
  private static readonly MAX_RECONNECTS = 5;
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
    // Guard against overlapping connects: every close used to call connect() with no
    // teardown, so failing sessions spawned a pile of live sockets that each re-emitted
    // close→401 and re-saved creds — the 401 storm. One socket at a time, old one killed.
    if (this.connecting) return;
    this.connecting = true;
    try {
      this.teardownSocket();
      await this.openSocket();
    } catch (err) {
      this.connecting = false; // never leave the guard stuck — a failed setup must be retryable
      throw err;
    }
  }

  /** The socket setup + listener wiring, isolated so connect() can guard it cleanly. */
  private async openSocket(): Promise<void> {
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
    this.connecting = false; // socket created; subsequent reconnects may proceed

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.reconnectAttempts = 0; // a QR means we're pairing fresh — not a failing resume
        this.setStatus('qr_pending');
        this.emit({ type: 'qr', qr });
      }
      if (connection === 'open') {
        this.reconnectAttempts = 0;
        this.setStatus('connected');
        console.log('[connector] connection open');
      } else if (connection === 'close') {
        const statusCode = statusCodeOf(lastDisconnect?.error);
        console.log(`[connector] connection closed (code ${statusCode ?? 'unknown'})`);

        // Creds are definitively dead → wipe and show a fresh QR immediately.
        if (
          statusCode === DisconnectReason.loggedOut ||
          statusCode === DisconnectReason.forbidden ||
          statusCode === DisconnectReason.badSession
        ) {
          void this.resetSession();
          return;
        }
        // Another device took the session — don't fight it with a reconnect loop.
        if (statusCode === DisconnectReason.connectionReplaced) {
          this.setStatus('disconnected');
          console.log('[connector] session replaced by another device — not reconnecting');
          return;
        }
        // Transient close (restartRequired/timeout/connectionLost/…): retry with backoff,
        // but if a stored session keeps failing to resume, give up and force a fresh QR so
        // the UI never gets stuck on "connecting" forever.
        this.reconnectAttempts += 1;
        if (this.reconnectAttempts > BaileysConnector.MAX_RECONNECTS) {
          console.log(
            `[connector] ${this.reconnectAttempts} failed reconnects — wiping session for a fresh QR`,
          );
          void this.resetSession();
          return;
        }
        const backoffMs = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 15_000);
        this.setStatus('connecting');
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          this.connect().catch((err: unknown) => this.logger.error(err));
        }, backoffMs);
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
          console.log(
            `[connector] LIVE message (${type}) ${inbound.fromMe ? 'out→' : 'in←'} ${inbound.phoneE164} type=${inbound.type}`,
          );
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
  /** Detach + close the current socket so a dead session stops emitting events / saving creds. */
  private teardownSocket(): void {
    const sock = this.sock;
    this.sock = undefined;
    if (!sock) return;
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.ev.removeAllListeners('messaging-history.set');
      sock.ev.removeAllListeners('contacts.upsert');
      sock.ev.removeAllListeners('contacts.update');
      sock.ev.removeAllListeners('messages.update');
      sock.end(undefined);
    } catch (err) {
      this.logger.error(err);
    }
  }

  private async resetSession(): Promise<void> {
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.teardownSocket(); // kill the dead socket BEFORE wiping so it can't re-save creds
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
