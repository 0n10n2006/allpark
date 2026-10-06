import { DeletionRequestBody } from "@/contracts";
import { route } from "@/server/http/route";
import { requestDeletion } from "@/server/users/users";

export const POST = route({ auth: "user", body: DeletionRequestBody }, async ({ user, body }) =>
  Response.json(await requestDeletion(user.id, body.reason), { status: 202 }),
);
