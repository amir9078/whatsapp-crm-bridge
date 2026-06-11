// M3 acceptance test: receive messages, "restart" (fresh client), query them back — no dupes.
// Runs against a throwaway SQLite db in the OS temp dir; schema is pushed before the tests.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InboundMessage } from '@wcb/shared';
import { PrismaClient } from '@prisma/client';
import {
  ensureConnection,
  ingestInboundMessage,
  syncContactDirectory,
  updateMessageStatus,
} from './ingest.js';
import { listConversations, listMessages } from './queries.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'wcb-db-test-'));
const dbPath = join(tmp, 'test.db').replace(/\\/g, '/');

let prisma: PrismaClient;

before(() => {
  process.env.DATABASE_URL = `file:${dbPath}`;
  execSync('pnpm exec prisma db push --skip-generate', {
    cwd: pkgDir,
    env: process.env,
    stdio: 'pipe',
  });
  prisma = new PrismaClient();
});

after(async () => {
  await prisma.$disconnect();
  rmSync(tmp, { recursive: true, force: true });
});

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    waMessageId: 'WAMID-1',
    fromMe: false,
    remoteJid: '971501234567@s.whatsapp.net',
    phoneE164: '+971501234567',
    type: 'text',
    body: 'Hi! I saw your post about the website packages',
    senderName: 'Sarah Mensah',
    timestamp: new Date('2026-06-09T09:12:00Z').toISOString(),
    ...overrides,
  };
}

test('ingesting the same message twice creates exactly one row (idempotent)', async () => {
  const connectionId = await ensureConnection(prisma, { phoneE164: '+971500000001' });

  const first = await ingestInboundMessage(prisma, connectionId, inbound());
  const second = await ingestInboundMessage(prisma, connectionId, inbound());

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.messageId, first.messageId);

  assert.equal(await prisma.contact.count(), 1);
  assert.equal(await prisma.conversation.count(), 1);
  assert.equal(await prisma.message.count(), 1);

  // duplicate must not double-count unread
  const convo = await prisma.conversation.findUniqueOrThrow({
    where: { id: first.conversationId },
  });
  assert.equal(convo.unreadCount, 1);
});

test('a second message lands in the same conversation; reply goes out', async () => {
  const connectionId = await ensureConnection(prisma);

  await ingestInboundMessage(
    prisma,
    connectionId,
    inbound({ waMessageId: 'WAMID-2', body: 'Premium, I think. Pricing?' }),
  );
  await ingestInboundMessage(
    prisma,
    connectionId,
    inbound({ waMessageId: 'WAMID-3', fromMe: true, body: 'Premium is $12,000, ~6 weeks.' }),
  );

  assert.equal(await prisma.conversation.count(), 1);
  assert.equal(await prisma.message.count(), 3);

  const updated = await updateMessageStatus(prisma, 'WAMID-3', 'read');
  assert.equal(updated, 1);
});

test('messages survive a "restart" (fresh client reads them back, ordered)', async () => {
  const fresh = new PrismaClient();
  try {
    const conversations = await listConversations(fresh);
    assert.equal(conversations.length, 1);
    const conversation = conversations[0];
    assert.ok(conversation);
    assert.equal(conversation.contact.phoneE164, '+971501234567');
    assert.equal(conversation.contact.displayName, 'Sarah Mensah');

    const messages = await listMessages(fresh, conversation.id);
    assert.equal(messages.length, 3);
    assert.deepEqual(
      messages.map((m) => m.direction),
      ['in', 'in', 'out'],
    );
    assert.equal(messages[2]?.status, 'read');
  } finally {
    await fresh.$disconnect();
  }
});

