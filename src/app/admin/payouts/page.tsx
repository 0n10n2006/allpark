"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import {
  IndianRupee,
  CheckCircle,
  XCircle,
  AlertTriangle,
  RotateCcw,
  PlusCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  ArrowRight,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
import { ActionDialog } from "@/components/admin/action-dialog";
import { EmptyState } from "@/components/common/empty-state";
import { LoadingState } from "@/components/common/loading-state";
import { api, newIdempotencyKey } from "@/lib/api-client";
import { formatINR } from "@/lib/money";
import { formatIST } from "@/lib/time";
import type {
  AdminPayout,
  AdminListPayoutsResponse,
  AdminPayoutReconciliationResponse,
  AdminCreatePayoutBody,
  AdminMarkPayoutPaidBody,
  AdminMarkPayoutFailedBody,
  AdminBooking,
  AdminListBookingsResponse,
} from "@/contracts";

export default function AdminPayoutsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading payouts..." />}>
      <PayoutsContent />
    </Suspense>
  );
}

function PayoutsContent() {
  const [activeTab, setActiveTab] = useState("queue");
  const [payoutStatus, setPayoutStatus] = useState<string>("ALL");
  const [payouts, setPayouts] = useState<AdminPayout[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reconciliation state
  const [reconciliation, setReconciliation] = useState<AdminPayoutReconciliationResponse | null>(null);
  const [reconLoading, setReconLoading] = useState(false);

  // Create Payout Dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createHostId, setCreateHostId] = useState("");
  const [hostCompletedBookings, setHostCompletedBookings] = useState<AdminBooking[]>([]);
  const [selectedBookingIds, setSelectedBookingIds] = useState<string[]>([]);
  const [loadingBookings, setLoadingBookings] = useState(false);
  const [isCreatingPayout, setIsCreatingPayout] = useState(false);

  // Mark Paid dialog state
  const [markPaidTarget, setMarkPaidTarget] = useState<AdminPayout | null>(null);
  const [providerRef, setProviderRef] = useState("");
  const [isMarkingPaid, setIsMarkingPaid] = useState(false);

  // Mark Failed dialog state
  const [markFailedTarget, setMarkFailedTarget] = useState<AdminPayout | null>(null);
  const [isMarkingFailed, setIsMarkingFailed] = useState(false);

  const fetchPayouts = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (payoutStatus !== "ALL") params.set("payoutStatus", payoutStatus);
        if (cursor) params.set("cursor", cursor);
        params.set("limit", "20");

        const data = await api<AdminListPayoutsResponse>(`/api/admin/payouts?${params.toString()}`);
        setPayouts(data.items);
        setNextCursor(data.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load payouts");
      } finally {
        setLoading(false);
      }
    },
    [payoutStatus],
  );

  const fetchReconciliation = useCallback(async () => {
    setReconLoading(true);
    try {
      const data = await api<AdminPayoutReconciliationResponse>("/api/admin/payouts/reconciliation");
      setReconciliation(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load reconciliation data");
    } finally {
      setReconLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPayouts();
    fetchReconciliation();
  }, [fetchPayouts, fetchReconciliation]);

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, nextCursor]);
    fetchPayouts(nextCursor);
  };

  const handleResetFilters = () => {
    setPayoutStatus("ALL");
    setCursorHistory([]);
  };

  // When Host ID is specified in Create Payout, fetch their COMPLETED bookings
  const handleHostIdBlur = async (hostId: string) => {
    const trimmed = hostId.trim();
    if (!trimmed) return;
    setLoadingBookings(true);
    try {
      const res = await api<AdminListBookingsResponse>(
        `/api/admin/bookings?bookingStatus=COMPLETED&limit=50`,
      );
      // Filter bookings belonging to this host
      const hostBookings = res.items.filter((b) => b.hostId === trimmed);
      setHostCompletedBookings(hostBookings);
      // Default to selecting all completed bookings
      setSelectedBookingIds(hostBookings.map((b) => b.id));
    } catch {
      toast.error("Could not load host bookings");
    } finally {
      setLoadingBookings(false);
    }
  };

  const handleOpenCreateForHost = (hostId: string) => {
    setCreateHostId(hostId);
    setCreateDialogOpen(true);
    handleHostIdBlur(hostId);
  };

  const handleCreatePayoutSubmit = async (reason: string) => {
    if (!createHostId.trim()) {
      toast.error("Host ID is required.");
      throw new Error("Host ID is required");
    }
    if (selectedBookingIds.length === 0) {
      toast.error("Select at least one booking to claim in this payout.");
      throw new Error("No bookings selected");
    }

    setIsCreatingPayout(true);
    try {
      const body: AdminCreatePayoutBody = {
        hostId: createHostId.trim(),
        bookingIds: selectedBookingIds,
        reason,
      };

      await api("/api/admin/payouts", {
        method: "POST",
        body,
        headers: { "idempotency-key": newIdempotencyKey() },
      });

      toast.success("Payout created in PENDING status.");
      setCreateDialogOpen(false);
      setCreateHostId("");
      setSelectedBookingIds([]);
      fetchPayouts();
      fetchReconciliation();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create payout");
      throw err;
    } finally {
      setIsCreatingPayout(false);
    }
  };

  const handleMarkPaidSubmit = async (reason: string) => {
    if (!markPaidTarget) return;
    if (providerRef.trim().length < 3) {
      toast.error("Provider reference (bank UTR or transfer ID) must be at least 3 characters.");
      throw new Error("Reference required");
    }

    setIsMarkingPaid(true);
    try {
      const body: AdminMarkPayoutPaidBody = {
        providerReference: providerRef.trim(),
        reason,
      };

      await api(`/api/admin/payouts/${markPaidTarget.id}/mark-paid`, {
        method: "POST",
        body,
        headers: { "idempotency-key": newIdempotencyKey() },
      });

      toast.success("Payout marked as PAID.");
      setMarkPaidTarget(null);
      setProviderRef("");
      fetchPayouts();
      fetchReconciliation();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to mark payout paid");
      throw err;
    } finally {
      setIsMarkingPaid(false);
    }
  };

  const handleMarkFailedSubmit = async (reason: string) => {
    if (!markFailedTarget) return;
    setIsMarkingFailed(true);
    try {
      const body: AdminMarkPayoutFailedBody = { reason };

      await api(`/api/admin/payouts/${markFailedTarget.id}/mark-failed`, {
        method: "POST",
        body,
        headers: { "idempotency-key": newIdempotencyKey() },
      });

      toast.success("Payout marked as FAILED and claimed bookings released.");
      setMarkFailedTarget(null);
      fetchPayouts();
      fetchReconciliation();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to mark payout failed");
      throw err;
    } finally {
      setIsMarkingFailed(false);
    }
  };

  const discrepancies = reconciliation?.discrepancies ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Host Payouts & Financial Reconciliation</h2>
          <p className="text-muted-foreground text-sm">
            Create host payouts from payable completed bookings, record bank transfer references (mark-paid), and inspect reconciliation discrepancies (FR-06 / FR-13).
          </p>
        </div>
        <Button
          onClick={() => {
            setCreateHostId("");
            setHostCompletedBookings([]);
            setSelectedBookingIds([]);
            setCreateDialogOpen(true);
          }}
          className="gap-2 shrink-0"
        >
          <PlusCircle className="size-4" />
          <span>Create Payout</span>
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="queue">Payouts Queue ({payouts.length})</TabsTrigger>
          <TabsTrigger value="reconciliation">
            Reconciliation & Payable Hosts
            {discrepancies.length > 0 && (
              <span className="ml-1.5 rounded-full bg-destructive px-1.5 py-0.2 text-[10px] text-destructive-foreground">
                {discrepancies.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Payouts Queue */}
        <TabsContent value="queue" className="space-y-4 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <div className="w-48">
                <Select
                  value={payoutStatus}
                  onValueChange={(val) => {
                    setPayoutStatus(val);
                    setCursorHistory([]);
                  }}
                >
                  <SelectTrigger aria-label="Filter by payout status">
                    <SelectValue placeholder="Payout Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All Statuses</SelectItem>
                    <SelectItem value="PENDING">Pending (Ready to Pay)</SelectItem>
                    <SelectItem value="PAID">Paid</SelectItem>
                    <SelectItem value="FAILED">Failed</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {payoutStatus !== "ALL" && (
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

          {loading ? (
            <LoadingState label="Loading payouts queue..." />
          ) : error ? (
            <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-6 text-center text-destructive">
              <p className="font-semibold">{error}</p>
              <Button variant="outline" onClick={() => fetchPayouts()} className="mt-3">
                Retry
              </Button>
            </div>
          ) : payouts.length === 0 ? (
            <EmptyState
              title="No payouts found"
              body="No host payouts recorded under the selected status filter."
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
                      <TableHead scope="col">Host ID</TableHead>
                      <TableHead scope="col">Amount</TableHead>
                      <TableHead scope="col">Bookings</TableHead>
                      <TableHead scope="col">Status</TableHead>
                      <TableHead scope="col">Provider Reference</TableHead>
                      <TableHead scope="col">Created (IST)</TableHead>
                      <TableHead scope="col" className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payouts.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <div className="font-mono text-xs font-semibold">{p.hostId.slice(0, 8)}...</div>
                          <div className="text-muted-foreground font-mono text-[10px]">{p.id}</div>
                        </TableCell>
                        <TableCell className="font-bold text-xs">
                          {formatINR(p.amount.paise)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {p.bookingCount} bookings
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={p.status} />
                        </TableCell>
                        <TableCell className="text-xs">
                          {p.providerReference ? (
                            <span className="font-mono font-medium">{p.providerReference}</span>
                          ) : p.failureReason ? (
                            <span className="text-destructive font-medium">{p.failureReason}</span>
                          ) : (
                            <span className="text-muted-foreground italic">Awaiting bank transfer</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                          {formatIST(new Date(p.createdAt), "dd MMM yyyy, HH:mm")}
                        </TableCell>
                        <TableCell className="text-right">
                          {p.status === "PENDING" ? (
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-emerald-600 hover:text-emerald-700 hover:border-emerald-600"
                                onClick={() => {
                                  setMarkPaidTarget(p);
                                  setProviderRef("");
                                }}
                              >
                                Mark Paid
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive"
                                onClick={() => setMarkFailedTarget(p)}
                              >
                                Mark Failed
                              </Button>
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-xs">Settled</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Showing {payouts.length} payouts</span>
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
                      fetchPayouts(prevCursor);
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
        </TabsContent>

        {/* Tab 2: Reconciliation & Payable Hosts */}
        <TabsContent value="reconciliation" className="space-y-6 pt-3">
          {/* Discrepancies Alert */}
          {discrepancies.length > 0 ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 space-y-2">
              <div className="flex items-center gap-2 text-destructive font-semibold text-sm">
                <AlertTriangle className="size-4" aria-hidden="true" />
                <span>Reconciliation Discrepancies Detected ({discrepancies.length})</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                The following accounts show ledger discrepancies between calculated host earnings, refunds, and recorded payout sums. Immediate manual review is recommended.
              </p>
              <div className="divide-y rounded-lg border bg-background text-xs">
                {discrepancies.map((d, i) => (
                  <div key={i} className="flex items-center justify-between p-3">
                    <div>
                      <span className="font-mono font-semibold text-destructive">{d.kind}</span>
                      <div className="text-muted-foreground text-[11px]">Host: {d.hostId}</div>
                    </div>
                    <div className="text-right">
                      <div>Expected: <span className="font-bold">{formatINR(d.expectedPaise)}</span></div>
                      <div>Actual: <span className="font-bold text-destructive">{formatINR(d.actualPaise)}</span></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-emerald-700 dark:text-emerald-300 text-xs">
              <CheckCircle className="size-4 shrink-0" aria-hidden="true" />
              <span>All host earnings, platform fees, refunds, and payout ledger rows are 100% reconciled. No discrepancies detected.</span>
            </div>
          )}

          {/* Host Payable Summary Table */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm">Hosts Payable Summary</h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchReconciliation}
                disabled={reconLoading}
                className="gap-1 text-xs"
              >
                <RefreshCw className={`size-3 ${reconLoading ? "animate-spin" : ""}`} />
                <span>Refresh</span>
              </Button>
            </div>

            {reconLoading || !reconciliation ? (
              <LoadingState label="Calculating reconciliation..." />
            ) : reconciliation.hosts.length === 0 ? (
              <p className="text-xs text-muted-foreground">No host balances found.</p>
            ) : (
              <div className="rounded-xl border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Host ID</TableHead>
                      <TableHead scope="col">Host Earnings</TableHead>
                      <TableHead scope="col">Refunds</TableHead>
                      <TableHead scope="col">Paid Out</TableHead>
                      <TableHead scope="col">Outstanding</TableHead>
                      <TableHead scope="col">Payable Now</TableHead>
                      <TableHead scope="col" className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reconciliation.hosts.map((h) => (
                      <TableRow key={h.hostId}>
                        <TableCell className="font-mono text-xs">
                          {h.hostId.slice(0, 8)}...
                        </TableCell>
                        <TableCell className="text-xs font-semibold">
                          {formatINR(h.hostEarningsPaise)}
                        </TableCell>
                        <TableCell className="text-xs text-destructive">
                          {h.hostRefundsPaise > 0 ? `-${formatINR(h.hostRefundsPaise)}` : "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatINR(h.paidOutPaise)}
                        </TableCell>
                        <TableCell className="text-xs font-bold">
                          {formatINR(h.outstandingPaise)}
                        </TableCell>
                        <TableCell className="text-xs font-extrabold text-emerald-600">
                          {formatINR(h.payablePaise)}
                        </TableCell>
                        <TableCell className="text-right">
                          {h.payablePaise > 0 && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs"
                              onClick={() => handleOpenCreateForHost(h.hostId)}
                            >
                              Create Payout
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Create Payout Dialog */}
      <ActionDialog
        open={createDialogOpen}
        onOpenChange={(open) => !open && setCreateDialogOpen(false)}
        title="Create Host Payout"
        description="Select completed payable bookings for this host. Total payout amount is strictly computed server-side from ledger net earnings."
        confirmLabel="Create Payout Batch"
        isSubmitting={isCreatingPayout}
        reasonLabel="Payout Batch Reason (Required)"
        reasonPlaceholder="e.g. Weekly host payout settlement for completed bookings..."
        onConfirm={handleCreatePayoutSubmit}
      >
        <div className="space-y-4 pt-2 text-xs">
          <div className="space-y-1.5">
            <Label htmlFor="create-host-id">Host User ID (UUID)</Label>
            <div className="flex gap-2">
              <Input
                id="create-host-id"
                value={createHostId}
                onChange={(e) => setCreateHostId(e.target.value)}
                onBlur={(e) => handleHostIdBlur(e.target.value)}
                placeholder="Enter host UUID..."
                required
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => handleHostIdBlur(createHostId)}
                disabled={loadingBookings}
              >
                Fetch Bookings
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Select Completed Bookings to Claim ({selectedBookingIds.length}/{hostCompletedBookings.length})</Label>
              {hostCompletedBookings.length > 0 && (
                <button
                  type="button"
                  className="text-primary hover:underline text-[11px]"
                  onClick={() => {
                    if (selectedBookingIds.length === hostCompletedBookings.length) {
                      setSelectedBookingIds([]);
                    } else {
                      setSelectedBookingIds(hostCompletedBookings.map((b) => b.id));
                    }
                  }}
                >
                  {selectedBookingIds.length === hostCompletedBookings.length ? "Deselect All" : "Select All"}
                </button>
              )}
            </div>

            {loadingBookings ? (
              <p className="text-muted-foreground italic">Fetching eligible bookings...</p>
            ) : hostCompletedBookings.length === 0 ? (
              <p className="text-muted-foreground italic">
                {createHostId ? "No completed bookings found for this host ID." : "Enter a host ID to find eligible bookings."}
              </p>
            ) : (
              <div className="max-h-48 overflow-y-auto divide-y rounded-lg border bg-background">
                {hostCompletedBookings.map((b) => {
                  const isChecked = selectedBookingIds.includes(b.id);
                  return (
                    <label
                      key={b.id}
                      className="flex items-center justify-between p-2.5 hover:bg-muted/40 cursor-pointer"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedBookingIds([...selectedBookingIds, b.id]);
                            } else {
                              setSelectedBookingIds(selectedBookingIds.filter((id) => id !== b.id));
                            }
                          }}
                          className="size-4"
                        />
                        <div>
                          <div className="font-semibold">{b.listing.title}</div>
                          <div className="text-[10px] text-muted-foreground font-mono">{b.code || b.id.slice(0, 8)}</div>
                        </div>
                      </div>
                      <span className="font-bold text-foreground">
                        {formatINR(b.pricing.hostEarnings ? b.pricing.hostEarnings.paise : b.pricing.total.paise)}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </ActionDialog>

      {/* Mark Paid Dialog */}
      <ActionDialog
        open={Boolean(markPaidTarget)}
        onOpenChange={(open) => !open && setMarkPaidTarget(null)}
        title={`Record Bank Payout: ${markPaidTarget ? formatINR(markPaidTarget.amount.paise) : ""}`}
        description="Record the external banking reference (IMPS / NEFT UTR or gateway transfer ID) after sending funds to the host."
        confirmLabel="Record Paid Reference"
        isSubmitting={isMarkingPaid}
        reasonLabel="Settlement Audit Reason (Required)"
        reasonPlaceholder="e.g. HDFC Bank IMPS transfer processed successfully..."
        onConfirm={handleMarkPaidSubmit}
      >
        <div className="space-y-1.5 pt-2 text-xs">
          <Label htmlFor="provider-ref">Banking Provider Reference / UTR Number</Label>
          <Input
            id="provider-ref"
            value={providerRef}
            onChange={(e) => setProviderRef(e.target.value)}
            placeholder="e.g. UTR123456789 or BANK-TXN-9876"
            required
          />
        </div>
      </ActionDialog>

      {/* Mark Failed Dialog */}
      <ActionDialog
        open={Boolean(markFailedTarget)}
        onOpenChange={(open) => !open && setMarkFailedTarget(null)}
        title={`Mark Payout Failed: ${markFailedTarget ? formatINR(markFailedTarget.amount.paise) : ""}`}
        description="Marking a payout as FAILED will immediately release its claimed bookings, allowing them to be grouped and re-attempted in a future payout batch."
        confirmLabel="Mark Failed & Release Bookings"
        variant="destructive"
        isSubmitting={isMarkingFailed}
        reasonLabel="Failure Audit Reason (Required)"
        reasonPlaceholder="e.g. Beneficiary IFSC invalid / Bank transfer bounced back..."
        onConfirm={handleMarkFailedSubmit}
      />
    </div>
  );
}
