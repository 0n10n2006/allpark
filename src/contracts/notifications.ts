import { z } from "zod";
import { NotificationChannel, NotificationStatus } from "../generated/prisma/enums";
import { IsoDateTime, Uuid, page } from "./common";

// FR-12 in-app inbox. Titles and bodies are rendered server-side from templates and
// must not contain sensitive data (address, access instructions).

export const InboxNotification = z.object({
  id: Uuid,
  type: z.string(),
  channel: z.enum(NotificationChannel),
  status: z.enum(NotificationStatus),
  title: z.string(),
  body: z.string(),
  /** In-app link target, e.g. "/bookings/<id>". */
  href: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type InboxNotification = z.infer<typeof InboxNotification>;

export const ListNotificationsResponse = page(InboxNotification);
export type ListNotificationsResponse = z.infer<typeof ListNotificationsResponse>;
