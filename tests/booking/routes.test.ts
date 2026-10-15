import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { BookingDetail, GetAvailabilityResponse, ListBookingsResponse } from "@/contracts";
import { testDb, truncateAll } from "../setup/db";
import { req, seedSession } from "../http/helpers";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { POST: holdRoute } = await import("@/app/api/bookings/hold/route");
const { GET: listRoute } = await import("@/app/api/bookings/route");
const { GET: getRoute } = await import("@/app/api/bookings/[id]/route");
const { GET: availabilityRoute } = await import("@/app/api/listings/[id]/availability/route");
const { MIN, ist, seedListing, seedQuote, seedVehicle } = await import("./fixtures");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const postHold = (cookie: string, quoteId: string, key = "h1") =>
  holdRoute(
    req("/api/bookings/hold", {
      method: "POST",
      cookie,
      body: { quoteId },
      headers: { "idempotency-key": key },
    }),
    params(""),
  );
const getBooking = (cookie: string, id: string) =>
  getRoute(req(`/api/bookings/${id}`, { cookie }), params(id));

async function setup() {
  const listing = await seedListing();
  const renter = await seedSession();
  const vehicle = await seedVehicle(renter.user.id);
  const quote = await seedQuote({
    listingId: listing.id,
    renterId: renter.user.id,
    vehicleId: vehicle.id,
    startAt: ist("10:00"),
    endAt: ist("12:00"),
  });
  return { listing, renter, vehicle, quote };
}

