// LID resolution, contact-directory flattening, and message-content unwrapping — the
// pure mapping layer that decides whether chats appear as real contacts or as garbage
// 15-digit pseudo-numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WAMessage } from '@whiskeysockets/baileys';
import {
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

test('groups, broadcasts, newsletters and status are excluded', () => {
  for (const jid of [
    '12036304@g.us',
    'status@broadcast',
    '123@broadcast',
    '12036304@newsletter',
  ]) {
    assert.equal(toInboundMessage(waMsg({ key: { remoteJid: jid, id: 'X' } }), new Map()), undefined, jid);
  }
});

test('contactsToSync: names + lid pairs from the address book; lid-only entries dropped', () => {
  const synced = contactsToSync([
    { id: '971501234567@s.whatsapp.net', lid: '186165810446339@lid', name: 'Anas Euronet' },
    { id: '971507654321@s.whatsapp.net', notify: 'Tariq' }, // pushName fallback, no lid
    { id: '99999@lid' }, // lid alone — unmappable, dropped
    { id: undefined, name: 'ghost' },
  ]);
  assert.equal(synced.length, 2);
  assert.deepEqual(synced[0], {
    waId: '971501234567@s.whatsapp.net',
    phoneE164: '+971501234567',
    lidJid: '186165810446339@lid',
    displayName: 'Anas Euronet',
  });
  assert.equal(synced[1]?.displayName, 'Tariq');
  assert.equal(synced[1]?.lidJid, undefined);
});

test('ephemeral and view-once wrappers unwrap to their real content', () => {
  const ephemeral = extractContent({
    ephemeralMessage: { message: { conversation: 'disappearing text' } },
  });
  assert.equal(ephemeral.type, 'text');
  assert.equal(ephemeral.body, 'disappearing text');

  const viewOnce = extractContent({
    viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } },
  });
  assert.equal(viewOnce.type, 'image');

  assert.equal(extractContent(undefined).type, 'system');
  assert.equal(extractContent({ protocolMessage: {} }).type, 'system');
});
