import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { errorCode, HttpError } from "./errors";

/**
 * Runs `handler` at most once per (user, path, Idempotency-Key). A repeat with
 * the same request replays the stored response; the same key with a different
 * request is 422; a repeat while the first is still running is 409.
 * The handler must return a JSON Response.
 * ponytail: a crash between the handler and the store leaves the key "in flight"
 * forever (409); add a staleness cutoff if that shows up in practice.
 */
export async function withIdempotency(
  req: Request,
  userId: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  const key = req.headers.get("idempotency-key");
  if (!key || key.length > 255)
    throw new HttpError("validation_error", "Idempotency-Key header is required");

  const route = new URL(req.url).pathname;
  const body = await req.clone().text();
  const requestHash = createHash("sha256").update(`${req.method}\n${route}\n${body}`).digest("hex");

  let rowId: string;
  try {
    ({ id: rowId } = await db.idempotencyKey.create({
      data: { key, userId, route, requestHash },
      select: { id: true },
    }));
  } catch (e) {
    if (errorCode(e) !== "P2002") throw e;
    const prior = await db.idempotencyKey.findUniqueOrThrow({
      where: { userId_route_key: { userId, route, key } },
    });
    if (prior.requestHash !== requestHash)
      throw new HttpError("unprocessable", "Idempotency-Key was reused with a different request");
    if (prior.responseStatus === null)
      throw new HttpError("conflict", "A request with this Idempotency-Key is in progress");
    return Response.json(prior.responseJson, {
      status: prior.responseStatus,
      headers: { "Idempotent-Replayed": "true" },
    });
  }

  let res: Response;
  try {
    res = await handler();
  } catch (e) {
    await db.idempotencyKey.delete({ where: { id: rowId } });
    throw e;
  }
  await db.idempotencyKey.update({
    where: { id: rowId },
    data: {
      responseStatus: res.status,
      responseJson: (await res.clone().json()) as Prisma.InputJsonValue,
    },
  });
  return res;
}
