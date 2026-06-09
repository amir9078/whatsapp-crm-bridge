// Console harness for M2: scan a QR, watch messages stream in, send one back.
//   pnpm connector:dev
// Then type:  /send +9715XXXXXXXX Hello from ChatBridge
import qrcode from 'qrcode-terminal';
import { BaileysConnector } from './baileys-connector.js';

function printHelp(): void {
  console.log(
    '\nCommands:\n' +
      '  /send +<E164> <message>   e.g. /send +971501234567 Hello from ChatBridge\n' +
      '  /quit\n',
  );
}

async function main(): Promise<void> {
  const connector = new BaileysConnector({ authDir: process.env.WA_AUTH_DIR ?? 'auth_state' });

  connector.on((event) => {
    switch (event.type) {
      case 'qr':
        console.log('\n📱 Scan in WhatsApp → Settings → Linked devices → Link a device:\n');
        qrcode.generate(event.qr, { small: true });
        break;
      case 'connection':
        console.log(`[connection] ${event.status}`);
        if (event.status === 'connected') printHelp();
        break;
      case 'message': {
        const m = event.message;
        const arrow = m.fromMe ? 'me →' : `${m.senderName ?? m.phoneE164} →`;
        console.log(`[msg] ${arrow} (${m.type}) ${m.body ?? `<${m.type}>`}   [${m.phoneE164}]`);
        break;
      }
      case 'message-status':
        console.log(`[status] ${event.waMessageId} → ${event.status}`);
        break;
    }
  });

  // Optional self-terminating smoke run (used for automated verification): WA_SMOKE_MS=20000
  const smokeMs = Number(process.env.WA_SMOKE_MS ?? 0);
  if (smokeMs > 0) {
    setTimeout(() => {
      console.log('[smoke] timeout reached — exiting cleanly');
      connector
        .disconnect()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    }, smokeMs);
  }

  await connector.connect();

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const line = String(chunk).trim();
    if (!line) return;
    if (line === '/quit') {
      connector
        .disconnect()
        .catch(() => undefined)
        .finally(() => process.exit(0));
      return;
    }
    const match = /^\/send\s+(\+?\d+)\s+([\s\S]+)$/.exec(line);
    if (!match) {
      printHelp();
      return;
    }
    const rawPhone = match[1];
    const body = match[2];
    if (!rawPhone || !body) return;
    const toPhoneE164 = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
    connector
      .sendMessage({ toPhoneE164, type: 'text', body })
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
