import { testDb, truncateAll } from "../setup/db";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { noParams, req, seedSession } from "./helpers";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { GET: me } = await import("@/app/api/me/route");
const { GET: adminPing } = await import("@/app/api/admin/ping/route");
const { POST: echo } = await import("@/app/api/dev/echo/route");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

const post = (cookie: string | undefined, body: unknown, key = "k1", origin?: string) =>
  echo(
    req("/api/dev/echo", {
      method: "POST",
      cookie,
      body,
      origin,
      headers: { "idempotency-key": key },
    }),
    noParams,
  );

describe("auth on routes", () => {
  test("unauthenticated mutation → 401 envelope", async () => {
    const res = await post(undefined, { message: "hi" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "Sign in required" },
    });
  });

  test("GET /api/me returns the profile without secrets", async () => {
    const { user, cookie } = await seedSession();
    const res = await me(req("/api/me", { cookie }), noParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: user.id, roles: ["RENTER"] });
    expect(JSON.stringify(body)).not.toMatch(/sessionToken|access_token/);
  });

  test("admin ping: non-admin → 403, admin → 200", async () => {
    const renter = await seedSession(["RENTER", "HOST"]);
    const denied = await adminPing(req("/api/admin/ping", { cookie: renter.cookie }), noParams);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("forbidden");

    const admin = await seedSession(["ADMIN"]);
    const ok = await adminPing(req("/api/admin/ping", { cookie: admin.cookie }), noParams);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });
});

describe("POST /api/dev/echo", () => {
  test("cross-origin POST is rejected before anything runs", async () => {
    const { cookie } = await seedSession();
    const res = await post(cookie, { message: "hi" }, "k1", "https://evil.example");
    expect(res.status).toBe(403);
    expect(await testDb.auditLog.count()).toBe(0);
  });

  test("invalid body → 400 validation envelope with details", async () => {
    const { cookie } = await seedSession();
    const res = await post(cookie, { message: 42 });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe("validation_error");
    expect(error.details).toBeInstanceOf(Array);
  });

  test("idempotent replay returns the identical response and runs the side effect once", async () => {
    const { cookie } = await seedSession();
    const first = await post(cookie, { message: "hi" });
    const second = await post(cookie, { message: "hi" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await testDb.auditLog.count({ where: { action: "dev.echo" } })).toBe(1);
  });

  test("same key with a different body → 422", async () => {
    const { cookie } = await seedSession();
    expect((await post(cookie, { message: "hi" })).status).toBe(201);
    const res = await post(cookie, { message: "different" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("unprocessable");
  });

  test("missing Idempotency-Key → 400", async () => {
    const { cookie } = await seedSession();
    const res = await echo(
      req("/api/dev/echo", { method: "POST", cookie, body: { message: "hi" } }),
      noParams,
    );
    expect(res.status).toBe(400);
  });

  test("rate limit: 429 after 5 calls in the window", async () => {
    const { cookie } = await seedSession();
    for (let i = 0; i < 5; i++)
      expect((await post(cookie, { message: "hi" }, `k${i}`)).status).toBe(201);
    const res = await post(cookie, { message: "hi" }, "k-over");
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("rate_limited");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("L3: rate-limit identity and write limits", () => {
  test("clientIp prefers x-real-ip and never trusts the client-supplied first forwarded hop", async () => {
    const { clientIp } = await import("@/server/http/rate-limit");
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
    expect(
      clientIp(new Headers({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "198.51.100.1" })),
    ).toBe("198.51.100.1");
  });

  test("POST /api/me/vehicles is limited per user", async () => {
    const { POST: addVehicle } = await import("@/app/api/me/vehicles/route");
    const { cookie } = await seedSession();
    const add = (i: number) =>
      addVehicle(
        req("/api/me/vehicles", {
          method: "POST",
          cookie,
          body: { registration: `MH12AB${String(1000 + i)}`, type: "SEDAN" },
        }),
        noParams,
      );
    for (let i = 0; i < 30; i++) expect((await add(i)).status).toBe(201);
    expect((await add(30)).status).toBe(429);
  });
});
