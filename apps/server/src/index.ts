// Entry point: Baileys connectors (one per salesperson inbox) + Fastify/Socket.IO server.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaileysConnector } from '@wcb/connector';
import { createPrisma } from '@wcb/db';
import { buildServer } from './app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

try {
  process.loadEnvFile(resolve(root, '.env'));
} catch {
  // no .env — fall back to defaults below
}
process.env.DATABASE_URL ??= `file:${resolve(root, 'packages/db/prisma/dev.db').replace(/\\/g, '/')}`;

async function main(): Promise<void> {
  const prisma = createPrisma();
  const baseAuthDir = process.env.WA_AUTH_DIR ?? resolve(root, 'auth_state');
  const encryptionKey = process.env.APP_ENCRYPTION_KEY || undefined;

  const { app } = await buildServer({
    prisma,
    baseAuthDir,
    // One Baileys session per connection id, each with its own encrypted auth_state subfolder.
    connectorFactory: (connectionId) =>
      new BaileysConnector({ authDir: join(baseAuthDir, connectionId), encryptionKey }),
    auth: { password: process.env.AUTH_PASSWORD, secret: process.env.JWT_SECRET },
    encryptionKey,
    retentionDays: Number(process.env.RETENTION_DAYS ?? 0) || undefined,
  });

  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`✅ server listening on http://localhost:${port}  (API: /api/v1, WS: socket.io)`);
  console.log('   Open the web app to scan the QR(s), or GET /api/v1/connections');
  if (!process.env.AUTH_PASSWORD) {
    console.warn('⚠ AUTH_PASSWORD not set — the UI and API are open to anyone who can reach this port.');
  }
  if (!process.env.APP_ENCRYPTION_KEY) {
    console.warn('⚠ APP_ENCRYPTION_KEY not set — WhatsApp session + CRM credentials are stored unencrypted.');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
