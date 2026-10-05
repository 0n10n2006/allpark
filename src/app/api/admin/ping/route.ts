import { route } from "@/server/http/route";

export const GET = route({ auth: "admin" }, () => Response.json({ ok: true }));
