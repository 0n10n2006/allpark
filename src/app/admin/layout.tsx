import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ShieldCheck } from "lucide-react";
import { AdminNav } from "@/components/admin/admin-nav";
import { LoadingState } from "@/components/common/loading-state";
import { getCurrentUser } from "@/server/auth/guards";

export const metadata: Metadata = {
  title: "Admin Console",
  description: "Operations, verification, moderation, and payouts for ParkShare administrators.",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<LoadingState label="Verifying admin credentials..." />}>
      <AdminAuthBoundary>{children}</AdminAuthBoundary>
    </Suspense>
  );
}

async function AdminAuthBoundary({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/sign-in?callbackUrl=%2Fadmin");
  }
  if (!user.roles.includes("ADMIN")) {
    redirect("/");
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <div className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">ParkShare Admin</h1>
            <p className="text-muted-foreground text-xs">
              Operations, moderation & financial administration (FR-13)
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="bg-muted text-muted-foreground rounded-md px-2.5 py-1 font-medium">
            Admin: {user.name || user.email || user.id.slice(0, 8)}
          </span>
          <Link
            href="/"
            className="text-primary hover:underline font-medium"
          >
            ← Back to App
          </Link>
        </div>
      </header>

      <div className="flex flex-col gap-6 md:flex-row">
        <aside className="w-full shrink-0 md:w-60" aria-label="Admin sidebar">
          <div className="sticky top-4 rounded-xl border bg-card p-3 shadow-xs">
            <AdminNav />
          </div>
        </aside>

        <section aria-label="Admin content" className="flex-1 min-w-0">
          {children}
        </section>
      </div>
    </div>
  );
}
