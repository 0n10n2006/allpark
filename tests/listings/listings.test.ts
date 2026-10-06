import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { req, seedSession } from "../http/helpers";
import { testDb, truncateAll } from "../setup/db";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const listingsRoute = await import("@/app/api/listings/route");
const itemRoute = await import("@/app/api/listings/[id]/route");
const mineRoute = await import("@/app/api/listings/mine/route");
const publishRoute = await import("@/app/api/listings/[id]/publish/route");
const photosRoute = await import("@/app/api/listings/[id]/photos/route");
const signRoute = await import("@/app/api/listings/[id]/photos/sign/route");
const availabilityRoute = await import("@/app/api/listings/[id]/availability/route");
const hostRoute = await import("@/app/api/me/host/route");
const { suspendListing, setHostVerification } = await import("@/server/listings/service");

beforeEach(() => truncateAll());
afterEach(() => vi.unstubAllEnvs());
afterAll(() => testDb.$disconnect());

const at = (id: string) => ({ params: Promise.resolve({ id }) });
const noParams = { params: Promise.resolve({}) };

const draftBody = {
  title: "Covered stilt spot",
  description: "Society stilt parking near FC Road, easy access.",
  address: "12 FC Road, Shivajinagar, Pune",
  locality: "Shivajinagar",
  lat: 18.53141,
  lng: 73.84463,
  spaceType: "STILT",
  vehicleTypes: ["SEDAN"],
  accessInstructions: "Gate code 1234",
  hourlyPaise: 4000,
};
const rules = [{ weekday: 1, startMinute: 480, endMinute: 1200 }];

async function host(verified: boolean) {
  const s = await seedSession(["RENTER", "HOST"]);
  if (verified)
    await testDb.user.update({
      where: { id: s.user.id },
      data: { hostVerificationStatus: "VERIFIED" },
    });
  return s;
}

async function createDraft(cookie: string, body: object = draftBody) {
  const res = await listingsRoute.POST(
    req("/api/listings", { method: "POST", cookie, body }),
    noParams,
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; status: string };
}

const publish = (id: string, cookie: string) =>
  publishRoute.POST(
    req(`/api/listings/${id}/publish`, { method: "POST", cookie, body: { attestAuthority: true } }),
    at(id),
  );

async function makePublishable(id: string) {
  await testDb.listingPhoto.create({
    data: {
      listingId: id,
      url: "https://res.cloudinary.com/t/a.jpg",
      publicId: `listings/${id}/a`,
    },
  });
  await testDb.availabilityRule.createMany({ data: rules.map((r) => ({ ...r, listingId: id })) });
}

async function publishedListing() {
  const owner = await host(true);
  const { id } = await createDraft(owner.cookie);
  await makePublishable(id);
  expect((await publish(id, owner.cookie)).status).toBe(200);
  return { id, owner };
}

describe("host onboarding", () => {
  test("POST /api/me/host adds HOST, sets PENDING, and records the attestation", async () => {
    const { user, cookie } = await seedSession();
    const res = await hostRoute.POST(
      req("/api/me/host", { method: "POST", cookie, body: { attestAuthority: true } }),
      noParams,
    );
    expect(await res.json()).toEqual({
      roles: ["RENTER", "HOST"],
      hostVerificationStatus: "PENDING",
    });
    expect(
      await testDb.auditLog.count({ where: { targetId: user.id, action: "host.apply" } }),
    ).toBe(1);
  });

  test("setHostVerification updates status and writes an AuditLog", async () => {
    const admin = await seedSession(["ADMIN"]);
    const { user } = await host(false);
    const { auditLogId } = await setHostVerification(
      admin.user.id,
      user.id,
      "VERIFIED",
      "ID checked",
    );
    const log = await testDb.auditLog.findUniqueOrThrow({ where: { id: auditLogId } });
    expect(log).toMatchObject({ actorId: admin.user.id, targetId: user.id, reason: "ID checked" });
    expect(
      (await testDb.user.findUniqueOrThrow({ where: { id: user.id } })).hostVerificationStatus,
    ).toBe("VERIFIED");
  });
});