describe("POST /api/bookings/hold", () => {
  test("201 with a BookingDetail hold; replay returns the same; no access details yet", async () => {
    const { renter, quote } = await setup();
    const first = await postHold(renter.cookie, quote.id);
    expect(first.status).toBe(201);
    const hold = BookingDetail.parse(await first.json());
    expect(hold).toMatchObject({ status: "PENDING_PAYMENT", access: null, commission: null });
    expect(hold.holdExpiresAt).not.toBeNull();
    const again = await postHold(renter.cookie, quote.id);
    expect(again.status).toBe(201);
    expect((await again.json()).id).toBe(hold.id);
    expect(await testDb.booking.count()).toBe(1);
  });

  test("taken slot → 409 envelope with reason slot_unavailable", async () => {
    const { listing, renter, quote } = await setup();
    await postHold(renter.cookie, quote.id);
    const other = await seedSession();
    const v = await seedVehicle(other.user.id);
    const q2 = await seedQuote({
      listingId: listing.id,
      renterId: other.user.id,
      vehicleId: v.id,
      startAt: ist("11:00"),
      endAt: ist("13:00"),
    });
    const res = await postHold(other.cookie, q2.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({
      code: "conflict",
      details: { reason: "slot_unavailable" },
    });
  });

  test("someone else's quote → 422, no booking", async () => {
    const { quote } = await setup();
    const thief = await seedSession();
    expect((await postHold(thief.cookie, quote.id)).status).toBe(422);
    expect(await testDb.booking.count()).toBe(0);
  });
});

describe("GET /api/bookings/:id", () => {
  test("another renter gets 404; host and admin can read; access only once CONFIRMED", async () => {
    const { listing, renter, quote } = await setup();
    const { id } = await (await postHold(renter.cookie, quote.id)).json();

    const stranger = await seedSession();
    const denied = await getBooking(stranger.cookie, id);
    expect(denied.status).toBe(404);
    expect(JSON.stringify(await denied.json())).not.toMatch(/FC Road|4321/);

    const pending = BookingDetail.parse(await (await getBooking(renter.cookie, id)).json());
    expect(pending.access).toBeNull();

    await testDb.booking.update({ where: { id }, data: { status: "CONFIRMED" } });
    const mine = BookingDetail.parse(await (await getBooking(renter.cookie, id)).json());
    expect(mine.access).toMatchObject({
      address: "12 FC Road",
      accessInstructions: "Gate code 4321",
    });
    expect(mine.commission).toBeNull();

    const hostCookie = `authjs.session-token=host-${id}`;
    await testDb.session.create({
      data: {
        sessionToken: `host-${id}`,
        userId: listing.hostId,
        expires: new Date(Date.now() + 60 * MIN),
      },
    });
    const asHost = BookingDetail.parse(await (await getBooking(hostCookie, id)).json());
    expect(asHost.commission).toEqual({ paise: 10_000, currency: "INR" });
    expect(asHost.access).not.toBeNull();

    const admin = await seedSession(["ADMIN"]);
    const asAdmin = BookingDetail.parse(await (await getBooking(admin.cookie, id)).json());
    expect(asAdmin.access).toBeNull();

    // L7: after the session the renter keeps access for 24 h past endAt; the host always.
    const ended = async (hoursAgo: number) => {
      const endAt = new Date(Date.now() - hoursAgo * 60 * MIN);
      const startAt = new Date(endAt.getTime() - 60 * MIN);
      await testDb.booking.update({
        where: { id },
        data: { status: "COMPLETED", startAt, endAt, blockedUntil: endAt },
      });
    };
    const accessOf = async (cookie: string) =>
      BookingDetail.parse(await (await getBooking(cookie, id)).json()).access;
    await ended(1);
    expect(await accessOf(renter.cookie)).not.toBeNull();
    await ended(25);
    expect(await accessOf(renter.cookie)).toBeNull();
    expect(await accessOf(hostCookie)).not.toBeNull();
  });
});

describe("GET /api/bookings", () => {
  test("lists only my bookings, paginated", async () => {
    const { renter, quote } = await setup();
    await postHold(renter.cookie, quote.id);
    const stranger = await seedSession();
    const list = (cookie: string, qs = "") =>
      listRoute(req(`/api/bookings${qs}`, { cookie }), params(""));
    const mine = ListBookingsResponse.parse(await (await list(renter.cookie, "?limit=1")).json());
    expect(mine.items).toHaveLength(1);
    expect(mine.nextCursor).toBeNull();
    const theirs = ListBookingsResponse.parse(await (await list(stranger.cookie)).json());
    expect(theirs.items).toEqual([]);
    const past = ListBookingsResponse.parse(
      await (await list(renter.cookie, "?scope=past")).json(),
    );
    expect(past.items).toEqual([]);
  });
});

describe("GET /api/listings/:id/availability", () => {
  test("public busy windows include the buffer, hide renters, and skip stale holds", async () => {
    const { listing, renter, quote } = await setup();
    await testDb.listing.update({ where: { id: listing.id }, data: { turnoverBufferMinutes: 15 } });
    const { id } = await (await postHold(renter.cookie, quote.id)).json();
    const get = () =>
      availabilityRoute(
        req(
          `/api/listings/${listing.id}/availability?from=${ist("00:00").toISOString()}&to=${ist("23:00").toISOString()}`,
        ),
        params(listing.id),
      );
    const res = await get();
    expect(res.status).toBe(200);
    const body = GetAvailabilityResponse.parse(await res.json());
    expect(body.busy).toEqual([
      { startAt: ist("10:00").toISOString(), endAt: ist("12:15").toISOString() },
    ]);
    expect(body.rules).toHaveLength(7);
    expect(JSON.stringify(body)).not.toContain(renter.user.id);

    await testDb.booking.update({
      where: { id },
      data: { holdExpiresAt: new Date(Date.now() - MIN) },
    });
    expect(GetAvailabilityResponse.parse(await (await get()).json()).busy).toEqual([]);
  });

  test("draft listing → 404 for the public", async () => {
    const listing = await seedListing({ status: "DRAFT" });
    const res = await availabilityRoute(
      req(`/api/listings/${listing.id}/availability`),
      params(listing.id),
    );
    expect(res.status).toBe(404);
  });
});
