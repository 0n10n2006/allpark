import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn } from "@/server/auth";

export const metadata: Metadata = { title: "Sign in" };

/** Only same-site relative paths, so callbackUrl can't become an open redirect. */
function safeCallback(value: unknown) {
  return typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : "/explore";
}

async function sendLink(formData: FormData) {
  "use server";
  const callbackUrl = safeCallback(formData.get("callbackUrl"));
  const email = z.string().trim().toLowerCase().email().safeParse(formData.get("email"));
  if (!email.success)
    redirect(`/sign-in?error=InvalidEmail&callbackUrl=${encodeURIComponent(callbackUrl)}`);
  // Throws NEXT_REDIRECT to the check-your-email state; must not be caught.
  await signIn("resend", { email: email.data, redirectTo: callbackUrl });
}

// cacheComponents: request data (searchParams) must be read inside a Suspense boundary.
export default function SignInPage(props: PageProps<"/sign-in">) {
  return (
    <Suspense>
      <SignInContent {...props} />
    </Suspense>
  );
}

async function SignInContent({ searchParams }: PageProps<"/sign-in">) {
  const params = await searchParams;
  const callbackUrl = safeCallback(params.callbackUrl);

  // Auth.js's verifyRequest redirect lands here as ?provider=resend&type=email.
  if (params.type === "email") {
    return (
      <section className="mx-auto max-w-sm" aria-labelledby="sign-in-title">
        <h1 id="sign-in-title" className="text-3xl font-bold">
          Check your email
        </h1>
        <p role="status" className="text-muted-foreground mt-4">
          We sent you a sign-in link. It expires in 24 hours. You can close this tab.
        </p>
      </section>
    );
  }

  const error = params.error
    ? params.error === "InvalidEmail"
      ? "Enter a valid email address."
      : "We couldn't sign you in. The link may have expired. Request a new one."
    : null;

  return (
    <section className="mx-auto max-w-sm" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title" className="text-3xl font-bold">
        Sign in
      </h1>
      <p className="text-muted-foreground mt-2">We&apos;ll email you a link to sign in.</p>
      {error && (
        <Alert variant="destructive" className="mt-6" role="alert" id="sign-in-error">
          <AlertTitle>Sign-in failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <form action={sendLink} className="mt-6 space-y-4">
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="h-11"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "sign-in-error" : undefined}
          />
        </div>
        <Button type="submit" className="h-11 w-full">
          Email me a sign-in link
        </Button>
      </form>
    </section>
  );
}