describe("create and publish", () => {
  test("a renter without HOST can't create a listing", async () => {
    const { cookie } = await seedSession();
    const res = await listingsRoute.POST(
      req("/api/listings", { method: "POST", cookie, body: draftBody }),
      noParams,
    );
    expect(res.status).toBe(403);
  });

  test("an unverified host can create a draft, but publishing → 403", async () => {
    const { cookie } = await host(false);
    const draft = await createDraft(cookie);
    expect(draft.status).toBe("DRAFT");
    await makePublishable(draft.id);
    const res = await publish(draft.id, cookie);
    expect(res.status).toBe(403);
    expect((await testDb.listing.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe(
      "DRAFT",
    );
  });

  test("missing photo, out-of-Pune coords, no price, no rules → 422 with field details", async () => {
    const { cookie } = await host(true);
    const { id } = await createDraft(cookie, {
      ...draftBody,
      lat: 19.076,
      lng: 72.8777,
      hourlyPaise: null,
    });
    const res = await publish(id, cookie);
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error.code).toBe("unprocessable");
    expect(error.details.map((d: { path: string[] }) => d.path[0]).sort()).toEqual([
      "availability",
      "lat",
      "photos",
      "prices",
    ]);
  });

  test("a valid draft by a verified host publishes and records the attestation", async () => {
    const { id } = await publishedListing();
    const row = await testDb.listing.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("PUBLISHED");
    expect(row.hostAttestedAt).not.toBeNull();
  });
});

describe("ownership and privacy", () => {
  test("non-owner PATCH → 403; non-owner GET of a draft → 404; owner sees it", async () => {
    const owner = await host(false);
    const other = await host(true);
    const { id } = await createDraft(owner.cookie);
    const patch = await itemRoute.PATCH(
      req(`/api/listings/${id}`, {
        method: "PATCH",
        cookie: other.cookie,
        body: { title: "Mine now" },
      }),
      at(id),
    );
    expect(patch.status).toBe(403);
    expect(
      (await itemRoute.GET(req(`/api/listings/${id}`, { cookie: other.cookie }), at(id))).status,
    ).toBe(404);
    expect((await itemRoute.GET(req(`/api/listings/${id}`), at(id))).status).toBe(404);
    expect(
      (await itemRoute.GET(req(`/api/listings/${id}`, { cookie: owner.cookie }), at(id))).status,
    ).toBe(200);
  });

  test("GET /mine lists only the caller's listings with private fields; bad cursor → 400", async () => {
    const owner = await host(false);
    const other = await host(false);
    const { id } = await createDraft(owner.cookie);
    await createDraft(other.cookie);
    const res = await mineRoute.GET(req("/api/listings/mine", { cookie: owner.cookie }), noParams);
    const { items } = await res.json();
    expect(items.map((l: { id: string }) => l.id)).toEqual([id]);
    expect(items[0].accessInstructions).toBe("Gate code 1234");
    const bad = await mineRoute.GET(
      req("/api/listings/mine?cursor=nope", { cookie: owner.cookie }),
      noParams,
    );
    expect(bad.status).toBe(400);
  });

  test("public GET has no address, exact coords, or access instructions", async () => {
    const { id } = await publishedListing();
    const res = await itemRoute.GET(req(`/api/listings/${id}`), at(id));
    expect(res.status).toBe(200);
    const text = await res.text();
    const json = JSON.parse(text);
    for (const k of ["address", "lat", "lng", "accessInstructions", "hostId", "status"])
      expect(json).not.toHaveProperty(k);
    expect(text).not.toContain("Gate code");
    expect(text).not.toContain("12 FC Road");
    expect(text).not.toContain("18.53141");
    expect(json.approxLat).toBeCloseTo(18.531, 3);
    expect(json.host.verified).toBe(true);
  });

  test("PATCH re-rounds the public pin and leaves confirmed bookings untouched", async () => {
    const { id, owner } = await publishedListing();
    const renter = await seedSession();
    const startAt = new Date("2026-11-02T04:30:00Z");
    const endAt = new Date("2026-11-02T06:30:00Z");
    const booking = await testDb.booking.create({
      data: {
        listingId: id,
        renterId: renter.user.id,
        rentalType: "HOURLY",
        status: "CONFIRMED",
        startAt,
        endAt,
        blockedUntil: endAt,
        subtotalPaise: 8000,
        commissionPaise: 800,
        hostEarningsPaise: 7200,
        totalPaise: 8000,
      },
    });
    const res = await itemRoute.PATCH(
      req(`/api/listings/${id}`, {
        method: "PATCH",
        cookie: owner.cookie,
        body: { lat: 18.5591, lng: 73.7868, hourlyPaise: 5000, turnoverBufferMinutes: 30 },
      }),
      at(id),
    );
    expect(res.status).toBe(200);
    const row = await testDb.listing.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ lat: 18.5591, approxLat: 18.558, hourlyPaise: 5000 });
    expect(await testDb.booking.findUniqueOrThrow({ where: { id: booking.id } })).toEqual(booking);
  });

  test("PATCH that would make a published listing invalid → 422 and nothing changes", async () => {
    const { id, owner } = await publishedListing();
    const res = await itemRoute.PATCH(
      req(`/api/listings/${id}`, { method: "PATCH", cookie: owner.cookie, body: { lat: 19.076 } }),
      at(id),
    );
    expect(res.status).toBe(422);
    expect((await testDb.listing.findUniqueOrThrow({ where: { id } })).lat).toBe(draftBody.lat);
  });

  test("suspend writes an AuditLog and hides the listing from the public", async () => {
    const { id } = await publishedListing();
    const admin = await seedSession(["ADMIN"]);
    const { auditLogId } = await suspendListing(admin.user.id, id, "Fake listing report");
    expect(await testDb.auditLog.findUniqueOrThrow({ where: { id: auditLogId } })).toMatchObject({
      action: "listing.suspend",
      targetId: id,
      reason: "Fake listing report",
    });
    expect((await itemRoute.GET(req(`/api/listings/${id}`), at(id))).status).toBe(404);
    expect(
      (await itemRoute.GET(req(`/api/listings/${id}`, { cookie: admin.cookie }), at(id))).status,
    ).toBe(200);
  });
});

