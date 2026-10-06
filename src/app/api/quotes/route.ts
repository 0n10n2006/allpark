import { CreateQuoteBody } from "@/contracts";
import { route } from "@/server/http/route";
import { createQuote } from "@/server/pricing/quotes";

export const POST = route(
  {
    auth: "user",
    body: CreateQuoteBody,
    rateLimit: { name: "quotes.create", limit: 60, windowSeconds: 60 },
  },
  async ({ user, body }) => Response.json(await createQuote(user, body)),
);
