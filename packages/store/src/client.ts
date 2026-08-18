import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | null = null;

/**
 * Lazy singleton so importing this package never opens a connection --
 * the worker, the web backend, and tests all share this module shape, and
 * only the first actual query dials the database (APP_DATABASE_URL).
 */
export function getPrisma(): PrismaClient {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

/** Closes the pool; mainly for tests, which otherwise hold the process open. */
export async function disconnectStore(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
