// Entry point: real Baileys connector + Fastify/Socket.IO server, one process (self-host).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaileysConnector } from '@wcb/connector';
import { createPrisma, ensureConnection } from '@wcb/db';
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
  const waConnectionId = await ensureConnection(prisma);
  const connector = new BaileysConnector({
    authDir: process.env.WA_AUTH_DIR ?? resolve(root, 'auth_state'),
  });

  const { app } = await buildServer({ prisma, connector, waConnectionId });
  await connector.connect();

  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`✅ server listening on http://localhost:${port}  (API: /api/v1, WS: socket.io)`);
  console.log('   Open the web app to scan the QR, or GET /api/v1/connection');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
