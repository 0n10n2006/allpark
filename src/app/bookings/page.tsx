import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { CalendarDays } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { LoadingState } from "@/components/common/loading-state";
import { BookingCard } from "@/components/bookings/booking-card";
import { buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getCurrentUser } from "@/server/auth/guards";
import { listBookings } from "@/server/bookings/service";

export const metadata: Metadata = { title: "Your bookings" };

const TABS = [
  { scope: "upcoming", label: "Upcoming", empty: "No upcoming bookings." },
  { scope: "active", label: "Active", empty: "You're not parked anywhere right now." },
  { scope: "past", label: "Past", empty: "Your finished and cancelled bookings will appear here." },
] as const;

// cacheComponents: the session read has to sit inside a Suspense boundary.
export default function BookingsPage() {
  return (
    <>
      <h1 className="text-3xl font-bold">Your bookings</h1>
      <div className="mt-6">
        <Suspense fallback={<LoadingState label="Loading your bookings" />}>
          <BookingTabs />
        </Suspense>
      </div>
    </>
  );
}

async function BookingTabs() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in?callbackUrl=%2Fbookings");
  // ponytail: first 50 per tab, no "load more"; add cursor paging when renters hit it.
  const pages = await Promise.all(
    TABS.map((t) => listBookings(user, { as: "renter", scope: t.scope, limit: 50 })),
  );
  const [upcoming, active] = pages;
  const initial = active.items.length > 0 ? "active" : "upcoming";

  return (
    <Tabs defaultValue={initial}>
      <TabsList className="h-11 w-full sm:w-fit">
        {TABS.map((t, i) => (
          <TabsTrigger key={t.scope} value={t.scope} className="min-h-10 px-4">
            {t.label}
            {pages[i].items.length > 0 ? ` (${pages[i].items.length})` : ""}
          </TabsTrigger>
        ))}
      </TabsList>
      {TABS.map((t, i) => (
        <TabsContent key={t.scope} value={t.scope} className="mt-4">
          {pages[i].items.length > 0 ? (
            <ul className="grid gap-3 md:grid-cols-2">
              {pages[i].items.map((b) => (
                <BookingCard key={b.id} booking={b} />
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={CalendarDays}
              title={t.empty}
              body={
                upcoming.items.length + active.items.length === 0
                  ? "Find a space near where you're going and book it in a few taps."
                  : "Check the other tabs, or find another space."
              }
              action={
                <Link href="/explore" className={buttonVariants({ className: "h-11 px-4" })}>
                  Find parking
                </Link>
              }
            />
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}
