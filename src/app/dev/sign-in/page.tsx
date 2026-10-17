import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { createDemoSession, DEMO_ACCOUNTS, isDemoMode } from "@/lib/demo";

export const metadata: Metadata = {
  title: "Demo sign-in",
  description: "One-click sign-in for seeded demo accounts in ParkShare demo mode.",
};

function safeCallback(value: unknown): string {
  return typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : "/explore";
}

async function handleSignIn(formData: FormData) {
  "use server";
  if (!isDemoMode()) {
    notFound();
  }
  const email = String(formData.get("email") || "");
  const callbackUrl = safeCallback(formData.get("callbackUrl"));
  await createDemoSession(email);
  redirect(callbackUrl);
}

export default function DemoSignInPage(props: PageProps<"/dev/sign-in">) {
  if (!isDemoMode()) {
    notFound();
  }
  return (
    <Suspense>
      <DemoSignInContent {...props} />
    </Suspense>
  );
}

async function DemoSignInContent({ searchParams }: PageProps<"/dev/sign-in">) {
  if (!isDemoMode()) {
    notFound();
  }
  const params = await searchParams;
  const callbackUrl = safeCallback(params.callbackUrl);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-8 space-y-2 text-center">
        <div className="inline-block">
          <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400">
            Demo Mode Active
          </Badge>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Demo Sign-in</h1>
        <p className="text-muted-foreground mx-auto max-w-lg text-sm">
          Select a seeded persona to sign in instantly without magic link emails. Sessions are stored in the local database.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {DEMO_ACCOUNTS.map((account) => (
          <Card key={account.key} className="flex flex-col justify-between">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-xl">{account.fullName}</CardTitle>
                <Badge variant={account.roles.includes("ADMIN") ? "default" : "secondary"}>
                  {account.roleLabel}
                </Badge>
              </div>
              <CardDescription>{account.email}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm leading-relaxed">{account.description}</p>
            </CardContent>
            <CardFooter className="pt-2">
              <form action={handleSignIn} className="w-full">
                <input type="hidden" name="email" value={account.email} />
                <input type="hidden" name="callbackUrl" value={callbackUrl} />
                <Button type="submit" className="h-11 w-full font-medium">
                  Sign in as {account.name}
                </Button>
              </form>
            </CardFooter>
          </Card>
        ))}
      </div>

      <div className="mt-8 text-center text-sm">
        <Link href={`/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`} className="text-muted-foreground hover:text-foreground underline underline-offset-4">
          Return to standard email sign-in
        </Link>
      </div>
    </main>
  );
}
