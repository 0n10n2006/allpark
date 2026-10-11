import type { Metadata } from "next";
import { HostDashboard } from "@/components/host/host-dashboard";

export const metadata: Metadata = { title: "Host" };

export default function HostPage() {
  return (
    <>
      <h1 className="mb-8 text-3xl font-bold">Host your space</h1>
      <HostDashboard />
    </>
  );
}
