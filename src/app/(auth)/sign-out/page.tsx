import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { signOut } from "@/server/auth";

export const metadata: Metadata = { title: "Sign out" };

async function doSignOut() {
  "use server";
  await signOut({ redirectTo: "/" });
}

export default function SignOutPage() {
  return (
    <section className="mx-auto max-w-sm" aria-labelledby="sign-out-title">
      <h1 id="sign-out-title" className="text-3xl font-bold">
        Sign out
      </h1>
      <p className="text-muted-foreground mt-2">
        You&apos;ll need a new email link to sign back in.
      </p>
      <form action={doSignOut} className="mt-6">
        <Button type="submit" className="h-11 w-full">
          Sign out
        </Button>
      </form>
    </section>
  );
}
