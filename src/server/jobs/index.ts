import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { getRegisteredJob } from "./registry";
import "./builtins";

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

export type RunOnceResult = {
  claimed: number;
  succeeded: number;
  retried: number;
  dead: number;
};

const FAILURE_ERROR = "Job handler failed";
const INVALID_PAYLOAD_ERROR = "Invalid job payload";
const UNKNOWN_TYPE_ERROR = "Unknown job type";

async function failJob(
  id: string,
  workerId: string,
  error: string,
): Promise<"retried" | "dead"> {
  const rows = await db.$queryRaw<{ status: string }[]>(Prisma.sql`
    UPDATE "Job"
    SET
      attempts = attempts + 1,
      "lastError" = ${error.slice(0, 256)},
      status = CASE WHEN attempts + 1 >= "maxAttempts" THEN 'DEAD'::"JobStatus" ELSE 'PENDING'::"JobStatus" END,
      "runAt" = CASE
        WHEN attempts + 1 >= "maxAttempts" THEN "runAt"
        ELSE now() + LEAST(3600, 30 * power(2, attempts)) * interval '1 second'
      END,
      "lockedAt" = NULL,
      "lockedBy" = NULL,
      "updatedAt" = now()
    WHERE id = ${id} AND status = 'RUNNING' AND "lockedBy" = ${workerId}
    RETURNING status::text
  `);
  return rows[0]?.status === "DEAD" ? "dead" : "retried";
}

/** Runs a single durable queue batch. */
export async function runOnce(workerId: string, batchSize = 10): Promise<RunOnceResult> {
  const jobs = await claimDue(workerId, batchSize);
  const result: RunOnceResult = { claimed: jobs.length, succeeded: 0, retried: 0, dead: 0 };

  for (const job of jobs) {
    const registered = getRegisteredJob(job.type);
    if (!registered) {
      result[await failJob(job.id, workerId, UNKNOWN_TYPE_ERROR)] += 1;
      continue;
    }

    const parsed = registered.schema.safeParse(job.payload);
    if (!parsed.success) {
      result[await failJob(job.id, workerId, INVALID_PAYLOAD_ERROR)] += 1;
      continue;
    }

    try {
      await registered.handler(parsed.data);
      const updated = await db.job.updateMany({
        where: { id: job.id, status: "RUNNING", lockedBy: workerId },
        data: { status: "SUCCEEDED", lockedAt: null, lockedBy: null, lastError: null },
      });
      result.succeeded += updated.count;
    } catch {
      result[await failJob(job.id, workerId, FAILURE_ERROR)] += 1;
    }
  }

  return result;
}
