import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingState } from "@/components/common/loading-state";
import { ListingWizard } from "@/components/host/listing-wizard";

export const metadata: Metadata = { title: "New listing" };

export default function NewListingPage() {
  return (
    <>
      <h1 className="mb-6 text-3xl font-bold">New listing</h1>
      <Suspense fallback={<LoadingState label="Loading the listing editor" />}>
        <ListingWizard mode="new" />
      </Suspense>
    </>
  );
}
