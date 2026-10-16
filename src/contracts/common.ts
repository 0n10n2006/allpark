import { z } from "zod";
import type { ErrorCode as ServerErrorCode } from "../server/http/errors";

// Shared building blocks. Contracts are imported by client components too, so this
// folder must never import server code at runtime (type-only imports are fine).

export const Uuid = z.uuid();
/** ISO 8601 instant in UTC, e.g. "2026-10-16T04:30:00Z". Display converts to Asia/Kolkata. */
export const IsoDateTime = z.iso.datetime();
/** Integer paise (₹1 = 100 paise), never negative. */
export const Paise = z.number().int().min(0);
export const Currency = z.literal("INR");
export const Money = z.object({ paise: Paise, currency: Currency });
export type Money = z.infer<typeof Money>;

/** Route params for every `[id]` segment. */
export const IdParams = z.object({ id: Uuid });
export type IdParams = z.infer<typeof IdParams>;

/** Query strings arrive as strings; every field has a default or is optional. */
export const PaginationQuery = z.object({
  /** The last item's id (L9: anything else is a 400 here, not a 500 from the database). */
  cursor: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

/** `{ items, nextCursor }`; nextCursor is null on the last page. */
export function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

/** Required on every mutating admin request (FR-10, FR-13); written to AuditLog. */
export const AdminReason = z.string().trim().min(3).max(1000);

/** Response of admin mutations. */
export const AdminActionResponse = z.object({ ok: z.literal(true), auditLogId: Uuid });
export type AdminActionResponse = z.infer<typeof AdminActionResponse>;

// Matches src/server/http/errors.ts, plus not_implemented for route stubs.
export const ErrorCode = z.enum([
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "unprocessable",
  "rate_limited",
  "internal_error",
  "not_implemented",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;
// Compile-time guard: fails typecheck if the server adds a code this enum lacks.
const _serverCodesCovered: ServerErrorCode extends ErrorCode ? true : never = true;
void _serverCodesCovered;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
