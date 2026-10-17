import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import { testDb, truncateAll } from "../setup/db";
import { req } from "../http/helpers";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { POST: devSignIn } = await import("@/app/api/dev/sign-in/route");
const { POST: devUploads } = await import("@/app/api/dev/uploads/route");

beforeEach(async () => {
  await truncateAll();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await testDb.$disconnect();
});

describe("demo routes access control", () => {
  it("POST /api/dev/sign-in returns 404 when DEMO_MODE is off", async () => {
    vi.stubEnv("DEMO_MODE", "0");
    vi.stubEnv("NODE_ENV", "development");

    const res = await devSignIn(
      req("/api/dev/sign-in", {
        method: "POST",
        body: { email: "riya@parkshare.local" },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/dev/uploads returns 404 when DEMO_MODE is off", async () => {
    vi.stubEnv("DEMO_MODE", "0");
    vi.stubEnv("NODE_ENV", "development");

    const form = new FormData();
    form.set("file", new Blob(["fake"], { type: "text/plain" }));

    const res = await devUploads(
      new Request("http://localhost/api/dev/uploads", {
        method: "POST",
        body: form,
      }),
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/dev/uploads rejects non-image with 400 when DEMO_MODE=1", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    vi.stubEnv("NODE_ENV", "test");

    const form = new FormData();
    form.set("file", new Blob(["this is a plain text file pretending to be image"], { type: "image/jpeg" }));

    const res = await devUploads(
      new Request("http://localhost/api/dev/uploads", {
        method: "POST",
        body: form,
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/Invalid image format/);
  });

  it("POST /api/dev/uploads accepts valid PNG image when DEMO_MODE=1", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    vi.stubEnv("NODE_ENV", "test");

    // Valid minimal PNG buffer (header + IHDR)
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const form = new FormData();
    form.set("file", new Blob([pngBytes], { type: "image/png" }), "test.png");
    form.set("public_id", "listings/test-listing/pic1.png");

    const res = await devUploads(
      new Request("http://localhost/api/dev/uploads", {
        method: "POST",
        body: form,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.public_id).toBe("listings/test-listing/pic1.png");
    expect(body.format).toBe("png");
  });
});
