import type { NextAuthConfig } from "next-auth";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/server/db";
import { clientIp, rateLimit } from "@/server/http/rate-limit";

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.EMAIL_FROM;

type SendVerificationRequest = NonNullable<ReturnType<typeof Resend>["sendVerificationRequest"]>;

/** Without a Resend key (dev/test) the link goes to the server console only. */
const consoleSender: SendVerificationRequest = async ({ url }) => {
  if (process.env.NODE_ENV === "production")
    throw new Error("RESEND_API_KEY is required in production");
  // Deliberately console only, never the structured logger: the URL holds the token.
  console.log(`\n[auth] magic sign-in link (dev only): ${url}\n`);
};

/**
 * M2 (PRD §9): at most 5 links per email and 20 per IP an hour. The sign-in server action and
 * a direct POST /api/auth/signin/resend both send through here. Over the cap the email is
 * silently skipped, so the response ("check your email") never differs.
 */
export function throttled(send: SendVerificationRequest): SendVerificationRequest {
  return async (params) => {
    const [byEmail, byIp] = await Promise.all([
      rateLimit(`auth.email:${params.identifier}`, 5, 3600),
      rateLimit(`auth.ip:${clientIp(params.request.headers)}`, 20, 3600),
    ]);
    if (byEmail.ok && byIp.ok) await send(params);
  };
}

const emailProvider = Resend({
  apiKey,
  from,
  // Options override the provider's own sender, so wrap the default rather than drop it.
  sendVerificationRequest: throttled(
    apiKey ? Resend({ apiKey, from }).sendVerificationRequest : consoleSender,
  ),
});

// ponytail: phone OTP (FR-01, decision Q4) plugs in here as a second provider
// once an SMS provider with DLT registration is chosen.

export const authConfig = {
  adapter: PrismaAdapter(db as unknown as Parameters<typeof PrismaAdapter>[0]),
  session: { strategy: "database" },
  providers: [emailProvider],
  pages: { signIn: "/sign-in", verifyRequest: "/sign-in", error: "/sign-in" },
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
} satisfies NextAuthConfig;
