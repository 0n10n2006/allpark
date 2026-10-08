import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { SearchListingsQuery } from "@/contracts";
import { Prisma } from "@/generated/prisma/client";
import { seedSearchPerf } from "../../scripts/seed-search-perf";
import { testDb, truncateAll } from "../setup/db";

// PRD §9: p95 < 1 s for indexed search over 5,000 listings. Slow, so opt-in: PERF=1 npx vitest run tests/search/perf

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));
const { searchListings } = await import("@/server/search/service");

const DAY = 86_400_000;
/** Deterministic pseudo-random in [0, 1), so every run issues the same 50 searches. */
const rand = (i: number, salt: number) =>
  (((Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453) % 1) + 1) % 1;

function representative(i: number): Record<string, string | number> {
  const lat = 18.45 + rand(i, 1) * 0.2;
  const lng = 73.75 + rand(i, 2) * 0.25;
  const start = new Date(
    Math.ceil(Date.now() / 3_600_000) * 3_600_000 +
      Math.floor(rand(i, 3) * 6) * DAY +
      9 * 3_600_000,
  );
  const q: Record<string, string | number> = { limit: 20 };
  if (i % 2 === 0) Object.assign(q, { lat, lng, radiusMeters: 1000 + (i % 5) * 1000 });
  else
    Object.assign(q, {
      minLat: lat - 0.02,
      maxLat: lat + 0.02,
      minLng: lng - 0.025,
      maxLng: lng + 0.025,
    });
  if (i % 3 !== 0)
    Object.assign(q, {
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + 3 * 3_600_000).toISOString(),
      rentalType: "HOURLY",
    });
  if (i % 7 === 0)
    Object.assign(q, { rentalType: "MONTHLY", startAt: start.toISOString() }, { endAt: undefined });
  if (i % 4 === 1) q.covered = "true";
  if (i % 5 === 2) q.minHeightCm = 190;
  if (i % 6 === 3) q.sort = "price";
  if (i % 8 === 5) q.vehicleType = "SUV";
  for (const k of Object.keys(q)) if (q[k] === undefined) delete q[k];
  return q;
}

describe.skipIf(!process.env.PERF)("search performance (PERF=1)", () => {
  beforeAll(async () => {
    await truncateAll();
    await seedSearchPerf(testDb, 5_000);
  }, 120_000);
  afterAll(() => testDb.$disconnect());

  test("p95 of 50 representative searches is under 1000 ms", async () => {
    await searchListings(SearchListingsQuery.parse(representative(1))); // warm-up
    const times: number[] = [];
    let found = 0;
    for (let i = 0; i < 50; i++) {
      const q = SearchListingsQuery.parse(representative(i));
      const t = performance.now();
      const res = await searchListings(q);
      times.push(performance.now() - t);
      found += res.items.length;
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(0.95 * times.length) - 1];
    console.log(
      `search p50=${times[24].toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${times.at(-1)!.toFixed(1)}ms results=${found}`,
    );
    expect(found).toBeGreaterThan(0); // fast because it found nothing doesn't count
    expect(p95).toBeLessThan(1000);
  }, 120_000);

  test("EXPLAIN ANALYZE of a bbox + time search", async () => {
    const spy = vi.spyOn(testDb, "$queryRaw");
    await searchListings(SearchListingsQuery.parse(representative(1)));
    const sql = spy.mock.calls.find(([s]) =>
      String((s as Prisma.Sql).sql).includes('FROM "Listing" l'),
    )![0] as Prisma.Sql;
    spy.mockRestore();
    const plan = await testDb.$queryRaw<{ "QUERY PLAN": string }[]>(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
    );
    console.log(plan.map((r) => r["QUERY PLAN"]).join("\n"));
  });
});
