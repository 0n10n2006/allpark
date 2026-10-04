import { EmptyState } from "@/components/common/empty-state";
import { SearchX } from "lucide-react";
export default function NotFound() { return <main className="p-6"><EmptyState icon={SearchX} title="Page not found" body="The page you requested does not exist." /></main>; }
