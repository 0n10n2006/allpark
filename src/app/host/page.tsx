import type { Metadata } from "next";
import Link from "next/link";
import { HostDashboard } from "@/components/host/host-dashboard";

export const metadata: Metadata = { title: "Host" };

export default function HostPage() {
  return (
    <>
      <div className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-3xl font-bold">Host your space</h1>
        <Link href="/host/earnings" className="text-primary min-h-11 py-2 underline">
          Earnings and payouts
        </Link>
      </div>
      <HostDashboard />
    </>
  );
}
