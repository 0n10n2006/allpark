import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import * as contracts from "@/contracts";
import { BookingSummary, ListingCard, PublicListing } from "@/contracts";
import { type Endpoint, endpoints } from "@/contracts/registry";
import { req, seedSession } from "../http/helpers";
import { testDb, truncateAll } from "../setup/db";
import { examples } from "./examples";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const key = (e: Endpoint) => `${e.method} ${e.path}`;
const routeFile = (e: Endpoint) => path.join("src/app", e.path.replace(/:id/g, "[id]"), "route.ts");

// An endpoint is still a stub while its method is wired to notImplemented. Implementing
// tasks replace that, and the 501 assertions below drop it automatically.
const isStub = (e: Endpoint) =>
  new RegExp(String.raw`export const ${e.method}\s*=\s*route\([^;]*notImplemented\s*,?\s*\)`).test(
    readFileSync(routeFile(e), "utf8"),
  );
const stubs = endpoints.filter(isStub);

const loadRoute = (e: Endpoint) =>
  import(/* @vite-ignore */ `@/app${e.path.replace(/:id/g, "[id]")}/route`);

describe("registry", () => {
  test("entries are unique and every one has a route file exporting its method", async () => {
    expect(new Set(endpoints.map(key)).size).toBe(endpoints.length);
    for (const e of endpoints) {
      expect(existsSync(routeFile(e)), routeFile(e)).toBe(true);
      const mod = await loadRoute(e);
      expect(typeof mod[e.method], key(e)).toBe("function");
    }
  }, 20_000);

  test("every registry schema is exported from @/contracts under exactly one name", () => {
    for (const e of endpoints)
      for (const schema of [e.params, e.query, e.body, e.response].filter(Boolean)) {
        const names = Object.entries(contracts).filter(([, v]) => v === schema);
        expect(names.length, key(e)).toBe(1);
      }
  });

  test("covers every PRD §7 endpoint", () => {
    const prd = [
      "GET /api/listings",
      "GET /api/listings/:id",
      "POST /api/listings",
      "PATCH /api/listings/:id",
      "POST /api/listings/:id/availability",
      "POST /api/quotes",
      "POST /api/bookings/hold",
      "POST /api/bookings",
      "GET /api/bookings/:id",
      "POST /api/bookings/:id/cancel",
      "POST /api/bookings/:id/extend",
      "POST /api/bookings/:id/check-in",
      "POST /api/bookings/:id/check-out",
      "POST /api/monthly/:id/renew",
      "POST /api/payments/order",
      "POST /api/webhooks/razorpay",
      "POST /api/disputes",
      "GET /api/host/earnings",
      "GET /api/admin/disputes",
    ];
    const keys = endpoints.map(key);
    for (const k of prd) expect(keys).toContain(k);
  });

  test("admin paths use admin auth; only search, listing detail, availability, and the webhook are public", () => {
    for (const e of endpoints)
      if (e.path.startsWith("/api/admin/")) expect(e.auth, key(e)).toBe("admin");
    expect(
      endpoints
        .filter((e) => e.auth === "public")
        .map(key)
        .sort(),
    ).toEqual([
      "GET /api/listings",
      "GET /api/listings/:id",
      "GET /api/listings/:id/availability",
      "GET /api/listings/:id/reviews",
      "POST /api/webhooks/razorpay",
    ]);
  });
});

