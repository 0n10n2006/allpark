import { CreateVehicleBody } from "@/contracts";
import { route } from "@/server/http/route";
import { createVehicle, listVehicles } from "@/server/users/users";

export const GET = route({ auth: "user" }, async ({ user }) =>
  Response.json({ items: await listVehicles(user.id) }),
);
export const POST = route({ auth: "user", body: CreateVehicleBody }, async ({ user, body }) =>
  Response.json(await createVehicle(user.id, body), { status: 201 }),
);
