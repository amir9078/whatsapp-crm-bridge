// Emits prisma/schema.postgres.prisma — the same schema with the provider swapped to
// postgresql (Prisma forbids env-driven providers). Dev stays on SQLite; the Docker image
// generates + uses the Postgres flavour. Run: pnpm -F @wcb/db schema:postgres
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'prisma', 'schema.prisma');
const out = join(here, '..', 'prisma', 'schema.postgres.prisma');

const schema = readFileSync(src, 'utf8');
if (!schema.includes('provider = "sqlite"')) {
  throw new Error('expected provider = "sqlite" in schema.prisma — schema layout changed?');
}
writeFileSync(
  out,
  '// GENERATED from schema.prisma by scripts/postgres-schema.mjs — do not edit.\n' +
    schema.replace('provider = "sqlite"', 'provider = "postgresql"'),
);
