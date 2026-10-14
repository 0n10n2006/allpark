import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { req, seedSession } from "../http/helpers";
import { testDb, truncateAll } from "../setup/db";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { POST: signRoute } = await import("@/app/api/bookings/[id]/evidence/sign/route");
const { isOurEvidenceUrl } = await import("@/server/media/evidence");
const { ist, seedListing } = await import("../booking/fixtures");

beforeEach(truncateAll);
afterEach(() => vi.unstubAllEnvs());
afterAll(() => testDb.$disconnect());

async function seedBooking() {
  const [renter, host] = [await seedSession(), await seedSession(["RENTER", "HOST"])];
  const listing = await seedListing({ hostId: host.user.id });
  const b = await testDb.booking.create({
    data: {
      listingId: listing.id,
      renterId: renter.user.id,
      rentalType: "HOURLY",
      startAt: ist("10:00"),
      endAt: ist("12:00"),
      blockedUntil: ist("12:00"),
      status: "CONFIRMED",
      subtotalPaise: 10_000,
      commissionPaise: 1_000,
      hostEarningsPaise: 9_000,
      totalPaise: 10_000,
    },
  });
  return { id: b.id, renter, host };
}

const sign = (id: string, cookie: string) =>
  signRoute(req(`/api/bookings/${id}/evidence/sign`, { method: "POST", cookie, body: {} }), {
    params: Promise.resolve({ id }),
  });

describe("POST /api/bookings/:id/evidence/sign", () => {
  test("503 without Cloudinary; renter and host get params for incidents/<bookingId>; others 404", async () => {
    const { id, renter, host } = await seedBooking();
    vi.stubEnv("CLOUDINARY_CLOUD_NAME", "");
    expect((await sign(id, renter.cookie)).status).toBe(503);

    vi.stubEnv("CLOUDINARY_CLOUD_NAME", "demo");
    vi.stubEnv("CLOUDINARY_API_KEY", "key");
    vi.stubEnv("CLOUDINARY_API_SECRET", "secret");
    for (const who of [renter, host]) {
      const res = await sign(id, who.cookie);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.folder).toBe(`incidents/${id}`);
      expect(body.publicId).toMatch(new RegExp(`^incidents/${id}/`));
      expect(body.signature).toMatch(/^[0-9a-f]{40}$/);
    }
    const stranger = await seedSession();
    expect((await sign(id, stranger.cookie)).status).toBe(404);
  });
});

describe("isOurEvidenceUrl", () => {
  test("only our upload delivery URLs in this booking's evidence folder", () => {
    vi.stubEnv("CLOUDINARY_CLOUD_NAME", "demo");
    const id = randomUUID();
    const base = "https://res.cloudinary.com/demo/image/upload";
    expect(isOurEvidenceUrl(`${base}/v17/incidents/${id}/a_1.jpg`, id)).toBe(true);
    expect(isOurEvidenceUrl(`${base}/disputes/${id}/a.png`, id)).toBe(true);
    for (const bad of [
      `${base}/incidents/${randomUUID()}/a.jpg`,
      `https://res.cloudinary.com/other/image/upload/incidents/${id}/a.jpg`,
      `https://res.cloudinary.com/demo/image/fetch/https://evil.example/incidents/${id}/a.jpg`,
      `${base}/incidents/${id}/../x/a.jpg`,
      "not a url",
    ])
      expect(isOurEvidenceUrl(bad, id), bad).toBe(false);
  });
});
