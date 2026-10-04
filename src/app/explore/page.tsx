import { Compass } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
export default function ExplorePage() { return <><h1 className="text-3xl font-bold">Explore parking</h1><div className="mt-8"><EmptyState icon={Compass} title="Parking spaces are coming soon" body="Explore available spaces around Pune once listings are live." /></div></>; }