describe("photos", () => {
  const addPhoto = (id: string, cookie: string, publicId: string) =>
    photosRoute.POST(
      req(`/api/listings/${id}/photos`, { method: "POST", cookie, body: { publicId } }),
      at(id),
    );

  test("sign → 503 without Cloudinary env; signed payload scoped to the listing folder with it", async () => {
    const { cookie } = await host(false);
    const { id } = await createDraft(cookie);
    const sign = () =>
      signRoute.POST(
        req(`/api/listings/${id}/photos/sign`, { method: "POST", cookie, body: {} }),
        at(id),
      );
    vi.stubEnv("CLOUDINARY_CLOUD_NAME", "");
    const off = await sign();
    expect(off.status).toBe(503);
    expect((await off.json()).error.code).toBe("uploads_not_configured");

    vi.stubEnv("CLOUDINARY_CLOUD_NAME", "demo");
    vi.stubEnv("CLOUDINARY_API_KEY", "key");
    vi.stubEnv("CLOUDINARY_API_SECRET", "secret");
    const on = await sign();
    expect(on.status).toBe(200);
    const body = await on.json();
    expect(body).toMatchObject({
      folder: `listings/${id}`,
      apiKey: "key",
      allowedFormats: "jpg,png,webp",
    });
    expect(body.publicId).toMatch(new RegExp(`^listings/${id}/`));
    expect(body.signature).toMatch(/^[0-9a-f]{40}$/);
  });

  test("publicId outside the listing folder → 422; inside → saved PENDING at the next position", async () => {
    vi.stubEnv("CLOUDINARY_CLOUD_NAME", "demo");
    vi.stubEnv("CLOUDINARY_API_KEY", "key");
    vi.stubEnv("CLOUDINARY_API_SECRET", "secret");
    const { cookie } = await host(false);
    const { id } = await createDraft(cookie);
    const { id: otherId } = await createDraft(cookie);
    for (const bad of [`listings/${otherId}/x`, `listings/${id}/../${otherId}/x`, "x"])
      expect((await addPhoto(id, cookie, bad)).status, bad).toBe(422);

    const first = await (await addPhoto(id, cookie, `listings/${id}/a`)).json();
    const second = await (await addPhoto(id, cookie, `listings/${id}/b`)).json();
    expect([first.position, second.position]).toEqual([0, 1]);
    expect(first.url).toContain(`listings/${id}/a`);
    const row = await testDb.listingPhoto.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.moderationStatus).toBe("PENDING");

    const reordered = await photosRoute.PATCH(
      req(`/api/listings/${id}/photos`, {
        method: "PATCH",
        cookie,
        body: { photoIds: [second.id, first.id] },
      }),
      at(id),
    );
    expect((await reordered.json()).items.map((p: { id: string }) => p.id)).toEqual([
      second.id,
      first.id,
    ]);

    const del = await photosRoute.DELETE(
      req(`/api/listings/${id}/photos?photoId=${first.id}`, { method: "DELETE", cookie }),
      at(id),
    );
    expect((await del.json()).items).toHaveLength(1);
  });

  test("deleting the last photo of a published listing → 422", async () => {
    const { id, owner } = await publishedListing();
    const photo = await testDb.listingPhoto.findFirstOrThrow({ where: { listingId: id } });
    const res = await photosRoute.DELETE(
      req(`/api/listings/${id}/photos?photoId=${photo.id}`, {
        method: "DELETE",
        cookie: owner.cookie,
      }),
      at(id),
    );
    expect(res.status).toBe(422);
    expect(await testDb.listingPhoto.count({ where: { listingId: id } })).toBe(1);
  });
});

