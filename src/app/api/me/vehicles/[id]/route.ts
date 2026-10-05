import { IdParams, UpdateVehicleBody } from "@/contracts";
import { route } from "@/server/http/route";
import { deleteVehicle, updateVehicle } from "@/server/users/users";

export const PATCH = route(
  { auth: "user", params: IdParams, body: UpdateVehicleBody },
  async ({ user, params, body }) => Response.json(await updateVehicle(user.id, params.id, body)),
);
export const DELETE = route({ auth: "user", params: IdParams }, async ({ user, params }) => {
  await deleteVehicle(user.id, params.id);
  return Response.json({ deleted: true });
});
