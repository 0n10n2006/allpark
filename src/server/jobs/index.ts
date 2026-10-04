import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";

export type EnqueueOptions = {
  runAt?: Date;
  idempotencyKey?: string;
  maxAttempts?: number;
};

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
