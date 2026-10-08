import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Uuid } from "@/contracts";
import { ListingDetail, ListingSkeleton } from "@/components/listing/listing-detail";
import { getCurrentUser } from "@/server/auth/guards";
import { getListingAvailability } from "@/server/availability/service";
import { HttpError } from "@/server/http/errors";
import { getPublicListing } from "@/server/listings/service";
import { listVehicles } from "@/server/users/users";

const DAY = 24 * 60 * 60 * 1000;

// The shell nav reads usePathname() outside Suspense, which can't prerender under an unknown
// dynamic param; allow this route to block until the shell wraps it (src/components/shell).
export const instant = false;

// cacheComponents: params, cookies, and the clock are request data, so read them in Suspense.
export default function ListingPage(props: PageProps<"/listings/[id]">) {
  return (
    <Suspense fallback={<ListingSkeleton />}>
      <ListingContent {...props} />
    </Suspense>
  );
}

async function ListingContent({ params }: PageProps<"/listings/[id]">) {
  const { id } = await params;
  if (!Uuid.safeParse(id).success) notFound();
  const user = await getCurrentUser();
  const now = new Date();
  // Public view for everyone (viewer null): drafts and suspended listings 404 even for the owner.
  const [listing, availability, vehicles] = await Promise.all([
    getPublicListing(id, null),
    getListingAvailability(id, null, {
      from: now.toISOString(),
      to: new Date(now.getTime() + 7 * DAY).toISOString(),
    }),
    user ? listVehicles(user.id) : null,
  ]).catch((e) => {
    if (e instanceof HttpError && e.code === "not_found") notFound();
    throw e;
  });

  return (
    <ListingDetail
      listing={listing}
      availability={availability}
      vehicles={vehicles}
      now={now}
      mapboxToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN || null}
    />
  );
}
