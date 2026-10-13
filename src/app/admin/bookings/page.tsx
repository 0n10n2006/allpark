"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import {
  Search,
  Eye,
  RotateCcw,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/admin/status-badge";
import { EmptyState } from "@/components/common/empty-state";
import { LoadingState } from "@/components/common/loading-state";
import { api } from "@/lib/api-client";
import { formatINR } from "@/lib/money";
import { formatIST } from "@/lib/time";
import type {
  AdminBooking,
  AdminListBookingsResponse,
  AdminPayment,
} from "@/contracts";

type BookingDetailData = {
  booking: AdminBooking;
  payments: AdminPayment[];
  sessionEvents: Array<{
    id: string;
    type: string;
    occurredAt: string;
    actorId: string | null;
    metadata: Record<string, unknown>;
  }>;
  incidents: Array<{
    id: string;
    type: string;
    description: string;
    status: string;
    createdAt: string;
    resolvedAt: string | null;
  }>;
  notifications: Array<{
    id: string;
    userId: string;
    channel: string;
    type: string;
    status: string;
    scheduledAt: string;
    sentAt: string | null;
    createdAt: string;
  }>;
  ledger: Array<{
    id: string;
    entryType: string;
    amountPaise: number;
    currency: string;
    createdAt: string;
  }>;
};

export default function AdminBookingsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading bookings..." />}>
      <BookingsContent />
    </Suspense>
  );
}

