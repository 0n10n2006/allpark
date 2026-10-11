import type { Prisma } from "@/generated/prisma/client";

// Extension settlement hooks, set by sessions (T4.2). A leaf module with only type imports,
// so it is fully initialised whichever side of the payments ↔ jobs ↔ sessions import cycle
// loads first.

export type ExtensionHooks = {
  /** Inside settleTx (booking row locked): move endAt; false → the capture is refunded. */
  apply?: (tx: Prisma.TransactionClient, bookingId: string, quoteId: string) => Promise<boolean>;
  /** After commit, for a settled extension: reschedule jobs and notify the renter. */
  after?: (bookingId: string, quoteId: string, applied: boolean) => Promise<void>;
};

export const extensionHooks: ExtensionHooks = {};
