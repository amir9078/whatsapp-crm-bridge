// Pure Baileys → canonical mapping (unit-testable, no socket).
//
// WhatsApp increasingly addresses 1:1 chats by privacy LID ("123456789012345@lid")
// instead of the phone JID. Storing those digits as phone numbers produces garbage
// contacts and breaks CRM matching — so LIDs are resolved to phone JIDs via the
// directory WhatsApp ships in history sync / contacts.upsert (Contact.id + Contact.lid).
import { normalizeMessageContent } from '@whiskeysockets/baileys';
import type { Contact as BaileysContact, WAMessage, proto } from '@whiskeysockets/baileys';
import type { ContactSync, InboundMessage, MediaMeta, MessageType } from '@wcb/shared';

export function phoneToJid(phoneE164: string): string {
  const digits = phoneE164.replace(/[^0-9]/g, '');
  return `${digits}@s.whatsapp.net`;
}

export function jidToPhone(jid: string): string {
  const user = jid.split('@')[0] ?? '';
  const digits = (user.split(':')[0] ?? '').replace(/[^0-9]/g, '');
  return `+${digits}`;
}

export const isLidJid = (jid: string): boolean => jid.endsWith('@lid');

/** Drop the device/agent suffix: "9715...:12@s.whatsapp.net" → "9715...@s.whatsapp.net". */
export function normalizeJid(jid: string): string {
  const [user = '', server = ''] = jid.split('@');
  return `${user.split(':')[0]}@${server}`;
}

/**
 * Flatten Baileys contact payloads into directory entries. `id` is normally the phone JID
 * and `lid` the privacy LID, but some payloads put a LID in `id` — classify by suffix and
 * keep only entries that carry a real phone JID (a LID alone can't be mapped).
 */
export function contactsToSync(
  contacts: ReadonlyArray<Partial<BaileysContact>>,
): ContactSync[] {
  const out: ContactSync[] = [];
  for (const c of contacts) {
    const id = c.id ? normalizeJid(c.id) : undefined;
    const lid = c.lid ? normalizeJid(c.lid) : undefined;
    let pnJid: string | undefined;
    let lidJid: string | undefined;
    if (id?.endsWith('@s.whatsapp.net')) pnJid = id;
    else if (id && isLidJid(id)) lidJid = id;
    if (lid && isLidJid(lid)) lidJid = lid;
    if (!pnJid) continue;
    const displayName = c.name ?? c.notify ?? c.verifiedName ?? undefined;
    out.push({ waId: pnJid, phoneE164: jidToPhone(pnJid), lidJid, displayName });
  }
  return out;
}

/**
 * History-sync chat records (proto.Conversation) carry the lid↔phone pair directly:
 * `id` is one identity, `pnJid`/`lidJid` the other, and `name`/`displayName` the chat
 * title. On many accounts this — not the contacts array — is the only source of the
 * mapping, so it feeds the same directory pipeline.
 */
export interface RawHistoryChat {
  id?: string | null;
  pnJid?: string | null;
  lidJid?: string | null;
  name?: string | null;
  displayName?: string | null;
  username?: string | null;
}

export function chatsToSync(chats: ReadonlyArray<RawHistoryChat>): ContactSync[] {
  const out: ContactSync[] = [];
  for (const chat of chats) {
    const id = chat.id ? normalizeJid(chat.id) : undefined;
    if (!id || id === 'status@broadcast') continue;
    if (id.endsWith('@g.us') || id.endsWith('@broadcast') || id.endsWith('@newsletter')) continue;

    let pnJid: string | undefined;
    let lidJid: string | undefined;
    if (isLidJid(id)) lidJid = id;
    else if (id.endsWith('@s.whatsapp.net')) pnJid = id;
    if (chat.pnJid) {
      const n = normalizeJid(chat.pnJid);
      if (n.endsWith('@s.whatsapp.net')) pnJid = n;
    }
    if (chat.lidJid) {
      const n = normalizeJid(chat.lidJid);
      if (isLidJid(n)) lidJid = n;
    }
    if (!pnJid) continue;

    const displayName = chat.name ?? chat.displayName ?? chat.username ?? undefined;
    out.push({ waId: pnJid, phoneE164: jidToPhone(pnJid), lidJid, displayName });
  }
  return out;
}

/** Map one Baileys message to the canonical inbound shape; undefined = skip (not a 1:1 chat, or protocol noise). */
export function toInboundMessage(
  message: WAMessage,
  lidToPn: ReadonlyMap<string, string>,
): InboundMessage | undefined {
  const rawJid = message.key.remoteJid ?? '';
  if (!rawJid || rawJid === 'status@broadcast') return undefined;
  if (rawJid.endsWith('@g.us') || rawJid.endsWith('@broadcast') || rawJid.endsWith('@newsletter')) {
    return undefined; // 1:1 only
  }
  const remoteJid = normalizeJid(rawJid);

  let phoneJid = remoteJid;
  let lidJid: string | undefined;
  if (isLidJid(remoteJid)) {
    lidJid = remoteJid;
    // Unresolved LIDs fall back to LID digits; the server re-resolves via lidJid once the
    // directory entry lands (see @wcb/db ingest).
    phoneJid = lidToPn.get(remoteJid) ?? remoteJid;
  }

  const extracted = extractContent(message.message);
  if (!extracted) return undefined; // protocol/system noise — not a human message
  return {
    waMessageId: message.key.id ?? undefined,
    fromMe: message.key.fromMe ?? false,
    remoteJid: rawJid,
    phoneE164: jidToPhone(phoneJid),
    lidJid,
    type: extracted.type,
    body: extracted.body,
    media: extracted.media,
    senderName: message.pushName ?? undefined,
    timestamp: new Date(toSeconds(message.messageTimestamp) * 1000).toISOString(),
  };
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

export function extractContent(rawContent: proto.IMessage | null | undefined):
  | {
      type: MessageType;
      body?: string;
      media?: MediaMeta;
    }
  | undefined {
  // Unwrap ephemeral / view-once / document-with-caption envelopes — without this,
  // disappearing-mode chats (common for business accounts) all degrade to 'system'.
  const content = normalizeMessageContent(rawContent ?? undefined);
  // Pure protocol traffic (key shares, history notifications, reactions, receipts…) is
  // not a human message — storing it litters chats with "[system]" bubbles.
  if (!content) return undefined;
  if (
    content.protocolMessage ||
    content.senderKeyDistributionMessage ||
    content.reactionMessage ||
    content.pollUpdateMessage ||
    content.keepInChatMessage
  ) {
    return undefined;
  }
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
