import { ErrorEnvelope, type ErrorCode } from "@/contracts";

// ponytail: local copy of T3.4's src/lib/api-client.ts (not on main yet) plus a `headers`
// option for Idempotency-Key; swap the import once that file merges.

/** A non-2xx API response, parsed from the `{ error: { code, message, details } }` envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** `details.reason` from booking/hold errors, e.g. "slot_unavailable". */
  get reason(): string | undefined {
    const r = (this.details as { reason?: unknown } | undefined)?.reason;
    return typeof r === "string" ? r : undefined;
  }
}

/** Same-origin JSON fetch for client components. Throws ApiError on failure. */
export async function api<T>(
  path: string,
  {
    method = "GET",
    body,
    headers,
  }: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const env = ErrorEnvelope.safeParse(data);
    const error = env.success ? env.data.error : { code: "internal_error" as const };
    throw new ApiError(res.status, error.code, error.message ?? "Request failed", error.details);
  }
  return data as T;
}
