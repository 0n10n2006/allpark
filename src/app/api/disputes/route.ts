import { CreateDisputeBody, PaginationQuery } from "@/contracts";
import { createDispute, listMyDisputes } from "@/server/disputes/service";
import { route } from "@/server/http/route";

export const GET = route({ auth: "user", query: PaginationQuery }, async ({ user, query }) =>
  Response.json(await listMyDisputes(user, query)),
);

export const POST = route(
  {
    auth: "user",
    body: CreateDisputeBody,
    rateLimit: { name: "disputes.create", limit: 10, windowSeconds: 3600 },
  },
  async ({ user, body }) => Response.json(await createDispute(user, body), { status: 201 }),
);
