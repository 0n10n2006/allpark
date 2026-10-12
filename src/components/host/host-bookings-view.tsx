"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, Flag } from "lucide-react";
import { toast } from "sonner";
import type { BookingSummary, ListBookingsResponse } from "@/contracts";
import { EmptyState } from "@/components/common/empty-state";
import { MoneyBadges } from "@/components/bookings/booking-card";
import {
  BOOKING_STATUS_LABEL,
  BOOKING_STATUS_TONE,
  formatRangeIST,
} from "@/components/bookings/labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api-client";
import { formatINR } from "@/lib/money";

export interface HostBookingsTab {
  scope: "upcoming" | "active" | "past" | "all";
  label: string;
  empty: string;
  data: ListBookingsResponse;
}

export function HostBookingsView({ tabs }: { tabs: HostBookingsTab[] }) {
  const router = useRouter();
  const activeTab = tabs.find((t) => t.data.items.length > 0)?.scope ?? "upcoming";

  return (
    <Tabs defaultValue={activeTab}>
      <TabsList className="w-full group-data-horizontal/tabs:h-auto sm:w-fit">
        {tabs.map((t) => (
          <TabsTrigger key={t.scope} value={t.scope} className="min-h-11 px-4">
            {t.label}
            {t.data.items.length > 0 ? ` (${t.data.items.length})` : ""}
          </TabsTrigger>
        ))}
      </TabsList>

      {tabs.map((t) => (
        <TabsContent key={t.scope} value={t.scope} className="mt-4">
          {t.data.items.length > 0 ? (
            <ul className="grid gap-4 md:grid-cols-2">
              {t.data.items.map((b) => (
                <HostBookingCard key={b.id} booking={b} onDone={() => router.refresh()} />
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={CalendarDays}
              title={t.empty}
              body="Bookings on your listings will appear here."
              action={
                <Link href="/host" className="text-primary underline">
                  Back to host dashboard
                </Link>
              }
            />
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function HostBookingCard({
  booking: b,
  onDone,
}: {
  booking: BookingSummary;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const canConfirmArrival = b.status === "CONFIRMED" || b.status === "ACTIVE";
  const canConfirmDeparture =
    b.status === "ACTIVE" || b.status === "GRACE_PERIOD" || b.status === "OVERSTAY";
  const canReportProblem =
    b.status === "ACTIVE" || b.status === "GRACE_PERIOD" || b.status === "OVERSTAY";

  const handleConfirmArrival = async () => {
    setBusy(true);
    try {
      await api(`/api/bookings/${b.id}/check-in`, {
        method: "POST",
        body: { asHost: true },
      });
      toast.success("Arrival confirmed.");
      onDone();
    } catch (e) {
      if (e instanceof ApiError) {
        toast.error(e.message);
      } else {
        toast.error("Failed to confirm arrival.");
      }
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmDeparture = async () => {
    setBusy(true);
    try {
      await api(`/api/bookings/${b.id}/check-out`, {
        method: "POST",
        body: {},
      });
      toast.success("Departure confirmed.");
      onDone();
    } catch (e) {
      if (e instanceof ApiError) {
        toast.error(e.message);
      } else {
        toast.error("Failed to confirm departure.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-xl border p-5 flex flex-col justify-between gap-4">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-lg font-semibold">{b.listing.title}</h3>
            <p className="text-muted-foreground text-sm">{b.listing.locality}</p>
          </div>
          <p className="font-semibold tabular-nums text-right">{formatINR(b.total.paise)}</p>
        </div>

        <p className="mt-2 text-sm">{formatRangeIST(b.startAt, b.endAt)}</p>

        <div className="mt-3 flex flex-wrap gap-2">
          <Badge variant={BOOKING_STATUS_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</Badge>
          <MoneyBadges b={b} />
        </div>
      </div>

      <div className="border-t pt-3 flex flex-wrap items-center gap-2">
        {canConfirmArrival ? (
          <Button
            className="h-10 px-3"
            disabled={busy}
            onClick={handleConfirmArrival}
          >
            Confirm arrival
          </Button>
        ) : null}

        {canConfirmDeparture ? (
          <Button
            variant="outline"
            className="h-10 px-3"
            disabled={busy}
            onClick={handleConfirmDeparture}
          >
            Confirm departure
          </Button>
        ) : null}

        {canReportProblem ? (
          <HostReportProblemDialog bookingId={b.id} onDone={onDone} />
        ) : null}
      </div>
    </li>
  );
}

function HostReportProblemDialog({
  bookingId,
  onDone,
}: {
  bookingId: string;
  onDone: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<"OVERSTAY" | "BLOCKED_ACCESS">("OVERSTAY");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (description.trim().length < 5) {
      setError("Please describe the issue in at least 5 characters.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await api(`/api/bookings/${bookingId}/incidents`, {
        method: "POST",
        body: {
          kind: category,
          note: description.trim(),
          evidenceUrls: [],
        },
      });
      toast.success("Problem reported. Support will review it.");
      setOpen(false);
      setDescription("");
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        toast.error(err.message);
      } else {
        setError("Failed to report problem. Please try again.");
        toast.error("Failed to report problem");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" className="h-10 px-3 gap-1.5 text-muted-foreground hover:text-foreground">
            <Flag className="size-4" /> Report a problem
          </Button>
        }
      />

      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <form onSubmit={handleSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Report a problem</DialogTitle>
            <DialogDescription>
              Report an overstay or blocked access to ParkShare support.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor={`${id}-cat`} className="text-sm font-medium">
              Category
            </Label>
            <select
              id={`${id}-cat`}
              className="border-input bg-background h-10 rounded-md border px-3 text-sm"
              value={category}
              onChange={(e) => setCategory(e.target.value as "OVERSTAY" | "BLOCKED_ACCESS")}
              disabled={busy}
            >
              <option value="OVERSTAY">Overstay</option>
              <option value="BLOCKED_ACCESS">Blocked access</option>
            </select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`${id}-desc`} className="text-sm font-medium">
              Description
            </Label>
            <Textarea
              id={`${id}-desc`}
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
              placeholder="Describe what happened..."
              className="min-h-24 resize-y"
              maxLength={2000}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-err` : undefined}
            />
          </div>

          {error ? (
            <p id={`${id}-err`} role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}

          <DialogFooter className="gap-2 sm:gap-0">
            <DialogClose render={<Button type="button" variant="outline" disabled={busy} />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Submitting..." : "Submit report"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
