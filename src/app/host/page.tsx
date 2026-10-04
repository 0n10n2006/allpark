import { House } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
export default function HostPage() { return <><h1 className="text-3xl font-bold">Host your space</h1><div className="mt-8"><EmptyState icon={House} title="List your first space" body="Host tools will help you share your parking space." /></div></>; }
