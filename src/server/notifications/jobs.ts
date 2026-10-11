import { z } from "zod";
import { db } from "@/server/db";
// The registry, not "@/server/jobs": that index imports builtins, which imports this file.
import { registerJob } from "@/server/jobs/registry";
import { getPreferences } from "@/server/users/users";
import { getEmailSender } from "./email";
import { isNotificationType, renderStored, templates } from "./templates";

export const DELIVER_JOB = "notifications.deliver";
export const DELIVER_MAX_ATTEMPTS = 5;
export const deliverJobKey = (notificationId: string) => `notification:${notificationId}`;

/**
 * Idempotent: SENT or CANCELLED rows no-op. In-app visibility needs no work (the inbox
 * shows every non-cancelled row once scheduledAt has passed); this sends the email.
 * Throws on failure so the runner retries; the final failure marks the row FAILED.
 */
export async function deliverNotification(notificationId: string) {
  const n = await db.notification.findUnique({ where: { id: notificationId } });
  if (!n || n.status !== "PENDING") return;

  const user = await db.user.findUnique({ where: { id: n.userId }, select: { email: true } });
  const prefs = (await getPreferences(n.userId)).notifications;
  const category = isNotificationType(n.type) ? templates[n.type].category : "transactional";
  const wantsEmail =
    !!user?.email && prefs.email && (category !== "reminder" || prefs.sessionReminders);

  await db.notification.update({ where: { id: n.id }, data: { attempts: { increment: 1 } } });
  if (wantsEmail) {
    const r = renderStored(n.type, n.payload);
    try {
      await getEmailSender().send({
        to: user!.email!,
        subject: r.emailSubject,
        text: r.emailText,
        html: r.emailHtml,
        notificationId: n.id,
        type: n.type,
      });
    } catch (error) {
      // The job row counts every attempt, including leases lost to crashes.
      const job = await db.job.findUnique({ where: { idempotencyKey: deliverJobKey(n.id) } });
      const final = !job || job.attempts + 1 >= job.maxAttempts;
      await db.notification.updateMany({
        where: { id: n.id, status: "PENDING" },
        // Generic: provider messages can contain addresses.
        data: { lastError: "Email send failed", ...(final && { status: "FAILED" }) },
      });
      throw error;
    }
  }
  await db.notification.updateMany({
    where: { id: n.id, status: "PENDING" },
    data: { status: "SENT", sentAt: new Date(), lastError: null },
  });
}

registerJob(DELIVER_JOB, z.object({ notificationId: z.uuid() }), ({ notificationId }) =>
  deliverNotification(notificationId),
);
