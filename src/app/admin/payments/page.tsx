"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import {
  Search,
  Eye,
  CheckCircle2,
  Clock,
  RotateCcw,
  Receipt,
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
import { StatusBadge } from "@/components/admin/status-badge";
import { EmptyState } from "@/components/common/empty-state";
import { LoadingState } from "@/components/common/loading-state";
import { api } from "@/lib/api-client";
import { formatINR } from "@/lib/money";
import { formatIST } from "@/lib/time";
import type { AdminPayment, AdminListPaymentsResponse } from "@/contracts";

export default function AdminPaymentsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading payments..." />}>
      <PaymentsContent />
    </Suspense>
  );
}

function PaymentsContent() {
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [paymentStatus, setPaymentStatus] = useState<string>("ALL");
  const [unreconciledOnly, setUnreconciledOnly] = useState<boolean>(false);
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedPayment, setSelectedPayment] = useState<AdminPayment | null>(null);

  const fetchPayments = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (paymentStatus !== "ALL") params.set("paymentStatus", paymentStatus);
        if (unreconciledOnly) params.set("unreconciled", "true");
        if (cursor) params.set("cursor", cursor);
        params.set("limit", "20");

        const data = await api<AdminListPaymentsResponse>(`/api/admin/payments?${params.toString()}`);
        setPayments(data.items);
        setNextCursor(data.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load payments");
      } finally {
        setLoading(false);
      }
    },
    [q, paymentStatus, unreconciledOnly],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    fetchPayments();
  }, [fetchPayments]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCursorHistory([]);
    setQ(searchInput.trim());
  };

  const handleResetFilters = () => {
    setSearchInput("");
    setQ("");
    setPaymentStatus("ALL");
    setUnreconciledOnly(false);
    setCursorHistory([]);
  };

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, nextCursor]);
    fetchPayments(nextCursor);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Payments & Ledger Inspection</h2>
          <p className="text-muted-foreground text-sm">
            Inspect captured payments, gateway order references, signature verification, and refund records (FR-13).
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
              placeholder="Search by order ID, payment ID, or reference..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9"
              aria-label="Search payments"
            />
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <div className="w-48">
            <Select
              value={paymentStatus}
              onValueChange={(val) => {
                if (val) {
                  setPaymentStatus(val);
                  setCursorHistory([]);
                }
              }}
            >
              <SelectTrigger aria-label="Filter by payment status">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Statuses</SelectItem>
                <SelectItem value="ORDER_CREATED">Order Created</SelectItem>
                <SelectItem value="CAPTURED">Captured</SelectItem>
                <SelectItem value="FAILED">Failed</SelectItem>
                <SelectItem value="REFUNDED">Refunded</SelectItem>
                <SelectItem value="PARTIALLY_REFUNDED">Partially Refunded</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button
            type="button"
            variant={unreconciledOnly ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setUnreconciledOnly(!unreconciledOnly);
              setCursorHistory([]);
            }}
          >
            {unreconciledOnly ? "Unreconciled Only ✓" : "Filter Unreconciled"}
          </Button>

          {(q || paymentStatus !== "ALL" || unreconciledOnly) && (
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
        <LoadingState label="Loading payments..." />
      ) : error ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-6 text-center text-destructive">
          <p className="font-semibold">{error}</p>
          <Button variant="outline" onClick={() => fetchPayments()} className="mt-3">
            Retry
          </Button>
        </div>
      ) : payments.length === 0 ? (
        <EmptyState
          title="No payment records found"
          body="Try adjusting your search criteria or removing the unreconciled filter."
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
                  <TableHead scope="col">Provider & Order</TableHead>
                  <TableHead scope="col">Booking ID</TableHead>
                  <TableHead scope="col">Amount</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Reconciliation</TableHead>
                  <TableHead scope="col">Created (IST)</TableHead>
                  <TableHead scope="col" className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="font-semibold text-xs">{p.provider}</div>
                      <div className="text-muted-foreground font-mono text-[10px]">{p.providerOrderId}</div>
                      {p.providerPaymentId && (
                        <div className="text-primary font-mono text-[10px]">{p.providerPaymentId}</div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {p.bookingId.slice(0, 8)}...
                    </TableCell>
                    <TableCell className="font-bold text-xs">
                      {formatINR(p.amount.paise)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={p.status} />
                    </TableCell>
                    <TableCell>
                      {p.reconciledAt ? (
                        <div className="flex items-center gap-1 text-xs text-emerald-600">
                          <CheckCircle2 className="size-3" aria-hidden="true" />
                          <span>Reconciled</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 text-xs text-amber-600">
                          <Clock className="size-3" aria-hidden="true" />
                          <span>Unreconciled</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {formatIST(new Date(p.createdAt), "dd MMM yyyy, HH:mm")}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedPayment(p)}
                        aria-label={`View payment details for ${p.providerOrderId}`}
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
            <span>Showing {payments.length} payments</span>
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
                  fetchPayments(prevCursor);
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

      {/* Payment Detail Dialog */}
      <Dialog open={Boolean(selectedPayment)} onOpenChange={(open) => !open && setSelectedPayment(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Payment Record Details</DialogTitle>
            <DialogDescription>
              Gateway transaction status, signature verification, and issued refunds.
            </DialogDescription>
          </DialogHeader>

          {selectedPayment && (
            <div className="space-y-5 text-xs">
              <div className="flex items-center justify-between rounded-lg border bg-muted/40 p-4">
                <div>
                  <div className="font-semibold text-sm">{selectedPayment.provider.toUpperCase()} Gateway</div>
                  <div className="text-muted-foreground font-mono text-[11px]">ID: {selectedPayment.id}</div>
                </div>
                <div className="text-right">
                  <div className="font-extrabold text-base">{formatINR(selectedPayment.amount.paise)}</div>
                  <StatusBadge status={selectedPayment.status} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 rounded-lg border p-3">
                <div><strong>Booking ID:</strong> <span className="font-mono text-muted-foreground">{selectedPayment.bookingId}</span></div>
                <div><strong>Order ID:</strong> <span className="font-mono text-muted-foreground">{selectedPayment.providerOrderId}</span></div>
                <div><strong>Provider Payment ID:</strong> <span className="font-mono text-muted-foreground">{selectedPayment.providerPaymentId || "—"}</span></div>
                <div><strong>Created:</strong> {formatIST(new Date(selectedPayment.createdAt), "dd MMM yyyy, HH:mm:ss")}</div>
                <div>
                  <strong>Signature Verified:</strong>{" "}
                  {selectedPayment.signatureVerifiedAt
                    ? formatIST(new Date(selectedPayment.signatureVerifiedAt), "dd MMM yyyy, HH:mm:ss")
                    : "Not verified"}
                </div>
                <div>
                  <strong>Reconciled:</strong>{" "}
                  {selectedPayment.reconciledAt
                    ? formatIST(new Date(selectedPayment.reconciledAt), "dd MMM yyyy, HH:mm:ss")
                    : "Unreconciled"}
                </div>
              </div>

              {/* Refunds section */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Receipt className="size-4 text-muted-foreground" aria-hidden="true" />
                  <h3 className="font-semibold text-sm">Refund History ({selectedPayment.refunds.length})</h3>
                </div>
                {selectedPayment.refunds.length === 0 ? (
                  <p className="text-muted-foreground">No refunds issued against this payment.</p>
                ) : (
                  <div className="space-y-2">
                    {selectedPayment.refunds.map((r) => (
                      <div key={r.id} className="rounded-lg border p-3 space-y-1 bg-muted/20">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{r.reason}</span>
                          <div className="flex items-center gap-2">
                            <StatusBadge status={r.status} />
                            <span className="font-bold text-destructive">-{formatINR(r.amount.paise)}</span>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-muted-foreground text-[10px]">
                          <div>Provider Refund ID: <span className="font-mono">{r.providerRefundId || "—"}</span></div>
                          <div>Created: {formatIST(new Date(r.createdAt), "dd MMM yyyy, HH:mm")}</div>
                        </div>
                        {r.failureReason && (
                          <div className="text-destructive font-semibold text-[10px]">
                            Failure: {r.failureReason}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
