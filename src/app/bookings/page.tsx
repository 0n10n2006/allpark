import { CalendarDays } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
export default function BookingsPage() { return <><h1 className="text-3xl font-bold">Your bookings</h1><div className="mt-8"><EmptyState icon={CalendarDays} title="No bookings yet" body="Your reserved parking sessions will appear here." /></div></>; }
