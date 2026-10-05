import { ZodError } from "zod";

export type ErrorCode =
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unprocessable"
  | "rate_limited"
  | "internal_error";

const STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  rate_limited: 429,
  internal_error: 500,
};

export class HttpError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: HeadersInit,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = STATUS[code];
  }
}

export function errorResponse(e: HttpError): Response {
  const error = { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) };
  return Response.json({ error }, { status: e.status, headers: e.headers });
}

type Unknownish = {
  code?: unknown;
  meta?: { driverAdapterError?: { cause?: { code?: unknown } } };
};

/** Postgres SQLSTATE or Prisma error code, whichever the error carries. */
export function errorCode(e: unknown): string | undefined {
  const err = e as Unknownish | null;
  const code = err?.meta?.driverAdapterError?.cause?.code ?? err?.code;
  return typeof code === "string" ? code : undefined;
}

/** Maps anything thrown to an HttpError; unknown errors become an opaque 500. */
export function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof ZodError) return new HttpError("validation_error", "Invalid request", e.issues);
  switch (errorCode(e)) {
    case "P2002":
    case "23505":
      return new HttpError("conflict", "Resource already exists");
    case "23P01":
      return new HttpError("conflict", "conflict");
    case "P2025":
      return new HttpError("not_found", "Not found");
  }
  return new HttpError("internal_error", "Internal server error");
}
