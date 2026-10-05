import { UpdatePreferencesBody } from "@/contracts";
import { route } from "@/server/http/route";
import { getPreferences, updatePreferences } from "@/server/users/users";

export const GET = route({ auth: "user" }, async ({ user }) =>
  Response.json(await getPreferences(user.id)),
);
export const PATCH = route({ auth: "user", body: UpdatePreferencesBody }, async ({ user, body }) =>
  Response.json(await updatePreferences(user.id, body)),
);
