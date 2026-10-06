import { route } from "@/server/http/route";

export const GET = route({ auth: "user" }, ({ user }) =>
  Response.json({
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    roles: user.roles,
    hostVerificationStatus: user.hostVerificationStatus,
  }),
);