function BookingsContent() {
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [bookingStatus, setBookingStatus] = useState<string>("ALL");
  const [bookings, setBookings] = useState<AdminBooking[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BookingDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchBookings = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (bookingStatus !== "ALL") params.set("bookingStatus", bookingStatus);
        if (cursor) params.set("cursor", cursor);
        params.set("limit", "20");

        const data = await api<AdminListBookingsResponse>(`/api/admin/bookings?${params.toString()}`);
        setBookings(data.items);
        setNextCursor(data.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load bookings");
      } finally {
        setLoading(false);
      }
    },
    [q, bookingStatus],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    fetchBookings();
  }, [fetchBookings]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCursorHistory([]);
    setQ(searchInput.trim());
  };

  const handleResetFilters = () => {
    setSearchInput("");
    setQ("");
    setBookingStatus("ALL");
    setCursorHistory([]);
  };

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, nextCursor]);
    fetchBookings(nextCursor);
  };

  const openBookingDetail = async (id: string) => {
    setSelectedBookingId(id);
    setDetailLoading(true);
    try {
      const data = await api<BookingDetailData>(`/api/admin/bookings/${id}`);
      setDetail(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load booking details");
      setSelectedBookingId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Bookings Inspection</h2>
          <p className="text-muted-foreground text-sm">
            Lookup bookings by ID, user, or listing. Inspect payments, ledger rows, session events, incidents, and notifications (FR-10 / FR-13).
          </p>
        </div>
      </div>

      {/* Filter and search bar */}
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center">
        <form onSubmit={handleSearchSubmit} className="flex flex-1 items-center gap-2">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-2.5 left-3 size-4" aria-hidden="true" />
            <Input
              type="search"
              placeholder="Search by booking code or ID..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9"
              aria-label="Search bookings"
            />
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <div className="w-44">
            <Select
              value={bookingStatus}
              onValueChange={(val) => {
                if (val) {
                  setBookingStatus(val);
                  setCursorHistory([]);
                }
              }}
            >
              <SelectTrigger aria-label="Filter by booking status">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Statuses</SelectItem>
                <SelectItem value="HELD">Held</SelectItem>
                <SelectItem value="CONFIRMED">Confirmed</SelectItem>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="COMPLETED">Completed</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
                <SelectItem value="DISPUTED">Disputed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(q || bookingStatus !== "ALL") && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleResetFilters}
              title="Reset filters"
              aria-label="Reset filters"
            >
              <RotateCcw className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Table state */}
      {loading ? (
        <LoadingState label="Loading bookings..." />
      ) : error ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-6 text-center text-destructive">
          <p className="font-semibold">{error}</p>
          <Button variant="outline" onClick={() => fetchBookings()} className="mt-3">
            Retry
          </Button>
        </div>
      ) : bookings.length === 0 ? (
        <EmptyState
          title="No bookings found"
          body="Try searching for another booking ID, code, or changing the status filter."
          action={
            <Button variant="outline" onClick={handleResetFilters}>
              Clear Filters
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Code / ID</TableHead>
                  <TableHead scope="col">Listing</TableHead>
                  <TableHead scope="col">Renter ID</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Time Window (IST)</TableHead>
                  <TableHead scope="col">Total</TableHead>
                  <TableHead scope="col" className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bookings.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <div className="font-mono font-bold text-xs">{b.id.slice(0, 8)}</div>
                      <div className="text-muted-foreground font-mono text-[10px]">{b.id}</div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{b.listing.title}</div>
                      <div className="text-muted-foreground text-xs">{b.listing.locality}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {b.renterId.slice(0, 8)}...
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={b.status} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      <div>{formatIST(new Date(b.startAt), "dd MMM, HH:mm")}</div>
                      <div className="text-[10px]">to {formatIST(new Date(b.endAt), "dd MMM, HH:mm")}</div>
                    </TableCell>
                    <TableCell className="font-semibold text-xs">
                      {formatINR(b.total.paise)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openBookingDetail(b.id)}
                        aria-label={`View full history for booking ${b.id.slice(0, 8)}`}
                      >
                        <Eye className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Showing {bookings.length} bookings</span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={cursorHistory.length === 0}
                onClick={() => {
                  const newHist = [...cursorHistory];
                  newHist.pop();
                  setCursorHistory(newHist);
                  const prevCursor = newHist[newHist.length - 1];
                  fetchBookings(prevCursor);
                }}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!nextCursor}
                onClick={handleNextPage}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Booking Detail Modal with full support timeline & history (FR-10) */}
      <Dialog open={Boolean(selectedBookingId)} onOpenChange={(open) => !open && setSelectedBookingId(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Booking Detail: {detail?.booking.id.slice(0, 8)}
            </DialogTitle>
            <DialogDescription>
              Comprehensive support inspection: state, payment status, financial ledger, session events, incidents, and notifications (FR-10).
            </DialogDescription>
          </DialogHeader>

          {detailLoading || !detail ? (
            <LoadingState label="Loading booking details..." />
          ) : (
            <div className="space-y-6 text-xs">
              {/* Status Header */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/40 p-4">
                <div className="space-y-1">
                  <div className="font-semibold text-sm">{detail.booking.listing.title}</div>
                  <div className="text-muted-foreground">
                    Host: <span className="font-mono text-foreground">{detail.booking.hostId}</span> |
                    Renter: <span className="font-mono text-foreground">{detail.booking.renterId}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={detail.booking.status} />
                  <span className="bg-primary/10 text-primary font-bold px-2 py-1 rounded text-sm">
                    {formatINR(detail.booking.total.paise)}
                  </span>
                </div>
              </div>

              {/* Tabs for Support Timeline */}
              <Tabs defaultValue="financials">
                <TabsList className="grid grid-cols-5 w-full">
                  <TabsTrigger value="financials">Financials</TabsTrigger>
                  <TabsTrigger value="payments">Payments ({detail.payments.length})</TabsTrigger>
                  <TabsTrigger value="sessions">Sessions ({detail.sessionEvents.length})</TabsTrigger>
                  <TabsTrigger value="incidents">Incidents ({detail.incidents.length})</TabsTrigger>
                  <TabsTrigger value="notifications">Alerts ({detail.notifications.length})</TabsTrigger>
                </TabsList>

                {/* Tab: Financials & Ledger */}
                <TabsContent value="financials" className="space-y-4 pt-3">
                  <div className="grid grid-cols-2 gap-3 rounded-lg border p-3">
                    <div><strong>Subtotal:</strong> {formatINR(detail.booking.subtotal.paise)}</div>
                    <div><strong>Renter Fee:</strong> {formatINR(detail.booking.renterFee.paise)}</div>
                    <div><strong>Platform Commission:</strong> {detail.booking.commission ? formatINR(detail.booking.commission.paise) : "—"}</div>
                    <div><strong>Host Earnings:</strong> {detail.booking.hostEarnings ? formatINR(detail.booking.hostEarnings.paise) : "—"}</div>
                  </div>

                  <div className="space-y-2">
                    <h3 className="font-semibold text-sm">Double-Entry Ledger Trail</h3>
                    {detail.ledger.length === 0 ? (
                      <p className="text-muted-foreground">No ledger transactions posted for this booking.</p>
                    ) : (
                      <div className="rounded-lg border overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead scope="col">Entry Type</TableHead>
                              <TableHead scope="col">Amount</TableHead>
                              <TableHead scope="col">Posted At (IST)</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {detail.ledger.map((l) => (
                              <TableRow key={l.id}>
                                <TableCell className="font-mono">{l.entryType}</TableCell>
                                <TableCell className="font-semibold">{formatINR(l.amountPaise)}</TableCell>
                                <TableCell className="text-muted-foreground">
                                  {formatIST(new Date(l.createdAt), "dd MMM yyyy, HH:mm:ss")}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* Tab: Payments */}
                <TabsContent value="payments" className="space-y-4 pt-3">
                  {detail.payments.length === 0 ? (
                    <p className="text-muted-foreground">No payment records found.</p>
                  ) : (
                    detail.payments.map((p) => (
                      <div key={p.id} className="rounded-lg border p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-semibold">{p.provider} ({p.providerOrderId})</span>
                          <StatusBadge status={p.status} />
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-muted-foreground">
                          <div>Payment ID: <span className="font-mono text-foreground">{p.providerPaymentId || "—"}</span></div>
                          <div>Amount: <span className="font-bold text-foreground">{formatINR(p.amount.paise)}</span></div>
                          <div>Signature Verified: <span className="text-foreground">{p.signatureVerifiedAt ? formatIST(new Date(p.signatureVerifiedAt), "dd MMM, HH:mm") : "—"}</span></div>
                          <div>Reconciled: <span className="text-foreground">{p.reconciledAt ? formatIST(new Date(p.reconciledAt), "dd MMM, HH:mm") : "Unreconciled"}</span></div>
                        </div>

                        {p.refunds.length > 0 && (
                          <div className="mt-2 pt-2 border-t space-y-1">
                            <span className="font-semibold">Refunds:</span>
                            {p.refunds.map((r) => (
                              <div key={r.id} className="flex items-center justify-between bg-muted/30 p-2 rounded">
                                <span>{r.reason} ({r.providerRefundId || "Pending"})</span>
                                <div className="flex items-center gap-2">
                                  <StatusBadge status={r.status} />
                                  <span className="font-bold text-destructive">-{formatINR(r.amount.paise)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </TabsContent>

                {/* Tab: Session Events */}
                <TabsContent value="sessions" className="space-y-2 pt-3">
                  {detail.sessionEvents.length === 0 ? (
                    <p className="text-muted-foreground">No check-in or checkout events recorded.</p>
                  ) : (
                    <ul className="space-y-2">
                      {detail.sessionEvents.map((s) => (
                        <li key={s.id} className="flex items-center justify-between rounded-lg border p-2.5">
                          <div>
                            <span className="font-semibold font-mono text-primary">{s.type}</span>
                            <div className="text-muted-foreground text-[10px]">
                              Actor: {s.actorId || "System"}
                            </div>
                          </div>
                          <span className="text-muted-foreground">
                            {formatIST(new Date(s.occurredAt), "dd MMM yyyy, HH:mm:ss")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>

                {/* Tab: Incidents */}
                <TabsContent value="incidents" className="space-y-2 pt-3">
                  {detail.incidents.length === 0 ? (
                    <p className="text-muted-foreground">No incidents reported during this session.</p>
                  ) : (
                    <ul className="space-y-2">
                      {detail.incidents.map((inc) => (
                        <li key={inc.id} className="rounded-lg border p-3 space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold">{inc.type}</span>
                            <StatusBadge status={inc.status} />
                          </div>
                          <p className="text-muted-foreground">{inc.description}</p>
                          <div className="text-[10px] text-muted-foreground">
                            Reported: {formatIST(new Date(inc.createdAt), "dd MMM yyyy, HH:mm")}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>

                {/* Tab: Notifications */}
                <TabsContent value="notifications" className="space-y-2 pt-3">
                  {detail.notifications.length === 0 ? (
                    <p className="text-muted-foreground">No notifications dispatched.</p>
                  ) : (
                    <ul className="space-y-2">
                      {detail.notifications.map((n) => (
                        <li key={n.id} className="flex items-center justify-between rounded-lg border p-2.5">
                          <div>
                            <div className="font-semibold">{n.type} ({n.channel})</div>
                            <div className="text-muted-foreground text-[10px]">Recipient: {n.userId.slice(0, 8)}...</div>
                          </div>
                          <div className="text-right">
                            <StatusBadge status={n.status} />
                            <div className="text-muted-foreground text-[10px] mt-0.5">
                              {n.sentAt ? formatIST(new Date(n.sentAt), "dd MMM, HH:mm") : "Not sent"}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
