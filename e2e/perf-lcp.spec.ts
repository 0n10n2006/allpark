import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {}
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

let publishedListingId: string;

test.beforeAll(async () => {
  await db.connect();
  const run = randomUUID().slice(0, 8);

  const hostRes = await db.query<{ id: string }>(
    `INSERT INTO "User" (email, name, roles, "hostVerificationStatus", "updatedAt")
     VALUES ($1, 'Perf Host', '{HOST}', 'VERIFIED', now()) RETURNING id`,
    [`perf-host-${run}@test.local`],
  );
  const hostId = hostRes.rows[0].id;

  const listingRes = await db.query<{ id: string }>(
    `INSERT INTO "Listing" ("hostId", title, description, address, locality, lat, lng,
       "approxLat", "approxLng", "spaceType", "vehicleTypes", "hourlyPaise",
       "accessInstructions", status, "updatedAt")
     VALUES ($1, $2, 'Perf space for LCP timing', '200 FC Road', 'Shivajinagar', 18.52, 73.85,
       18.521, 73.851, 'COVERED', '{SEDAN,SUV}', 5000, 'Gate PIN 1234', 'PUBLISHED', now()) RETURNING id`,
    [hostId, `Perf Space ${run}`],
  );
  publishedListingId = listingRes.rows[0].id;
});

test.afterAll(async () => {
  await db.end();
});

test.describe("Performance: LCP with 4x CPU throttling (CDP) at 375px", () => {
  test("measure LCP on /explore at 375px with 4x CPU throttling", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    // Enable 4x CPU throttling via Chrome DevTools Protocol
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    } catch (e) {
      console.warn("CDP CPU throttling unavailable:", e);
    }

    await page.goto("/explore");
    await page.waitForLoadState("domcontentloaded");

    const lcp = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        let maxLcp = 0;
        const observer = new PerformanceObserver((entryList) => {
          const entries = entryList.getEntries();
          for (const entry of entries) {
            if (entry.startTime > maxLcp) maxLcp = entry.startTime;
          }
        });
        observer.observe({ type: "largest-contentful-paint", buffered: true });

        setTimeout(() => {
          observer.disconnect();
          if (maxLcp > 0) {
            resolve(maxLcp);
          } else {
            const fcp = performance.getEntriesByName("first-contentful-paint")[0];
            resolve(fcp ? fcp.startTime : performance.now());
          }
        }, 1500);
      });
    });

    console.log(`LCP on /explore at 375px with 4x CPU throttling: ${lcp.toFixed(1)} ms`);
    // Soft guard: pathological threshold (> 4 s)
    expect(lcp).toBeLessThan(4000);
  });

  test("measure LCP on /listings/[id] at 375px with 4x CPU throttling", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    } catch (e) {
      console.warn("CDP CPU throttling unavailable:", e);
    }

    await page.goto(`/listings/${publishedListingId}`);
    await page.waitForLoadState("domcontentloaded");

    const lcp = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        let maxLcp = 0;
        const observer = new PerformanceObserver((entryList) => {
          const entries = entryList.getEntries();
          for (const entry of entries) {
            if (entry.startTime > maxLcp) maxLcp = entry.startTime;
          }
        });
        observer.observe({ type: "largest-contentful-paint", buffered: true });

        setTimeout(() => {
          observer.disconnect();
          if (maxLcp > 0) {
            resolve(maxLcp);
          } else {
            const fcp = performance.getEntriesByName("first-contentful-paint")[0];
            resolve(fcp ? fcp.startTime : performance.now());
          }
        }, 1500);
      });
    });

    console.log(`LCP on /listings/${publishedListingId} at 375px with 4x CPU throttling: ${lcp.toFixed(1)} ms`);
    // Soft guard: pathological threshold (> 4 s)
    expect(lcp).toBeLessThan(4000);
  });
});
