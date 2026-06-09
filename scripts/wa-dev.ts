// M3 integration harness: connector → database. Run with `pnpm wa:dev`.
// Scan the QR once; messages then persist to SQLite and survive restarts
// (on startup it prints what's already stored). Replaced by the real server in M4.
import qrcode from 'qrcode-terminal';
import { BaileysConnector } from '@wcb/connector';
import {
  createPrisma,
  ensureConnection,
  ingestInboundMessage,
  listConversations,
  updateMessageStatus,
} from '@wcb/db';

async function main(): Promise<void> {
  process.env.DATABASE_URL ??= 'file:./dev.db'; // resolved against packages/db/prisma/
  const prisma = createPrisma();
  const connectionId = await ensureConnection(prisma);

  // Proof of persistence: show what survived the last run.
  const existing = await listConversations(prisma, 10);
  if (existing.length > 0) {
    console.log(`\n💾 Restored from previous runs (${existing.length} conversation(s)):`);
    for (const c of existing) {
      const name = c.contact.displayName ?? c.contact.phoneE164;
      console.log(`   • ${name} — last activity ${c.lastMessageAt?.toISOString() ?? 'n/a'}`);
    }
  } else {
    console.log('\n💾 Database is empty — messages you receive will be stored.');
  }

  const connector = new BaileysConnector({ authDir: process.env.WA_AUTH_DIR ?? 'auth_state' });

  connector.on((event) => {
    switch (event.type) {
      case 'qr':
        console.log('\n📱 Scan in WhatsApp → Settings → Linked devices → Link a device:\n');
        qrcode.generate(event.qr, { small: true });
        break;
      case 'connection':
        console.log(`[connection] ${event.status}`);
        if (event.status === 'connected') {
          console.log('\nCommands:  /send +<E164> <message>   |   /quit\n');
        }
        break;
      case 'message': {
        const m = event.message;
        ingestInboundMessage(prisma, connectionId, m)
          .then((r) => {
            const who = m.fromMe ? 'me →' : `${m.senderName ?? m.phoneE164} →`;
            const dupe = r.created ? '' : ' (duplicate, ignored)';
            console.log(`[saved] ${who} (${m.type}) ${m.body ?? `<${m.type}>`}${dupe}`);
          })
          .catch((err: unknown) => console.error('[db error]', err));
        break;
      }
      case 'message-status':
        updateMessageStatus(prisma, event.waMessageId, event.status).catch(() => undefined);
        console.log(`[status] ${event.waMessageId} → ${event.status}`);
        break;
    }
  });

  const smokeMs = Number(process.env.WA_SMOKE_MS ?? 0);
  if (smokeMs > 0) {
    setTimeout(() => {
      console.log('[smoke] timeout reached — exiting cleanly');
      void prisma.$disconnect().finally(() => process.exit(0));
    }, smokeMs);
  }

  await connector.connect();

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const line = String(chunk).trim();
    if (!line) return;
    if (line === '/quit') {
      void connector
        .disconnect()
        .catch(() => undefined)
        .then(() => prisma.$disconnect())
        .finally(() => process.exit(0));
      return;
    }
    const match = /^\/send\s+(\+?\d+)\s+([\s\S]+)$/.exec(line);
    if (!match?.[1] || !match[2]) {
      console.log('Usage: /send +9715XXXXXXXX your message   |   /quit');
      return;
    }
    const toPhoneE164 = match[1].startsWith('+') ? match[1] : `+${match[1]}`;
    connector
      .sendMessage({ toPhoneE164, type: 'text', body: match[2] })
      .then((res) => console.log(`[sent] waMessageId=${res.waMessageId ?? '?'}`))
      .catch((err: unknown) =>
        console.error('[send error]', err instanceof Error ? err.message : err),
      );
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