describe("availability", () => {
  const post = (id: string, cookie: string, body: object) =>
    availabilityRoute.POST(
      req(`/api/listings/${id}/availability`, { method: "POST", cookie, body }),
      at(id),
    );

  test("overlapping rules → 422; valid rules and exceptions replace the old set", async () => {
    const { cookie } = await host(false);
    const { id } = await createDraft(cookie);
    const overlap = await post(id, cookie, {
      rules: [
        { weekday: 1, startMinute: 480, endMinute: 720 },
        { weekday: 1, startMinute: 600, endMinute: 900 },
      ],
      exceptions: [],
    });
    expect(overlap.status).toBe(422);
    expect((await overlap.json()).error.details[0].path).toEqual(["rules", 1]);

    const inverted = await post(id, cookie, {
      rules: [{ weekday: 2, startMinute: 900, endMinute: 600 }],
      exceptions: [],
    });
    expect(inverted.status).toBe(422);

    const ok = await post(id, cookie, {
      rules: [
        { weekday: 1, startMinute: 480, endMinute: 720 },
        { weekday: 1, startMinute: 720, endMinute: 900 },
        { weekday: 0, startMinute: 0, endMinute: 1440 },
      ],
      exceptions: [
        { startAt: "2026-11-01T00:00:00Z", endAt: "2026-11-02T00:00:00Z", unavailable: true },
      ],
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).rules[0]).toEqual({ weekday: 0, startMinute: 0, endMinute: 1440 });
    expect(await testDb.availabilityRule.count({ where: { listingId: id } })).toBe(3);

    await post(id, cookie, { rules, exceptions: [] });
    expect(await testDb.availabilityRule.count({ where: { listingId: id } })).toBe(1);
    expect(await testDb.availabilityException.count({ where: { listingId: id } })).toBe(0);
  });

  test("non-owner → 403", async () => {
    const owner = await host(false);
    const other = await host(false);
    const { id } = await createDraft(owner.cookie);
    expect((await post(id, other.cookie, { rules, exceptions: [] })).status).toBe(403);
  });
});
