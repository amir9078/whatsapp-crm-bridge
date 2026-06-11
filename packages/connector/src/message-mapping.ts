// Pure Baileys → canonical mapping (unit-testable, no socket).
//
// WhatsApp increasingly addresses 1:1 chats by privacy LID ("123456789012345@lid")
// instead of the phone JID. Storing those digits as phone numbers produces garbage
// contacts and breaks CRM matching — so LIDs are resolved to phone JIDs via the
// directory WhatsApp ships in history sync / contacts.upsert (Contact.id + Contact.lid).
import { normalizeMessageContent } from '@whiskeysockets/baileys';
import type {
  Contact as BaileysContact,
  WAMessage,
  WAMessageKey,
  proto,
} from '@whiskeysockets/baileys';
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

/** Jids that are not human 1:1 chats: groups, broadcast, newsletters, WhatsApp PSA ("0@c.us"). */
export function isNonChatJid(jid: string): boolean {
  return (
    jid === 'status@broadcast' ||
    jid.endsWith('@g.us') ||
    jid.endsWith('@broadcast') ||
    jid.endsWith('@newsletter') ||
    jidToPhone(jid).length <= 2 // "+0", "+" — PSA/service pseudo-jids
  );
}

/** Drop the device/agent suffix: "9715...:12@s.whatsapp.net" → "9715...@s.whatsapp.net". */
export function normalizeJid(jid: string): string {
  const [user = '', server = ''] = jid.split('@');
  return `${user.split(':')[0]}@${server}`;
}

/**
 * Flatten Baileys contact payloads into directory entries. `id` is normally the phone JID
 * and `lid` the privacy LID — but on lid-migrated accounts the history payload only has
 * `id = <lid>` plus a NAME (Baileys derives contacts from chat records). Those lid-only
 * entries are kept: they can't map a phone number, but they carry the display name.
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
    // Baileys 7 contacts may carry the real number directly (jid or bare E.164).
    const rawPhone = (c as { phoneNumber?: string }).phoneNumber;
    if (!pnJid && rawPhone) {
      const n = rawPhone.includes('@')
        ? normalizeJid(rawPhone)
        : `${rawPhone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
      if (n.endsWith('@s.whatsapp.net') && jidToPhone(n).length > 2) pnJid = n;
    }
    const displayName = c.name ?? c.notify ?? c.verifiedName ?? undefined;
    if (pnJid && isNonChatJid(pnJid)) continue;
    if (!pnJid && !lidJid) continue;
    if (!pnJid && !displayName) continue; // lid alone with no name carries nothing useful
    out.push({
      waId: pnJid,
      phoneE164: pnJid ? jidToPhone(pnJid) : undefined,
      lidJid,
      displayName,
    });
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
    if (!id || isNonChatJid(id)) continue;

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

    const displayName = chat.name ?? chat.displayName ?? chat.username ?? undefined;
    if (!pnJid && !lidJid) continue;
    if (!pnJid && !displayName) continue; // lid-only with no name — nothing to contribute
    out.push({
      waId: pnJid,
      phoneE164: pnJid ? jidToPhone(pnJid) : undefined,
      lidJid,
      displayName,
    });
  }
  return out;
}

/** Baileys 7 ships explicit lid↔phone pairs in history sync — straight to directory entries. */
export function lidMappingsToSync(
  mappings: ReadonlyArray<{ pn?: string | null; lid?: string | null }>,
): ContactSync[] {
  const out: ContactSync[] = [];
  for (const m of mappings) {
    if (!m.pn || !m.lid) continue;
    const pnJid = normalizeJid(m.pn);
    const lidJid = normalizeJid(m.lid);
    if (!pnJid.endsWith('@s.whatsapp.net') || !isLidJid(lidJid)) continue;
    if (jidToPhone(pnJid).length <= 2) continue;
    out.push({ waId: pnJid, phoneE164: jidToPhone(pnJid), lidJid });
  }
  return out;
}

/** Map one Baileys message to the canonical inbound shape; undefined = skip (not a 1:1 chat, or protocol noise). */
export function toInboundMessage(
  message: WAMessage,
  lidToPn: ReadonlyMap<string, string>,
): InboundMessage | undefined {
  const rawJid = message.key.remoteJid ?? '';
  if (!rawJid) return undefined;
  const remoteJid = normalizeJid(rawJid);
  if (isNonChatJid(remoteJid)) return undefined; // 1:1 human chats only

  // Baileys 7: remoteJidAlt is the OTHER identity of the chat (phone for lid chats,
  // lid for phone chats) — per-message lid↔phone resolution.
  const rawAlt = (message.key as WAMessageKey).remoteJidAlt;
  const altJid = rawAlt ? normalizeJid(rawAlt) : undefined;

  let phoneJid = remoteJid;
  let lidJid: string | undefined;
  if (isLidJid(remoteJid)) {
    lidJid = remoteJid;
    // Prefer the message's own alt jid, then the directory; fall back to LID digits —
    // the server re-resolves via lidJid once a mapping lands (see @wcb/db ingest).
    phoneJid =
      (altJid?.endsWith('@s.whatsapp.net') ? altJid : undefined) ??
      lidToPn.get(remoteJid) ??
      remoteJid;
  } else if (altJid && isLidJid(altJid)) {
    lidJid = altJid;
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
