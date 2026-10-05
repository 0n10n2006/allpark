import { z } from "zod";
import { audit } from "@/server/http/audit";
import { errorResponse, HttpError } from "@/server/http/errors";
import { withIdempotency } from "@/server/http/idempotency";
import { route } from "@/server/http/route";

const echo = route(
  {
    auth: "user",
    body: z.object({ message: z.string().max(500) }),
    rateLimit: { name: "dev.echo", limit: 5, windowSeconds: 60 },
  },
  ({ req, user, body }) =>
    withIdempotency(req, user.id, async () => {
      const entry = await audit(user.id, "dev.echo", "User", user.id, null, {
        length: body.message.length,
      });
      return Response.json({ echo: body.message, auditId: entry.id }, { status: 201 });
    }),
);

// Dev-only proof of the API kit (auth, zod body, rate limit, idempotency, audit).
export const POST: typeof echo =
  process.env.NODE_ENV === "production"
    ? async () => errorResponse(new HttpError("not_found", "Not found"))
    : echo;
