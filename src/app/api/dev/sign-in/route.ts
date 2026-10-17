import { z } from "zod";
import { createDemoSession, isDemoMode } from "@/lib/demo";

const SignInBody = z.object({
  email: z.string().email(),
});

export async function POST(req: Request) {
  if (!isDemoMode()) {
    return new Response("Not Found", { status: 404 });
  }

  const json = await req.json().catch(() => null);
  const parsed = SignInBody.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: { code: "validation_error", message: "Invalid email" } },
      { status: 400 },
    );
  }

  const result = await createDemoSession(parsed.data.email);
  return Response.json({ ok: true, session: result });
}
