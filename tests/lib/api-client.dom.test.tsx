import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, fieldErrors, newIdempotencyKey } from "@/lib/api-client";

describe("api-client", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes custom headers and combines with content-type for request bodies", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    globalThis.fetch = fetchMock;

    const res = await api<{ success: boolean }>("/api/test", {
      method: "POST",
      body: { name: "test" },
      headers: { "idempotency-key": "test-uuid-1234" },
    });

    expect(res).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/test");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "idempotency-key": "test-uuid-1234",
    });
    expect(init.body).toBe(JSON.stringify({ name: "test" }));
  });

  it("passes custom headers without request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    globalThis.fetch = fetchMock;

    await api("/api/items", {
      headers: { "x-custom-header": "custom-val" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toEqual({
      "x-custom-header": "custom-val",
    });
  });

  it("parses error envelopes into ApiError with status, code, message, and details", async () => {
    const errorPayload = {
      error: {
        code: "validation_error",
        message: "Invalid fields provided",
        details: [
          { path: ["email"], message: "Invalid email address" },
          { path: ["title"], message: "Title too short" },
        ],
      },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => errorPayload,
    });

    try {
      await api("/api/invalid");
      expect.unreachable("should have thrown ApiError");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(400);
      expect(err.code).toBe("validation_error");
      expect(err.message).toBe("Invalid fields provided");
      expect(err.details).toEqual(errorPayload.error.details);
      expect(err.issues).toEqual(errorPayload.error.details);
      expect(fieldErrors(err)).toEqual([
        { field: "email", message: "Invalid email address" },
        { field: "title", message: "Title too short" },
      ]);
    }
  });

  it("preserves custom server error codes like uploads_not_configured", async () => {
    const errorPayload = {
      error: {
        code: "uploads_not_configured",
        message: "Photo uploads are not configured",
      },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => errorPayload,
    });

    try {
      await api("/api/upload");
      expect.unreachable("should have thrown ApiError");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(503);
      expect(err.code).toBe("uploads_not_configured");
      expect(err.message).toBe("Photo uploads are not configured");
    }
  });

  it("handles non-JSON error bodies gracefully with default internal_error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("Unexpected token < in JSON at position 0");
      },
    });

    try {
      await api("/api/bad-gateway");
      expect.unreachable("should have thrown ApiError");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(502);
      expect(err.code).toBe("internal_error");
      expect(err.message).toBe("Request failed");
      expect(err.details).toBeUndefined();
      expect(err.issues).toEqual([]);
      expect(fieldErrors(err)).toEqual([]);
    }
  });

  it("generates random UUID idempotency keys", () => {
    const key1 = newIdempotencyKey();
    const key2 = newIdempotencyKey();
    expect(typeof key1).toBe("string");
    expect(key1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(key1).not.toBe(key2);
  });
});
