// LID resolution, contact-directory flattening, and message-content unwrapping — the
// pure mapping layer that decides whether chats appear as real contacts or as garbage
// 15-digit pseudo-numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WAMessage } from '@whiskeysockets/baileys';
import {
  chatsToSync,
  contactsToSync,
  extractContent,
  isLidJid,
  jidToPhone,
  normalizeJid,
  toInboundMessage,
} from './message-mapping.js';

const waMsg = (over: Record<string, unknown>): WAMessage =>
  ({
    key: { remoteJid: '971501234567@s.whatsapp.net', fromMe: false, id: 'MSG1' },
    message: { conversation: 'hello' },
    messageTimestamp: 1765900000,
    ...over,
  }) as unknown as WAMessage;

test('jid helpers: normalization, lid detection, phone derivation', () => {
  assert.equal(normalizeJid('971501234567:12@s.whatsapp.net'), '971501234567@s.whatsapp.net');
  assert.equal(isLidJid('186165810446339@lid'), true);
  assert.equal(isLidJid('971501234567@s.whatsapp.net'), false);
  assert.equal(jidToPhone('971501234567@s.whatsapp.net'), '+971501234567');
});

test('phone-JID chat maps directly, no lid field', () => {
  const inbound = toInboundMessage(waMsg({}), new Map());
  assert.ok(inbound);
  assert.equal(inbound.phoneE164, '+971501234567');
  assert.equal(inbound.lidJid, undefined);
  assert.equal(inbound.body, 'hello');
});

test('@lid chat resolves to the real phone via the directory', () => {
  const lidToPn = new Map([['186165810446339@lid', '971501234567@s.whatsapp.net']]);
  const inbound = toInboundMessage(
    waMsg({ key: { remoteJid: '186165810446339@lid', fromMe: false, id: 'MSG2' } }),
    lidToPn,
  );
  assert.ok(inbound);
  assert.equal(inbound.phoneE164, '+971501234567'); // the REAL number, not lid digits
  assert.equal(inbound.lidJid, '186165810446339@lid');
});

test('unresolved @lid keeps lid digits but flags lidJid for server-side repair', () => {
  const inbound = toInboundMessage(
    waMsg({ key: { remoteJid: '186165810446339@lid', fromMe: false, id: 'MSG3' } }),
    new Map(),
  );
  assert.ok(inbound);
  assert.equal(inbound.phoneE164, '+186165810446339');
  assert.equal(inbound.lidJid, '186165810446339@lid');
});

test('groups, broadcasts, newsletters, status and PSA chats are excluded', () => {
  for (const jid of [
    '12036304@g.us',
    'status@broadcast',
    '123@broadcast',
    '12036304@newsletter',
    '0@c.us', // WhatsApp service/PSA chat — was surfacing as a "+0" contact
  ]) {
    assert.equal(toInboundMessage(waMsg({ key: { remoteJid: jid, id: 'X' } }), new Map()), undefined, jid);
  }
});

test('contactsToSync: names + lid pairs kept; lid-only entries keep their NAME', () => {
  const synced = contactsToSync([
    { id: '971501234567@s.whatsapp.net', lid: '186165810446339@lid', name: 'Anas Euronet' },
    { id: '971507654321@s.whatsapp.net', notify: 'Tariq' }, // pushName fallback, no lid
    // the shape Baileys actually emits on lid-migrated accounts (id = lid, name only):
    { id: '259510648225858@lid', name: 'Nafees Bhai Euronet' },
    { id: '99999@lid' }, // lid alone, NO name — carries nothing, dropped
    { id: undefined, name: 'ghost' },
  ]);
  assert.equal(synced.length, 3);
  assert.deepEqual(synced[0], {
    waId: '971501234567@s.whatsapp.net',
    phoneE164: '+971501234567',
    lidJid: '186165810446339@lid',
    displayName: 'Anas Euronet',
  });
  assert.equal(synced[1]?.displayName, 'Tariq');
  assert.deepEqual(synced[2], {
    waId: undefined,
    phoneE164: undefined,
    lidJid: '259510648225858@lid',
    displayName: 'Nafees Bhai Euronet',
  });
});

test('ephemeral and view-once wrappers unwrap to their real content', () => {
  const ephemeral = extractContent({
    ephemeralMessage: { message: { conversation: 'disappearing text' } },
  });
  assert.equal(ephemeral?.type, 'text');
  assert.equal(ephemeral?.body, 'disappearing text');

  const viewOnce = extractContent({
    viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } },
  });
  assert.equal(viewOnce?.type, 'image');
});

test('protocol noise is skipped entirely — no [system] bubbles in chats', () => {
  assert.equal(extractContent(undefined), undefined);
  assert.equal(extractContent({ protocolMessage: {} }), undefined);
  assert.equal(extractContent({ reactionMessage: {} }), undefined);
  assert.equal(extractContent({ senderKeyDistributionMessage: {} }), undefined);
  // …and at the message level:
  const skipped = toInboundMessage(
    waMsg({ message: { protocolMessage: { type: 0 } } }),
    new Map(),
  );
  assert.equal(skipped, undefined);
});

test('chatsToSync: history chat records carry the lid↔phone pair + chat name', () => {
  const synced = chatsToSync([
    // lid-form chat id, phone in pnJid — the shape seen on lid-migrated accounts
    { id: '186165810446339@lid', pnJid: '971543509318@s.whatsapp.net', name: 'Anas Euronet' },
    // phone-form chat id, lid in lidJid
    { id: '971507654321@s.whatsapp.net', lidJid: '222333444555666@lid', name: 'Tariq Euronet' },
    // groups/broadcast/newsletter are not 1:1 chats
    { id: '1203630@g.us', name: 'Warehouse Stock Group' },
    { id: 'status@broadcast' },
    // lid chat with no pn anywhere — kept as a NAME-ONLY entry
    { id: '999888777666555@lid', name: 'Faisal Bhai' },
  ]);
  assert.equal(synced.length, 3);
  assert.deepEqual(synced[0], {
    waId: '971543509318@s.whatsapp.net',
    phoneE164: '+971543509318',
    lidJid: '186165810446339@lid',
    displayName: 'Anas Euronet',
  });
  assert.deepEqual(synced[1], {
    waId: '971507654321@s.whatsapp.net',
    phoneE164: '+971507654321',
    lidJid: '222333444555666@lid',
    displayName: 'Tariq Euronet',
  });
  assert.deepEqual(synced[2], {
    waId: undefined,
    phoneE164: undefined,
    lidJid: '999888777666555@lid',
    displayName: 'Faisal Bhai',
  });
});
