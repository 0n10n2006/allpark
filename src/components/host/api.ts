// ponytail: local fetch helper; swap for src/lib/api-client.ts once T3.4 lands it.

export type Issue = { path: (string | number)[]; message: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: Issue[] = [],
  ) {
    super(message);
  }
}

/** JSON fetch against our API; non-2xx throws ApiError with the envelope's code and issues. */
export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "Can't reach ParkShare. Check your connection and retry.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    const issues = Array.isArray(e?.details) ? (e.details as Issue[]) : [];
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? "Request failed", issues);
  }
  return data as T;
}

export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong.";
