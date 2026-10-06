import { testDb, truncateAll } from "../setup/db";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { noParams, req, seedSession } from "../http/helpers";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const profile = await import("@/app/api/me/profile/route");
const prefs = await import("@/app/api/me/preferences/route");
const vehicles = await import("@/app/api/me/vehicles/route");
const vehicle = await import("@/app/api/me/vehicles/[id]/route");
const { POST: deletionRequest } = await import("@/app/api/me/deletion-request/route");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

const addVehicle = (cookie: string, body: unknown) =>
  vehicles.POST(req("/api/me/vehicles", { method: "POST", cookie, body }), noParams);

describe("auth", () => {
  test("unauthenticated → 401 on every route", async () => {
    const id = crypto.randomUUID();
    const responses = await Promise.all([
      profile.GET(req("/api/me/profile"), noParams),
      profile.PATCH(req("/api/me/profile", { method: "PATCH", body: { name: "x" } }), noParams),
      prefs.GET(req("/api/me/preferences"), noParams),
      vehicles.GET(req("/api/me/vehicles"), noParams),
      vehicles.POST(
        req("/api/me/vehicles", {
          method: "POST",
          body: { registration: "MH12AB1234", type: "SEDAN" },
        }),
        noParams,
      ),
      vehicle.DELETE(req(`/api/me/vehicles/${id}`, { method: "DELETE" }), idParams(id)),
      deletionRequest(req("/api/me/deletion-request", { method: "POST" }), noParams),
    ]);
    for (const res of responses) expect(res.status).toBe(401);
  });
});

