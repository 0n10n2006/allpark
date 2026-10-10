import { Suspense } from "react";
import type { Metadata } from "next";
import { Explore } from "@/components/explore/explore";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Explore parking" };

export default function ExplorePage() {
  return (
    <>
      <h1 className="text-3xl font-bold">Explore parking</h1>
      {/* cacheComponents: the search params are read below this boundary. */}
      <Suspense fallback={<Skeleton className="mt-6 h-11 w-full" />}>
        <Explore />
      </Suspense>
    </>
  );
}
