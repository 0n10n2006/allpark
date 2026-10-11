import type { InboxNotification, ListNotificationsResponse } from "@/contracts";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { enqueue } from "@/server/jobs";
import { DELIVER_JOB, DELIVER_MAX_ATTEMPTS, deliverJobKey } from "./jobs";
import {
  type NotificationPayload,
  type NotificationType,
  renderStored,
  templates,
} from "./templates";

export type { NotificationPayload, NotificationType } from "./templates";

/**
 * Creates an in-app notification (+ email, per preferences) delivered at `scheduledAt`.
 * Calls with the same idempotencyKey collapse into one row and one send. A key that was
 * cancelled stays cancelled, so a rescheduled reminder needs a new key: include the
 * target time, e.g. `booking:<id>:ending:30:<endAtISO>`.
 */
export async function notify<T extends NotificationType>(
  userId: string,
  type: T,
  payload: NotificationPayload<T>,
  opts: { scheduledAt?: Date; idempotencyKey: string },
) {
  const data = templates[type].schema.parse(payload) as Prisma.InputJsonObject;
  const scheduledAt = opts.scheduledAt ?? new Date();
  let row;
  try {
    row = await db.notification.create({
      data: {
        userId,
        type,
        channel: "IN_APP",
        payload: data,
        scheduledAt,
        idempotencyKey: opts.idempotencyKey,
      },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"))
      throw error;
    row = await db.notification.findUniqueOrThrow({
      where: { idempotencyKey: opts.idempotencyKey },
    });
  }
  // Re-enqueued on a duplicate call too, so a crash between the two writes heals on retry.
  await enqueue(
    DELIVER_JOB,
    { notificationId: row.id },
    {
      runAt: row.scheduledAt,
      idempotencyKey: deliverJobKey(row.id),
      maxAttempts: DELIVER_MAX_ATTEMPTS,
    },
  );
  return row;
}

/** Cancels pending notifications whose key starts with the prefix (booking cancelled/extended). */
export async function cancelScheduled(idempotencyKeyPrefix: string) {
  if (!idempotencyKeyPrefix) throw new Error("cancelScheduled needs a non-empty prefix");
  const { count } = await db.notification.updateMany({
    where: { idempotencyKey: { startsWith: idempotencyKeyPrefix }, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  return count;
}

// Visible in-app once due, whatever happened to the email.
const visible = (userId: string): Prisma.NotificationWhereInput => ({
  userId,
  status: { not: "CANCELLED" },
  scheduledAt: { lte: new Date() },
});

export async function listInbox(
  userId: string,
  { cursor, limit }: { cursor?: string; limit: number },
): Promise<ListNotificationsResponse> {
  const where = visible(userId);
  const [rows, unreadCount] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    }),
    db.notification.count({ where: { ...where, readAt: null } }),
  ]);
  const items = rows.slice(0, limit).map((n): InboxNotification => {
    const r = renderStored(n.type, n.payload);
    return {
      id: n.id,
      type: n.type,
      channel: n.channel,
      status: n.status,
      title: r.title,
      body: r.body,
      href: r.link,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    };
  });
  return {
    items,
    nextCursor: rows.length > limit ? items[items.length - 1].id : null,
    unreadCount,
  };
}

/** Owner only; someone else's id is a 404 so existence doesn't leak. */
export async function markRead(userId: string, id: string) {
  const { count } = await db.notification.updateMany({
    where: { ...visible(userId), id },
    data: { readAt: new Date() },
  });
  if (count === 0) throw new HttpError("not_found", "Notification not found");
}