describe("profile", () => {
  test("GET returns only the caller's public profile fields", async () => {
    const a = await seedSession();
    await seedSession(); // user B exists
    await testDb.account.create({
      data: {
        userId: a.user.id,
        type: "oauth",
        provider: "google",
        providerAccountId: "g-1",
        access_token: "secret-access",
      },
    });
    const res = await profile.GET(req("/api/me/profile", { cookie: a.cookie }), noParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        "deletionRequestedAt",
        "email",
        "hostVerificationStatus",
        "id",
        "image",
        "name",
        "phone",
        "roles",
      ].sort(),
    );
    expect(body.id).toBe(a.user.id);
    expect(JSON.stringify(body)).not.toMatch(/sessionToken|access_token|secret-access|preferences/);
  });

  test("PATCH phone validates India E.164 and resets verification on change", async () => {
    const { user, cookie } = await seedSession();
    await testDb.user.update({
      where: { id: user.id },
      data: { phone: "+919812345678", phoneVerifiedAt: new Date() },
    });
    const patch = (body: unknown) =>
      profile.PATCH(req("/api/me/profile", { method: "PATCH", cookie, body }), noParams);

    expect((await patch({ phone: "+14155550100" })).status).toBe(422);

    // Same phone: verification kept.
    expect((await patch({ phone: "+919812345678", name: "Asha" })).status).toBe(200);
    expect(
      (await testDb.user.findUniqueOrThrow({ where: { id: user.id } })).phoneVerifiedAt,
    ).not.toBeNull();

    const res = await patch({ phone: "+917012345678" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Asha", phone: "+917012345678" });
    expect(
      (await testDb.user.findUniqueOrThrow({ where: { id: user.id } })).phoneVerifiedAt,
    ).toBeNull();
  });

  test("PATCH rejects client-written roles", async () => {
    const { cookie } = await seedSession();
    const res = await profile.PATCH(
      req("/api/me/profile", { method: "PATCH", cookie, body: { roles: ["ADMIN"] } }),
      noParams,
    );
    expect(res.status).toBe(400);
  });
});

describe("preferences", () => {
  test("defaults, partial notification update, default vehicle must be own", async () => {
    const a = await seedSession();
    const b = await seedSession();
    const res = await prefs.GET(req("/api/me/preferences", { cookie: a.cookie }), noParams);
    expect(await res.json()).toEqual({
      defaultVehicleId: null,
      notifications: { email: true, inApp: true, sessionReminders: true, marketing: false },
    });

    const patch = (body: unknown) =>
      prefs.PATCH(
        req("/api/me/preferences", { method: "PATCH", cookie: a.cookie, body }),
        noParams,
      );
    const updated = await patch({ notifications: { sessionReminders: false } });
    expect((await updated.json()).notifications).toEqual({
      email: true,
      inApp: true,
      sessionReminders: false,
      marketing: false,
    });

    const bVehicle = await (
      await addVehicle(b.cookie, { registration: "MH12AB1234", type: "SEDAN" })
    ).json();
    expect((await patch({ defaultVehicleId: bVehicle.id })).status).toBe(404);
  });
});

describe("vehicles", () => {
  test("registration is normalized; standard and BH series accepted; multiple allowed", async () => {
    const { cookie } = await seedSession();
    const one = await addVehicle(cookie, {
      registration: " mh 12 ab-1234 ",
      type: "SEDAN",
      heightCm: 150,
    });
    expect(one.status).toBe(201);
    expect(await one.json()).toMatchObject({
      registration: "MH12AB1234",
      heightCm: 150,
      nickname: null,
    });
    expect(
      (await addVehicle(cookie, { registration: "22 BH 1234 AB", type: "TWO_WHEELER" })).status,
    ).toBe(201);

    const list = await (await vehicles.GET(req("/api/me/vehicles", { cookie }), noParams)).json();
    expect(list.items.map((v: { registration: string }) => v.registration)).toEqual([
      "MH12AB1234",
      "22BH1234AB",
    ]);
  });

  test("bad registration → 422", async () => {
    const { cookie } = await seedSession();
    for (const registration of ["ABCDEFGH", "1234MH12", "MH12ABCD1234"]) {
      const res = await addVehicle(cookie, { registration, type: "SEDAN" });
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("unprocessable");
    }
    const patchRes = await (async () => {
      const v = await (
        await addVehicle(cookie, { registration: "MH12AB1234", type: "SEDAN" })
      ).json();
      return vehicle.PATCH(
        req(`/api/me/vehicles/${v.id}`, {
          method: "PATCH",
          cookie,
          body: { registration: "XXXXXXXX" },
        }),
        idParams(v.id),
      );
    })();
    expect(patchRes.status).toBe(422);
  });

  test("user A can't read, patch, or delete user B's vehicle (404)", async () => {
    const a = await seedSession();
    const b = await seedSession();
    const bv = await (
      await addVehicle(b.cookie, { registration: "KA01MJ2020", type: "SUV" })
    ).json();

    const listA = await (
      await vehicles.GET(req("/api/me/vehicles", { cookie: a.cookie }), noParams)
    ).json();
    expect(listA.items).toEqual([]);

    const patch = await vehicle.PATCH(
      req(`/api/me/vehicles/${bv.id}`, {
        method: "PATCH",
        cookie: a.cookie,
        body: { nickname: "mine" },
      }),
      idParams(bv.id),
    );
    expect(patch.status).toBe(404);
    const del = await vehicle.DELETE(
      req(`/api/me/vehicles/${bv.id}`, { method: "DELETE", cookie: a.cookie }),
      idParams(bv.id),
    );
    expect(del.status).toBe(404);
    expect(await testDb.vehicle.findUniqueOrThrow({ where: { id: bv.id } })).toMatchObject({
      nickname: null,
      deletedAt: null,
    });
  });

  test("owner can patch; duplicate registration → 409", async () => {
    const { cookie } = await seedSession();
    const v = await (
      await addVehicle(cookie, { registration: "MH12AB1234", type: "SEDAN" })
    ).json();
    const res = await vehicle.PATCH(
      req(`/api/me/vehicles/${v.id}`, {
        method: "PATCH",
        cookie,
        body: { nickname: "Blue", widthCm: 180 },
      }),
      idParams(v.id),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      nickname: "Blue",
      widthCm: 180,
      registration: "MH12AB1234",
    });
    expect((await addVehicle(cookie, { registration: "MH12AB1234", type: "SEDAN" })).status).toBe(
      409,
    );
  });

  test("delete: hard when unreferenced, soft when a booking references it; re-add restores", async () => {
    const { user, cookie } = await seedSession();
    const del = (id: string) =>
      vehicle.DELETE(req(`/api/me/vehicles/${id}`, { method: "DELETE", cookie }), idParams(id));

    const free = await (
      await addVehicle(cookie, { registration: "MH12AB1111", type: "SEDAN" })
    ).json();
    const res = await del(free.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await testDb.vehicle.findUnique({ where: { id: free.id } })).toBeNull();

    const used = await (
      await addVehicle(cookie, { registration: "MH12AB2222", type: "SEDAN" })
    ).json();
    await referenceVehicle(user.id, used.id);
    await prefs.PATCH(
      req("/api/me/preferences", { method: "PATCH", cookie, body: { defaultVehicleId: used.id } }),
      noParams,
    );
    expect((await del(used.id)).status).toBe(200);
    expect(
      (await testDb.vehicle.findUniqueOrThrow({ where: { id: used.id } })).deletedAt,
    ).not.toBeNull();
    const list = await (await vehicles.GET(req("/api/me/vehicles", { cookie }), noParams)).json();
    expect(list.items).toEqual([]);
    expect((await del(used.id)).status).toBe(404);
    const p = await (await prefs.GET(req("/api/me/preferences", { cookie }), noParams)).json();
    expect(p.defaultVehicleId).toBeNull();

    const readded = await addVehicle(cookie, { registration: "mh12ab2222", type: "SUV" });
    expect(readded.status).toBe(201);
    expect(await readded.json()).toMatchObject({ id: used.id, type: "SUV" });
  });
});

