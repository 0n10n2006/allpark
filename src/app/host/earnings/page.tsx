import type { Metadata } from "next";
import { EarningsView } from "@/components/host/earnings/earnings-view";

export const metadata: Metadata = { title: "Earnings" };

export default function HostEarningsPage() {
  return (
    <>
      <h1 className="mb-8 text-3xl font-bold">Earnings and payouts</h1>
      <EarningsView />
    </>
  );
}
