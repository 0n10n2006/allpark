import type {
  AdminActionResponse,
  AdminRetryJobBody,
  AdminRetryNotificationBody,
} from "@/contracts";
import { Uuid } from "@/contracts";
import type { CurrentUser } from "@/server/auth/guards";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { DELIVER_JOB, DELIVER_MAX_ATTEMPTS, deliverJobKey } from "@/server/notifications/jobs";

export async function adminRetryJob(
  admin: CurrentUser,
  jobId: string,
  body: AdminRetryJobBody,
): Promise<AdminActionResponse> {
  if (!Uuid.safeParse(jobId).success)
    throw new HttpError("validation_error", "Invalid job id");

  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) throw new HttpError("not_found", "Job not found");

  if (job.status !== "DEAD") {
    throw new HttpError("conflict", "Only DEAD jobs can be retried");
  }

  const audit = await db.$transaction(async (tx) => {
    await tx.job.update({
      where: { id: jobId },
      data: {
        status: "PENDING",
        attempts: 0,
        runAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });

    return await tx.auditLog.create({
      data: {
        actorId: admin.id,
        action: "job.retry",
        targetType: "Job",
        targetId: jobId,
        reason: body.reason,
        metadata: {
          previousStatus: job.status,
          type: job.type,
        },
      },
    });
  });

  return { ok: true, auditLogId: audit.id };
}

export async function adminRetryNotification(
  admin: CurrentUser,
  notificationId: string,
  body: AdminRetryNotificationBody,
): Promise<AdminActionResponse> {
  if (!Uuid.safeParse(notificationId).success)
    throw new HttpError("validation_error", "Invalid notification id");

  const notification = await db.notification.findUnique({
    where: { id: notificationId },
  });
  if (!notification) throw new HttpError("not_found", "Notification not found");

  if (notification.status !== "FAILED") {
    throw new HttpError("conflict", "Only FAILED notifications can be retried");
  }

  const key = deliverJobKey(notificationId);

  const audit = await db.$transaction(async (tx) => {
    await tx.notification.update({
      where: { id: notificationId },
      data: {
        status: "PENDING",
        attempts: 0,
        lastError: null,
      },
    });

    await tx.job.upsert({
      where: { idempotencyKey: key },
      update: {
        status: "PENDING",
        attempts: 0,
        runAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
      create: {
        type: DELIVER_JOB,
        payload: { notificationId },
        runAt: new Date(),
        idempotencyKey: key,
        maxAttempts: DELIVER_MAX_ATTEMPTS,
        status: "PENDING",
        attempts: 0,
      },
    });

    return await tx.auditLog.create({
      data: {
        actorId: admin.id,
        action: "notification.retry",
        targetType: "Notification",
        targetId: notificationId,
        reason: body.reason,
        metadata: {
          previousStatus: notification.status,
          type: notification.type,
        },
      },
    });
  });

  return { ok: true, auditLogId: audit.id };
}
