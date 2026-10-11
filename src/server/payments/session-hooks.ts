import type { Prisma } from "@/generated/prisma/client";

// Settlement hooks set by sessions (T4.2), so payments never imports sessions. A leaf
// module with only type imports: it is fully initialised whichever side of the
// payments ↔ jobs ↔ sessions import cycle loads first.

export type SessionHooks = {
  /** After commit, for a newly confirmed booking: schedule reminders and grace jobs. */
  confirmed?: (bookingId: string) => Promise<void>;
  /** Inside settleTx (booking row locked): move endAt; false → the capture is refunded. */
  applyExtension?: (
    tx: Prisma.TransactionClient,
    bookingId: string,
    quoteId: string,
  ) => Promise<boolean>;
  /** After commit, for a settled extension: reschedule jobs and notify the renter. */
  extensionSettled?: (bookingId: string, quoteId: string, applied: boolean) => Promise<void>;
};

export const sessionHooks: SessionHooks = {};
