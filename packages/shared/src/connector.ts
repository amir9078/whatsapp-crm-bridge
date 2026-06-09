import type { ConnectionStatus, Provider } from './enums.js';
import type { WhatsAppEvent } from './events.js';

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

export type WhatsAppEventHandler = (event: WhatsAppEvent) => void;

/**
 * Provider-agnostic WhatsApp connection. Implemented by `@wcb/connector` (Baileys, M2) and,
 * later, a Cloud API variant — see docs/01 §3 and docs/05. This is the seam that keeps the
 * rest of the app independent of how we talk to WhatsApp.
 */
export interface WhatsAppConnector {
  readonly provider: Provider;

  /** Open the session. Emits `connection.status` events (including the QR while pairing). */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ConnectionStatus;

  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;

  /** Subscribe to inbound messages, status, and connection events. Returns an unsubscribe fn. */
  on(handler: WhatsAppEventHandler): () => void;
}
