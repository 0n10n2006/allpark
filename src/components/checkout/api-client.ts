import { ErrorEnvelope } from "@/contracts";
import { ApiError } from "@/lib/api-client";

// ponytail: src/lib/api-client's api() takes no headers, and the hold needs Idempotency-Key.
// Fold a `headers` option into that api() when its owner can, then delete this file.

/** POST JSON with extra headers; throws the shared ApiError on failure. */
export async function postWithHeaders<T>(
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const env = ErrorEnvelope.safeParse(data);
    const error = env.success ? env.data.error : { code: "internal_error" as const };
    throw new ApiError(res.status, error.code, error.message ?? "Request failed", error.details);
  }
  return data as T;
}

/** `details.reason` from booking/hold errors, e.g. "slot_unavailable". */
export function reasonOf(e: unknown): string | undefined {
  const r = e instanceof ApiError ? (e.details as { reason?: unknown } | undefined)?.reason : null;
  return typeof r === "string" ? r : undefined;
}