describe("schemas", () => {
  test.each(endpoints.map((e) => [key(e), e] as const))("%s parses its minimal example", (k, e) => {
    const ex = examples[k];
    expect(ex, `missing example for ${k}`).toBeDefined();
    for (const part of ["params", "query", "body"] as const) {
      if (!e[part]) continue;
      const r = e[part].safeParse(ex[part]);
      expect(r.error?.issues, `${k} ${part}`).toBeUndefined();
    }
    const r = e.response.safeParse(ex.response);
    expect(r.error?.issues, `${k} response`).toBeUndefined();
  });

  test("public shapes reject private fields", () => {
    const priv = {
      address: "12 FC Road",
      lat: 18.5314,
      lng: 73.8446,
      accessInstructions: "Gate 1234",
    };
    const pub = examples["GET /api/listings/:id"].response as object;
    const card = (examples["GET /api/listings"].response as { items: object[] }).items[0];
    const row = (examples["GET /api/bookings"].response as { items: object[] }).items[0];
    for (const [schema, ok] of [
      [PublicListing, pub],
      [ListingCard, card],
      [BookingSummary, row],
    ] as const) {
      expect(schema.safeParse(ok).success).toBe(true);
      for (const [k, v] of Object.entries(priv))
        expect(schema.safeParse({ ...ok, [k]: v }).success, k).toBe(false);
      expect(schema.safeParse({ ...ok, access: null }).success).toBe(false);
    }
    // Nested public objects are strict too: host contact details never leak pre-booking.
    const p = pub as { host: object; photos: object[] };
    const leakyHost = { ...p, host: { ...p.host, phone: "+919812345678" } };
    expect(PublicListing.safeParse(leakyHost).success).toBe(false);
    const leakyPhoto = { ...p, photos: [{ ...p.photos[0], publicId: "listings/x" }] };
    expect(PublicListing.safeParse(leakyPhoto).success).toBe(false);
  });

  /** Every object key reachable from a schema, through wrappers, arrays, and pipes. */
  function keysOf(s: unknown): string[] {
    if (s instanceof z.ZodObject)
      return Object.entries(s.shape).flatMap(([k, v]) => [k, ...keysOf(v)]);
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable || s instanceof z.ZodDefault)
      return keysOf(s.unwrap());
    if (s instanceof z.ZodArray) return keysOf(s.element);
    if (s instanceof z.ZodPipe) return [...keysOf(s.in), ...keysOf(s.out)];
    return [];
  }

  test("quote, booking, and payment requests carry no amount, hostId, or status", () => {
    const banned = /amount|paise|price|total|commission|fee|hostid|status/i;
    const money = endpoints.filter((e) =>
      /^\/api\/(quotes|bookings|payments|monthly)/.test(e.path),
    );
    expect(money.length).toBeGreaterThan(5);
    for (const e of money)
      for (const part of [e.params, e.query, e.body]) {
        expect(
          keysOf(part).filter((k) => banned.test(k)),
          key(e),
        ).toEqual([]);
      }
    // The walker does see nested keys (guards against it silently returning []).
    expect(
      keysOf(z.object({ a: z.array(z.object({ totalPaise: z.number() })).optional() })),
    ).toContain("totalPaise");
  });

  test("request bodies reject unknown keys, so a client cannot smuggle in amounts", () => {
    for (const e of endpoints.filter((e) => e.body && e.path !== "/api/webhooks/razorpay")) {
      const body = examples[key(e)].body as object;
      expect(e.body!.safeParse({ ...body, totalPaise: 1 }).success, key(e)).toBe(false);
    }
  });

  test("every mutating admin request requires a reason", () => {
    const mutations = endpoints.filter((e) => e.auth === "admin" && e.method !== "GET");
    expect(mutations.length).toBeGreaterThan(0);
    for (const e of mutations) {
      const { reason: _reason, ...rest } = examples[key(e)].body as { reason: string };
      void _reason;
      expect(e.body!.safeParse(rest).success, key(e)).toBe(false);
      expect(e.body!.safeParse({ ...rest, reason: "  " }).success, key(e)).toBe(false);
    }
  });
});

describe("route stubs", () => {
  let renter: string;
  let everyone: string;

  beforeAll(async () => {
    await truncateAll();
    renter = (await seedSession(["RENTER", "HOST"])).cookie;
    everyone = (await seedSession(["RENTER", "HOST", "ADMIN"])).cookie;
  });
  afterAll(() => testDb.$disconnect());

  async function call(e: Endpoint, cookie?: string) {
    const ex = examples[key(e)];
    const id = (ex.params as { id?: string } | undefined)?.id;
    const qs = ex.query ? `?${new URLSearchParams(ex.query as Record<string, string>)}` : "";
    const mod = await loadRoute(e);
    const url = e.path.replace(":id", id ?? "") + qs;
    return mod[e.method](req(url, { method: e.method, cookie, body: ex.body }), {
      params: Promise.resolve(ex.params ?? {}),
    }) as Promise<Response>;
  }

  test.each(endpoints.filter((e) => e.auth !== "public").map((e) => [key(e), e] as const))(
    "%s: unauthenticated → 401",
    async (_k, e) => {
      const res = await call(e);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("unauthorized");
    },
  );

  test.each(endpoints.filter((e) => e.auth === "admin").map((e) => [key(e), e] as const))(
    "%s: non-admin → 403",
    async (_k, e) => {
      expect((await call(e, renter)).status).toBe(403);
    },
  );

  test.each(stubs.map((e) => [key(e), e] as const))(
    "%s: valid authorized request → 501 not_implemented",
    async (_k, e) => {
      const res = await call(e, everyone);
      expect(res.status).toBe(501);
      expect((await res.json()).error.code).toBe("not_implemented");
    },
  );

  test.each(
    stubs
      .filter((e) => e.body && JSON.stringify(examples[key(e)].body) === "{}")
      .map((e) => [key(e), e] as const),
  )("%s: POST with no body → 501 (body defaults to {})", async (_k, e) => {
    const id = (examples[key(e)].params as { id: string } | undefined)?.id ?? "";
    const mod = await loadRoute(e);
    const res: Response = await mod[e.method](
      req(e.path.replace(":id", id), { method: e.method, cookie: everyone }),
      { params: Promise.resolve(examples[key(e)].params ?? {}) },
    );
    expect(res.status).toBe(501);
  });

  test("invalid body on an authenticated stub → 400, not 501", async () => {
    const hold = endpoints.find((e) => key(e) === "POST /api/bookings/hold")!;
    const { POST } = await import("@/app/api/bookings/hold/route");
    const res = await POST(
      req(hold.path, { method: "POST", cookie: everyone, body: { quoteId: "x", totalPaise: 1 } }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(400);
  });
});
