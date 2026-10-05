import type { NextAuthConfig } from "next-auth";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/server/db";

const apiKey = process.env.RESEND_API_KEY;

const emailProvider = Resend({
  apiKey,
  from: process.env.EMAIL_FROM,
  // Without a Resend key (dev/test) the link goes to the server console only.
  ...(apiKey
    ? {}
    : {
        async sendVerificationRequest({ url }: { url: string }) {
          if (process.env.NODE_ENV === "production")
            throw new Error("RESEND_API_KEY is required in production");
          // Deliberately console only, never the structured logger: the URL holds the token.
          console.log(`\n[auth] magic sign-in link (dev only): ${url}\n`);
        },
      }),
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