describe("deletion request", () => {
  test("→ 202, sets deletionRequestedAt, writes an audit row; repeat keeps first timestamp", async () => {
    const { user, cookie } = await seedSession();
    const send = (body?: unknown) =>
      deletionRequest(req("/api/me/deletion-request", { method: "POST", cookie, body }), noParams);

    const res = await send({ reason: "moving abroad" });
    expect(res.status).toBe(202);
    const { deletionRequestedAt } = await res.json();
    expect(new Date(deletionRequestedAt).toISOString()).toBe(deletionRequestedAt);

    const audits = await testDb.auditLog.findMany({ where: { action: "user.deletion_requested" } });
    expect(audits).toMatchObject([
      { actorId: user.id, targetType: "User", targetId: user.id, reason: "moving abroad" },
    ]);

    const again = await send();
    expect(again.status).toBe(202);
    expect((await again.json()).deletionRequestedAt).toBe(deletionRequestedAt);
    const me = await (await profile.GET(req("/api/me/profile", { cookie }), noParams)).json();
    expect(me.deletionRequestedAt).toBe(deletionRequestedAt);
  });
});

async function referenceVehicle(userId: string, vehicleId: string) {
  const listing = await testDb.listing.create({
    data: {
      hostId: userId,
      title: "Test bay",
      description: "d",
      address: "a",
      locality: "Baner",
      lat: 18.559,
      lng: 73.7868,
      approxLat: 18.56,
      approxLng: 73.79,
      spaceType: "OPEN",
    },
  });
  const t = new Date("2030-01-01T00:00:00Z");
  await testDb.monthlyAgreement.create({
    data: {
      renterId: userId,
      listingId: listing.id,
      vehicleId,
      monthlyPaise: 300000,
      startAt: t,
      currentTermStartAt: t,
      currentTermEndAt: new Date("2030-02-01T00:00:00Z"),
    },
  });
}