// ── LID + directory tests run last: they intentionally rename/merge contacts ──
test('directory entry names the contact; later lid messages land on the SAME contact', async () => {
  const connectionId = await ensureConnection(prisma);

  // Directory first (the normal history-sync order): name + lid mapping.
  await syncContactDirectory(prisma, [
    {
      waId: '971501234567@s.whatsapp.net',
      phoneE164: '+971501234567',
      lidJid: '186165810446339@lid',
      displayName: 'Sarah From The Address Book',
    },
  ]);
  const named = await prisma.contact.findUniqueOrThrow({
    where: { phoneE164: '+971501234567' },
  });
  assert.equal(named.displayName, 'Sarah From The Address Book');
  assert.equal(named.lidJid, '186165810446339@lid');

  // A lid-addressed message whose connector-side mapping failed (restart scenario):
  // phoneE164 is the lid pseudo-number, but lidJid lets the server route it correctly.
  const result = await ingestInboundMessage(
    prisma,
    connectionId,
    inbound({
      waMessageId: 'WAMID-LID-1',
      remoteJid: '186165810446339@lid',
      phoneE164: '+186165810446339',
      lidJid: '186165810446339@lid',
      body: 'lid-routed message',
      senderName: 'push name must not clobber',
    }),
  );
  const landedOn = await prisma.contact.findUniqueOrThrow({ where: { id: result.contactId } });
  assert.equal(landedOn.phoneE164, '+971501234567'); // real contact, not a lid ghost
  assert.equal(landedOn.displayName, 'Sarah From The Address Book'); // name preserved
  assert.equal(await prisma.contact.count(), 1);
});

test('name-only lid entry (lid-migrated accounts) names the contact in place', async () => {
  const connectionId = await ensureConnection(prisma);

  // A lid chat's messages arrive first → contact keyed by lid pseudo-number, nameless.
  await ingestInboundMessage(
    prisma,
    connectionId,
    inbound({
      waMessageId: 'WAMID-LID-3',
      remoteJid: '777888999000111@lid',
      phoneE164: '+777888999000111',
      lidJid: '777888999000111@lid',
      body: 'message from a lid-only chat',
    }),
  );

  // Directory entry carries ONLY lid + name (no phone — all WhatsApp reveals).
  const { updated } = await syncContactDirectory(prisma, [
    { lidJid: '777888999000111@lid', displayName: 'Anas Euronet' },
  ]);
  assert.equal(updated, 1);
  const named = await prisma.contact.findUniqueOrThrow({
    where: { phoneE164: '+777888999000111' },
  });
  assert.equal(named.displayName, 'Anas Euronet'); // chat list now reads like WhatsApp
  assert.equal(named.lidJid, '777888999000111@lid');
});

test('lid ghost created BEFORE the directory arrives is merged into the real contact', async () => {
  const connectionId = await ensureConnection(prisma);

  // Message from an unknown lid → ghost contact keyed by lid digits.
  const ghost = await ingestInboundMessage(
    prisma,
    connectionId,
    inbound({
      waMessageId: 'WAMID-LID-2',
      remoteJid: '222333444555666@lid',
      phoneE164: '+222333444555666',
      lidJid: '222333444555666@lid',
      body: 'early lid message',
    }),
  );
  assert.ok(await prisma.contact.findUnique({ where: { phoneE164: '+222333444555666' } }));

  // Directory arrives late and reveals the real identity.
  const { merged } = await syncContactDirectory(prisma, [
    {
      waId: '971509998877@s.whatsapp.net',
      phoneE164: '+971509998877',
      lidJid: '222333444555666@lid',
      displayName: 'Omar Khan',
    },
  ]);
  assert.equal(merged, 1);

  // Ghost gone; its message now belongs to the real contact's conversation.
  assert.equal(await prisma.contact.findUnique({ where: { phoneE164: '+222333444555666' } }), null);
  const real = await prisma.contact.findUniqueOrThrow({ where: { phoneE164: '+971509998877' } });
  assert.equal(real.displayName, 'Omar Khan');
  const message = await prisma.message.findFirstOrThrow({
    where: { waMessageId: 'WAMID-LID-2' },
    include: { conversation: true },
  });
  assert.equal(message.conversation.contactId, real.id);
  assert.notEqual(message.conversation.contactId, ghost.contactId === real.id ? '' : ghost.contactId);
});

