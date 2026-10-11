"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Wallet } from "lucide-react";
import type { EarningStatus, HostEarningsResponse, ListHostPayoutsResponse } from "@/contracts";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { LoadingState } from "@/components/common/loading-state";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api-client";
import { formatINR } from "@/lib/money";
import { formatIST } from "@/lib/time";

type Payout = ListHostPayoutsResponse["items"][number];
type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; earnings: HostEarningsResponse; payouts: Payout[] };

const EARNING_LABELS: Record<EarningStatus, string> = {
  PENDING: "Pending",
  PAYABLE: "Payable",
  PAID: "In payout",
};
const PAYOUT_LABELS: Record<Payout["status"], string> = {
  PENDING: "Processing",
  PROCESSING: "Processing",
  PAID: "Paid",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export function EarningsView() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const [earnings, payouts] = await Promise.all([
        api<HostEarningsResponse>("/api/host/earnings"),
        api<ListHostPayoutsResponse>("/api/host/payouts?limit=50"),
      ]);
      setState({ kind: "ready", earnings, payouts: payouts.items });
    } catch (e) {
      setState({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    void load();
  }, [load]);

  if (state.kind === "loading") return <LoadingState label="Loading your earnings" />;
  if (state.kind === "error")
    return (
      <ErrorState
        message={state.message}
        onRetry={() => {
          setState({ kind: "loading" });
          void load();
        }}
      />
    );
  const { earnings: e, payouts } = state;
  return (
    <div className="space-y-8">
      {e.payoutMode === "MANUAL" ? (
        <p className="bg-muted rounded-xl p-4 text-sm">
          Payouts are processed manually by ParkShare. Earnings become payable 24 hours after a
          booking completes, and a ParkShare admin sends them to you by bank transfer.
        </p>
      ) : null}
      <section aria-labelledby="totals" className="space-y-3">
        <h2 id="totals" className="sr-only">
          Totals
        </h2>
        <dl className="grid gap-4 sm:grid-cols-3">
          <Total
            label="Pending"
            value={e.pending.paise}
            hint="Upcoming, in progress, or within 24 hours of completion"
          />
          <Total label="Payable" value={e.payable.paise} hint="Ready for the next payout" />
          <Total label="Paid" value={e.paidOut.paise} hint="Included in a payout" />
        </dl>
        <p className="text-muted-foreground text-sm">
          {e.bookingCount} paid {e.bookingCount === 1 ? "booking" : "bookings"}: gross{" "}
          {formatINR(e.gross.paise)}, commission {formatINR(e.commission.paise)}, refunds{" "}
          {formatINR(e.refunds.paise)}, your net {formatINR(e.hostEarnings.paise)}.
        </p>
      </section>

      <section aria-labelledby="earning-bookings" className="space-y-3">
        <h2 id="earning-bookings" className="text-2xl font-semibold">
          Bookings
        </h2>
        {e.bookings.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="No earnings yet"
            body="When renters pay for bookings at your spaces, they show up here."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Booking</TableHead>
                <TableHead scope="col" className="text-right">
                  Gross
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Commission
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Refunds
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Net
                </TableHead>
                <TableHead scope="col">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {e.bookings.map((b) => (
                <TableRow key={b.bookingId}>
                  <TableCell>
                    <Link href={`/bookings/${b.bookingId}`} className="font-medium underline">
                      {b.listingTitle}
                    </Link>
                    <span className="text-muted-foreground block text-xs">
                      {formatIST(new Date(b.startAt), "d MMM yyyy, h:mm a")}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">{formatINR(b.gross.paise)}</TableCell>
                  <TableCell className="text-right">−{formatINR(b.commission.paise)}</TableCell>
                  <TableCell className="text-right">
                    {b.hostRefunds.paise ? `−${formatINR(b.hostRefunds.paise)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium">{formatINR(b.net.paise)}</TableCell>
                  <TableCell>
                    <Badge variant={b.status === "PAYABLE" ? "default" : "secondary"}>
                      {b.payoutStatus === "PAID" ? "Paid" : EARNING_LABELS[b.status]}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section aria-labelledby="payouts" className="space-y-3">
        <h2 id="payouts" className="text-2xl font-semibold">
          Payouts
        </h2>
        {payouts.length === 0 ? (
          <p className="text-muted-foreground">No payouts yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Created</TableHead>
                <TableHead scope="col" className="text-right">
                  Amount
                </TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Reference</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payouts.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{formatIST(new Date(p.createdAt), "d MMM yyyy")}</TableCell>
                  <TableCell className="text-right">{formatINR(p.amount.paise)}</TableCell>
                  <TableCell>
                    <Badge variant={p.status === "FAILED" ? "destructive" : "secondary"}>
                      {PAYOUT_LABELS[p.status]}
                    </Badge>
                    {p.status === "FAILED" ? (
                      <span className="text-muted-foreground block text-xs whitespace-normal">
                        {p.failureReason ? `${p.failureReason}. ` : ""}These earnings are payable
                        again.
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>{p.providerReference ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

function Total({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="bg-card rounded-xl border p-4">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="text-2xl font-semibold">{formatINR(value)}</dd>
      <dd className="text-muted-foreground mt-1 text-xs">{hint}</dd>
    </div>
  );
}
