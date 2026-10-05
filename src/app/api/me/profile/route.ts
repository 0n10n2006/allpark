import { UpdateProfileBody } from "@/contracts";
import { route } from "@/server/http/route";
import { getProfile, updateProfile } from "@/server/users/users";

export const GET = route({ auth: "user" }, async ({ user }) =>
  Response.json(await getProfile(user.id)),
);
export const PATCH = route({ auth: "user", body: UpdateProfileBody }, async ({ user, body }) =>
  Response.json(await updateProfile(user.id, body)),
);
