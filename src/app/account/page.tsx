import type { Metadata } from "next";
import { AccountView } from "@/components/account/account-view";

export const metadata: Metadata = { title: "Your account" };

// Signed-out visitors are redirected to sign-in by src/proxy.ts; AccountView also
// redirects on a 401, and every /api/me route enforces auth server-side.
export default function AccountPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-3xl font-bold">Your account</h1>
      <AccountView />
    </div>
  );
}
