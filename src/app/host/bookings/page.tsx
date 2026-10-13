import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeft } from "lucide-react";
import { LoadingState } from "@/components/common/loading-state";
import { HostBookingsView, type HostBookingsTab } from "@/components/host/host-bookings-view";
import { getCurrentUser } from "@/server/auth/guards";
import { listBookings } from "@/server/bookings/service";

export const metadata: Metadata = { title: "Host Bookings" };

const TABS = [
  { scope: "upcoming" as const, label: "Upcoming", empty: "No upcoming bookings on your listings." },
  { scope: "active" as const, label: "Active", empty: "No drivers are parked in your spaces right now." },
  { scope: "past" as const, label: "Past", empty: "Your completed and cancelled bookings will appear here." },
  { scope: "all" as const, label: "All", empty: "No bookings found." },
];

export default function HostBookingsPage() {
  return (
    <>
      <div className="mb-4">
        <Link
          href="/host"
          className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-1 text-sm"
        >
          <ArrowLeft aria-hidden="true" className="size-4" /> Back to host dashboard
        </Link>
      </div>

      <h1 className="text-3xl font-bold">Host bookings</h1>

      <div className="mt-6">
        <Suspense fallback={<LoadingState label="Loading host bookings" />}>
          <HostBookingsContent />
        </Suspense>
      </div>
    </>
  );
}

async function HostBookingsContent() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in?callbackUrl=%2Fhost%2Fbookings");

  const results = await Promise.all(
    TABS.map((t) => listBookings(user, { as: "host", scope: t.scope, limit: 50 })),
  );

  const tabs: HostBookingsTab[] = TABS.map((t, i) => ({
    ...t,
    data: results[i],
  }));

  return <HostBookingsView tabs={tabs} />;
}
