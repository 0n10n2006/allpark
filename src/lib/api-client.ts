import { ErrorEnvelope, type ErrorCode } from "@/contracts";

export type Issue = { path: (string | number)[]; message: string };

/** A non-2xx API response, parsed from the `{ error: { code, message, details } }` envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | (string & {}),
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get issues(): Issue[] {
    if (!Array.isArray(this.details)) return [];
    return this.details.filter(
      (d): d is Issue => Array.isArray(d?.path) && typeof d?.message === "string",
    );
  }
}

export type ApiOptions = {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
};

/** Same-origin JSON fetch for client components. Throws ApiError on failure. */
export async function api<T>(path: string, options?: ApiOptions): Promise<T>;
export async function api<T>(path: string, method?: string, body?: unknown): Promise<T>;
export async function api<T>(
  path: string,
  optionsOrMethod?: ApiOptions | string,
  bodyArg?: unknown,
): Promise<T> {
  let method = "GET";
  let body: unknown = undefined;
  let headers: HeadersInit | undefined = undefined;

  if (typeof optionsOrMethod === "string") {
    method = optionsOrMethod;
    body = bodyArg;
  } else if (optionsOrMethod) {
    if (optionsOrMethod.method !== undefined) method = optionsOrMethod.method;
    body = optionsOrMethod.body;
    headers = optionsOrMethod.headers;
  }

  const requestHeaders: Record<string, string> = {
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  };

  if (headers) {
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        requestHeaders[key] = value;
      });
    } else if (Array.isArray(headers)) {
      for (const [key, value] of headers) {
        requestHeaders[key] = value;
      }
    } else {
      Object.assign(requestHeaders, headers);
    }
  }

  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined && !headers ? undefined : requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const env = ErrorEnvelope.safeParse(data);
    const errObj = (data as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    const code = env.success
      ? env.data.error.code
      : typeof errObj?.code === "string"
        ? (errObj.code as ErrorCode)
        : ("internal_error" as const);
    const message = (env.success ? env.data.error.message : errObj?.message) ?? "Request failed";
    const details = env.success ? env.data.error.details : errObj?.details;
    throw new ApiError(res.status, code, message, details);
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

/** Generates a fresh Idempotency-Key UUID. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** User-facing error message fallback. */
export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong.";
