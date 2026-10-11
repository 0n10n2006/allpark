import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingState } from "@/components/common/loading-state";
import { ListingWizard } from "@/components/host/listing-wizard";

export const metadata: Metadata = { title: "Edit listing" };

export default function EditListingPage() {
  return (
    <>
      <h1 className="mb-6 text-3xl font-bold">Edit listing</h1>
      <Suspense fallback={<LoadingState label="Loading the listing editor" />}>
        <ListingWizard mode="edit" />
      </Suspense>
    </>
  );
}
