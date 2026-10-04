import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";

export type EnqueueOptions = {
  runAt?: Date;
  idempotencyKey?: string;
  maxAttempts?: number;
};

const DEFAULT_LEASE_SECONDS = 5 * 60;

/**
 * Adds durable work to the database-backed queue.  An idempotency key is
 * protected by Postgres' unique constraint, including when callers race.
 */
export async function enqueue(
  type: string,
  payload: Prisma.InputJsonValue,
  options: EnqueueOptions = {},
) {
  try {
    return await db.job.create({
      data: {
        type,
        payload,
        runAt: options.runAt,
        idempotencyKey: options.idempotencyKey,
        maxAttempts: options.maxAttempts,
      },
    });
  } catch (error) {
    if (
      options.idempotencyKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await db.job.findUnique({
        where: { idempotencyKey: options.idempotencyKey },
      });
      if (existing) return existing;
    }
    throw error;
  }
}

/**
 * Atomically reclaims expired leases and claims due jobs. All scheduling checks
 * use Postgres' clock so worker clocks cannot make work run early or late.
 */
export async function claimDue(workerId: string, batchSize: number) {
  const limit = Math.max(1, Math.min(Math.floor(batchSize), 100));
  return db.$queryRaw<Awaited<ReturnType<typeof db.job.findMany>>>(Prisma.sql`
    WITH reclaimed AS (
      UPDATE "Job"
      SET status = 'PENDING', "lockedAt" = NULL, "lockedBy" = NULL, "updatedAt" = now()
      WHERE status = 'RUNNING'
        AND "lockedAt" < now() - (${DEFAULT_LEASE_SECONDS} * interval '1 second')
    )
    UPDATE "Job"
    SET status = 'RUNNING', "lockedAt" = now(), "lockedBy" = ${workerId}, "updatedAt" = now()
    WHERE id IN (
      SELECT id FROM "Job"
      WHERE status = 'PENDING' AND "runAt" <= now()
      ORDER BY "runAt"
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING *
  `);
}
