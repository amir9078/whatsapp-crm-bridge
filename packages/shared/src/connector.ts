import type { ConnectionStatus, MessageStatus, MessageType, Provider } from './enums.js';
import type { MediaMeta } from './message.js';

/** Input to send a message. Text-only for now; media variants are added in a later milestone. */
export interface SendMessageInput {
  toPhoneE164: string;
  conversationId?: string;
  clientMessageId?: string;
  type: 'text';
  body: string;
}

export interface SendMessageResult {
  waMessageId?: string;
  clientMessageId?: string;
}

/**
 * A message as seen by the connector, BEFORE database identity (conversationId / id) is
 * assigned. The server maps this onto the canonical `Message` + `WhatsAppEvent` (docs/05 §2).
 */
export interface InboundMessage {
  waMessageId?: string;
  fromMe: boolean;
  /** Raw WhatsApp JID, e.g. "971501234567@s.whatsapp.net". */
  remoteJid: string;
  phoneE164: string;
  /**
   * Present when the chat is addressed by WhatsApp's privacy LID (…@lid). When the
   * connector could resolve the LID, `phoneE164` is the real number; when it couldn't,
   * `phoneE164` is derived from the LID digits and the server resolves via this field.
   */
  lidJid?: string;
  type: MessageType;
  body?: string;
  media?: MediaMeta;
  senderName?: string;
  /** ISO 8601. */
  timestamp: string;
  /** True when delivered via WhatsApp's history sync (don't bump unread counters). */
  historySync?: boolean;
}

/** One address-book entry from WhatsApp (history sync / contacts.upsert): jids + name. */
export interface ContactSync {
  /** Phone JID, e.g. "971501234567@s.whatsapp.net". */
  waId: string;
  phoneE164: string;
  /** The contact's privacy LID jid (…@lid), when WhatsApp provides one. */
  lidJid?: string;
  /** Address-book name (preferred) or the contact's own push name. */
  displayName?: string;
}

/**
 * Low-level events emitted by a connector. The server translates these into the canonical
 * `WhatsAppEvent`s (which carry DB ids) before persisting / pushing / syncing.
 */
export type ConnectorEvent =
  | { type: 'qr'; qr: string }
  | { type: 'connection'; status: ConnectionStatus }
  | { type: 'message'; message: InboundMessage }
  | { type: 'message-status'; waMessageId: string; status: MessageStatus }
  | { type: 'contacts'; contacts: ContactSync[] };

export type ConnectorEventHandler = (event: ConnectorEvent) => void;

/**
 * Provider-agnostic WhatsApp connection. Implemented by `@wcb/connector` (Baileys, M2) and,
 * later, a Cloud API variant — see docs/01 §3 and docs/05. This is the seam that keeps the
 * rest of the app independent of how we talk to WhatsApp.
 */
export interface WhatsAppConnector {
  readonly provider: Provider;

  /** Open the session. Emits `connection` + `qr` events while pairing. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ConnectionStatus;

  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;

  /** Subscribe to connector events. Returns an unsubscribe fn. */
  on(handler: ConnectorEventHandler): () => void;
}
