import { PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient } from '@prisma/client';

/** Create a Prisma client. `DATABASE_URL` must be set (see .env.example). */
export function createPrisma(): PrismaClient {
  return new PrismaClient();
}
