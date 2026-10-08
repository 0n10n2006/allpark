import Link from "next/link";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";

export default function ListingNotFound() {
  return (
    <>
      <h1 className="sr-only">Listing not found</h1>
      <EmptyState
        icon={SearchX}
        title="This space isn't available"
        body="The listing doesn't exist or isn't taking bookings right now."
        action={
          <Link href="/explore" className="text-primary underline underline-offset-4">
            Explore other spaces
          </Link>
        }
      />
    </>
  );
}
