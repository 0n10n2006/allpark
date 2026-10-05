import { z } from "zod";
import { type CurrentUser, getCurrentUser } from "@/server/auth/guards";
import { errorCode, errorResponse, HttpError, toHttpError } from "./errors";
import { rateLimit } from "./rate-limit";

type AuthMode = "public" | "user" | "admin";

type Options<A extends AuthMode, B extends z.ZodType, Q extends z.ZodType, P extends z.ZodType> = {
  auth: A;
  body?: B;
  query?: Q;
  params?: P;
  /** Counted per user when signed in, else per client IP. */
  rateLimit?: { name: string; limit: number; windowSeconds: number };
};

export type RouteCtx<A extends AuthMode, B, Q, P> = {
  req: Request;
  user: A extends "public" ? CurrentUser | null : CurrentUser;
  body: B;
  query: Q;
  params: P;
};

type NextCtx = { params: Promise<Record<string, string | string[] | undefined>> };

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF: Auth.js session cookies are SameSite=Lax + HttpOnly, and Auth.js's own
 * endpoints carry a CSRF token. For our mutating handlers we additionally require
 * that a present Origin header equals AUTH_URL's origin. Browsers always send
 * Origin on cross-origin POST/PUT/PATCH/DELETE, so a missing header means a
 * non-browser client (webhook, curl), which cannot ride a victim's cookies.
 */
export function assertSameOrigin(req: Request) {
  if (!MUTATING.has(req.method)) return;
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(process.env.AUTH_URL!).origin)
    throw new HttpError("forbidden", "Cross-origin request rejected");
}

function clientIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

function log(entry: Record<string, unknown>) {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));
}

/** Wraps an App Router route handler: origin check, auth, rate limit, zod parsing, error envelope. */
export function route<
  A extends AuthMode,
  B extends z.ZodType = z.ZodUnknown,
  Q extends z.ZodType = z.ZodUnknown,
  P extends z.ZodType = z.ZodUnknown,
>(
  opts: Options<A, B, Q, P>,
  handler: (ctx: RouteCtx<A, z.infer<B>, z.infer<Q>, z.infer<P>>) => Response | Promise<Response>,
) {
  return async (req: Request, next?: NextCtx): Promise<Response> => {
    const started = Date.now();
    const path = new URL(req.url).pathname;
    let user: CurrentUser | null = null;
    let res: Response;
    try {
      assertSameOrigin(req);

      user = await getCurrentUser(req);
      if (opts.auth !== "public" && !user) throw new HttpError("unauthorized", "Sign in required");
      if (opts.auth === "admin" && !user!.roles.includes("ADMIN"))
        throw new HttpError("forbidden", "Forbidden");

      if (opts.rateLimit) {
        const { name, limit, windowSeconds } = opts.rateLimit;
        const rl = await rateLimit(`${name}:${user?.id ?? clientIp(req)}`, limit, windowSeconds);
        if (!rl.ok) {
          const retryAfter = Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000);
          throw new HttpError("rate_limited", "Too many requests", undefined, {
            "Retry-After": String(Math.max(1, retryAfter)),
          });
        }
      }

      let body: unknown;
      if (opts.body) {
        const text = await req.clone().text();
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          throw new HttpError("validation_error", "Body must be valid JSON");
        }
      }
      const url = new URL(req.url);
      const ctx = {
        req,
        user,
        body: opts.body ? opts.body.parse(body) : undefined,
        query: opts.query ? opts.query.parse(Object.fromEntries(url.searchParams)) : undefined,
        params: opts.params ? opts.params.parse(await next?.params) : undefined,
      } as RouteCtx<A, z.infer<B>, z.infer<Q>, z.infer<P>>;
      res = await handler(ctx);
    } catch (e) {
      const err = toHttpError(e);
      if (err.status >= 500)
        log({
          level: "error",
          msg: "unhandled",
          method: req.method,
          path,
          errorName: (e as Error)?.name,
          errorCode: errorCode(e),
        });
      res = errorResponse(err);
    }
    log({
      level: "info",
      msg: "request",
      method: req.method,
      path,
      status: res.status,
      ms: Date.now() - started,
      userId: user?.id,
    });
    return res;
  };
}
