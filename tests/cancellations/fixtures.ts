import { randomUUID } from "node:crypto";
import type { BookingStatus, RentalType } from "@/generated/prisma/client";
import { testDb } from "../setup/db";
import { seedSession } from "../http/helpers";

// Callers must vi.mock("@/server/db") to testDb before importing this file.
const { HOUR, seedListing, seedQuote } = await import("../booking/fixtures");

export { HOUR };
export const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** An Auth.js session for an existing user (e.g. a listing's host). */
export async function sessionFor(userId: string) {
  const sessionToken = randomUUID();
  await testDb.session.create({
    data: { sessionToken, userId, expires: new Date(Date.now() + HOUR) },
  });
  return `authjs.session-token=${sessionToken}`;
}

/**
 * A booking on its own listing (so overlap never interferes), quoted under the active
 * policy, plus a SUCCEEDED payment of the total unless the status is PENDING_PAYMENT.
 */
export async function seedBooking(
  opts: {
    status?: BookingStatus;
    rentalType?: RentalType;
    startInHours?: number;
    totalPaise?: number;
  } = {},
) {
  const {
    status = "CONFIRMED",
    rentalType = "HOURLY",
    startInHours = 5,
    totalPaise = 100_000,
  } = opts;
  const listing = await seedListing();
  const renter = await seedSession();
  const host = { id: listing.hostId, cookie: await sessionFor(listing.hostId) };
  const startAt = new Date(Date.now() + startInHours * HOUR);
  const endAt = new Date(startAt.getTime() + 2 * HOUR);
  const quote = await seedQuote({
    listingId: listing.id,
    renterId: renter.user.id,
    vehicleId: null,
    startAt,
    endAt,
    rentalType,
  });
  const booking = await testDb.booking.create({
    data: {
      listingId: listing.id,
      renterId: renter.user.id,
      rentalType,
      startAt,
      endAt,
      blockedUntil: endAt,
      status,
      holdExpiresAt: status === "PENDING_PAYMENT" ? new Date(Date.now() + HOUR / 6) : null,
      quoteId: quote.id,
      subtotalPaise: totalPaise,
      commissionPaise: totalPaise / 10,
      hostEarningsPaise: totalPaise - totalPaise / 10,
      totalPaise,
    },
  });
  const payment =
    status === "PENDING_PAYMENT"
      ? null
      : await testDb.payment.create({
          data: {
            bookingId: booking.id,
            providerOrderId: `order_${randomUUID()}`,
            providerPaymentId: `pay_${randomUUID()}`,
            amountPaise: totalPaise,
            status: "SUCCEEDED",
          },
        });
  return { booking, listing, renter, host, payment };
}
