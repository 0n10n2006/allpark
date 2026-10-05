import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";

/** Append-only audit trail (PRD §9). Keep PII out of `metadata`. */
export function audit(
  actorId: string | null,
  action: string,
  targetType: string,
  targetId: string | null,
  reason?: string | null,
  metadata?: Prisma.InputJsonValue,
) {
  return db.auditLog.create({
    data: { actorId, action, targetType, targetId, reason, metadata },
  });
}
