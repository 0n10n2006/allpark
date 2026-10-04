import { UserRound } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
export default function AccountPage() {
  return (
    <>
      <h1 className="text-3xl font-bold">Your account</h1>
      <div className="mt-8">
        <EmptyState
          icon={UserRound}
          title="Account setup is coming soon"
          body="Manage your ParkShare profile and preferences here."
        />
      </div>
    </>
  );
}
