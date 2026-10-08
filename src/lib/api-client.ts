import { ErrorEnvelope, type ErrorCode } from "@/contracts";

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
}

/** Same-origin JSON fetch for client components. Throws ApiError on failure. */
export async function api<T>(
  path: string,
  { method = "GET", body }: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
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

/** Field-level messages from an ApiError's `details: [{ path, message }]`. */
export function fieldErrors(e: ApiError): { field: string; message: string }[] {
  if (!Array.isArray(e.details)) return [];
  return e.details.flatMap((d: { path?: unknown[]; message?: unknown }) =>
    typeof d?.path?.[0] === "string" && typeof d.message === "string"
      ? [{ field: d.path[0], message: d.message }]
      : [],
  );
}
