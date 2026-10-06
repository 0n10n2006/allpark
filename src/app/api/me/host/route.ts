import { BecomeHostBody } from "@/contracts";
import { becomeHost } from "@/server/listings/service";
import { route } from "@/server/http/route";

export const POST = route({ auth: "user", body: BecomeHostBody }, async ({ user }) =>
  Response.json(await becomeHost(user)),
);
