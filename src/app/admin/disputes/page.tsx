"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Eye,
  CheckCircle,
  XCircle,
  Clock,
  RotateCcw,
  IndianRupee,
  FileText,
  Shield,
  Calendar,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
import { api } from "@/lib/api-client";
import { formatINR, rupeesToPaise } from "@/lib/money";
import { formatIST } from "@/lib/time";
import type {
  AdminDispute,
  AdminDisputeDetail,
  AdminListDisputesResponse,
  AdminResolveDisputeBody,
} from "@/contracts";

export default function AdminDisputesPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading disputes..." />}>
      <DisputesContent />
    </Suspense>
  );
}

function DisputesContent() {
  const [disputeStatus, setDisputeStatus] = useState<string>("ALL");
  const [category, setCategory] = useState<string>("ALL");
  const [disputes, setDisputes] = useState<AdminDispute[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Detail view state
  const [selectedDisputeId, setSelectedDisputeId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminDisputeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Resolve dialog state
  const [resolveTarget, setResolveTarget] = useState<AdminDispute | null>(null);
  const [resolveOutcome, setResolveOutcome] = useState<"RESOLVED" | "REJECTED" | "UNDER_REVIEW">("RESOLVED");
  const [resolutionText, setResolutionText] = useState("");
  const [refundRupees, setRefundRupees] = useState("");
  const [bookingOutcome, setBookingOutcome] = useState<"COMPLETED" | "CANCELLED">("COMPLETED");
  const [isResolving, setIsResolving] = useState(false);

  const fetchDisputes = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (disputeStatus !== "ALL") params.set("disputeStatus", disputeStatus);
        if (category !== "ALL") params.set("category", category);
        if (cursor) params.set("cursor", cursor);
        params.set("limit", "20");

        const data = await api<AdminListDisputesResponse>(`/api/admin/disputes?${params.toString()}`);
        setDisputes(data.items);
        setNextCursor(data.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load disputes");
      } finally {
        setLoading(false);
      }
    },
    [disputeStatus, category],
  );

  useEffect(() => {
    fetchDisputes();
  }, [fetchDisputes]);

  const handleResetFilters = () => {
    setDisputeStatus("ALL");
    setCategory("ALL");
    setCursorHistory([]);
  };

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, nextCursor]);
    fetchDisputes(nextCursor);
  };

  const openDisputeDetail = async (id: string) => {
    setSelectedDisputeId(id);
    setDetailLoading(true);
    try {
      const data = await api<AdminDisputeDetail>(`/api/admin/disputes/${id}`);
      setDetail(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load dispute timeline");
      setSelectedDisputeId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  // Compute refundable cap from detail or target booking payments
  const calculateRefundCap = (payments?: AdminDisputeDetail["payments"]) => {
    if (!payments) return 0;
    let totalCaptured = 0;
    let totalRefunded = 0;

    for (const p of payments) {
      if (p.status === "CAPTURED" || p.status === "PARTIALLY_REFUNDED") {
        totalCaptured += p.amount.paise;
      }
      for (const r of p.refunds) {
        if (r.status !== "FAILED") {
          totalRefunded += r.amount.paise;
        }
      }
    }
    return Math.max(0, totalCaptured - totalRefunded);
  };

  const handleOpenResolveDialog = async (dispute: AdminDispute) => {
    setResolveTarget(dispute);
    setResolveOutcome("RESOLVED");
    setResolutionText("");
    setRefundRupees("");
    setBookingOutcome("COMPLETED");

    // Fetch dispute details if not already loaded to know exact refund cap
    if (!detail || detail.id !== dispute.id) {
      try {
        const full = await api<AdminDisputeDetail>(`/api/admin/disputes/${dispute.id}`);
        setDetail(full);
      } catch {
        // fallback
      }
    }
  };

  const handleResolveSubmit = async (reason: string) => {
    if (!resolveTarget) return;
    if (resolutionText.trim().length < 3) {
      toast.error("Resolution explanation must be at least 3 characters.");
      throw new Error("Resolution explanation must be at least 3 characters.");
    }

    let refundPaise: number | undefined = undefined;
    if (refundRupees.trim()) {
      const parsedRupees = parseFloat(refundRupees);
      if (isNaN(parsedRupees) || parsedRupees <= 0) {
        toast.error("Please enter a valid positive refund amount.");
        throw new Error("Invalid refund amount");
      }
      refundPaise = rupeesToPaise(parsedRupees);
      const cap = calculateRefundCap(detail?.payments);
      if (cap > 0 && refundPaise > cap) {
        toast.error(`Refund amount cannot exceed captured limit of ${formatINR(cap)}`);
        throw new Error("Refund exceeds cap");
      }
    }

    setIsResolving(true);
    try {
      const body: AdminResolveDisputeBody = {
        outcome: resolveOutcome,
        resolution: resolutionText.trim(),
        reason,
        refundPaise,
        bookingOutcome: resolveOutcome !== "UNDER_REVIEW" ? bookingOutcome : undefined,
      };

      await api(`/api/admin/disputes/${resolveTarget.id}/resolve`, "POST", body);

      toast.success(`Dispute updated to ${resolveOutcome}.`);
      setResolveTarget(null);
      fetchDisputes();
      if (selectedDisputeId === resolveTarget.id) {
        openDisputeDetail(resolveTarget.id);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resolve dispute");
      throw err;
    } finally {
      setIsResolving(false);
    }
  };

  const refundCap = calculateRefundCap(detail?.payments);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Disputes Queue & Resolution</h2>
          <p className="text-muted-foreground text-sm">
            Review reported booking disputes, inspect full support timelines, issue capped refunds, and record audit resolutions (FR-10 / FR-13).
          </p>
        </div>
      </div>

      {/* Filters bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-48">
            <Select
              value={disputeStatus}
              onValueChange={(val) => {
                setDisputeStatus(val);
                setCursorHistory([]);
              }}
            >
              <SelectTrigger aria-label="Filter by dispute status">
                <SelectValue placeholder="Dispute Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Statuses</SelectItem>
                <SelectItem value="OPEN">Open</SelectItem>
                <SelectItem value="UNDER_REVIEW">Under Review</SelectItem>
                <SelectItem value="RESOLVED">Resolved</SelectItem>
                <SelectItem value="REJECTED">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="w-52">
            <Select
              value={category}
              onValueChange={(val) => {
                setCategory(val);
                setCursorHistory([]);
              }}
            >
              <SelectTrigger aria-label="Filter by category">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Categories</SelectItem>
                <SelectItem value="ACCESS_ISSUE">Access Issue</SelectItem>
                <SelectItem value="SPACE_UNAVAILABLE">Space Unavailable</SelectItem>
                <SelectItem value="OVERSTAY">Overstay</SelectItem>
                <SelectItem value="PROPERTY_DAMAGE">Property Damage</SelectItem>
                <SelectItem value="INCORRECT_CHARGES">Incorrect Charges</SelectItem>
                <SelectItem value="OTHER">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(disputeStatus !== "ALL" || category !== "ALL") && (
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

      {/* Disputes table */}
      {loading ? (
        <LoadingState label="Loading disputes..." />
      ) : error ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-6 text-center text-destructive">
          <p className="font-semibold">{error}</p>
          <Button variant="outline" onClick={() => fetchDisputes()} className="mt-3">
            Retry
          </Button>
        </div>
      ) : disputes.length === 0 ? (
        <EmptyState
          title="No disputes in queue"
          body="All reported disputes have been resolved or filter returned zero results."
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
                  <TableHead scope="col">Dispute / Booking</TableHead>
                  <TableHead scope="col">Category</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Amount</TableHead>
                  <TableHead scope="col">Filed At</TableHead>
                  <TableHead scope="col" className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {disputes.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <div className="font-semibold text-xs">{d.booking.listing.title}</div>
                      <div className="text-muted-foreground font-mono text-[10px]">
                        Booking: {d.booking.code || d.booking.id.slice(0, 8)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{d.category.replace(/_/g, " ")}</span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={d.status} />
                    </TableCell>
                    <TableCell className="font-semibold text-xs">
                      {formatINR(d.booking.pricing.total.paise)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {formatIST(new Date(d.createdAt), "dd MMM yyyy, HH:mm")}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openDisputeDetail(d.id)}
                          aria-label={`View timeline for dispute ${d.id}`}
                        >
                          <Eye className="size-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleOpenResolveDialog(d)}
                        >
                          Resolve
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Showing {disputes.length} disputes</span>
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
                  fetchDisputes(prevCursor);
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

      {/* Dispute Detail & Timeline Dialog (FR-10 support timeline) */}
      <Dialog open={Boolean(selectedDisputeId)} onOpenChange={(open) => !open && setSelectedDisputeId(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Dispute Support Timeline</DialogTitle>
            <DialogDescription>
              Chronological history of booking session events, payments, notifications, and administrative audit trail (FR-10).
            </DialogDescription>
          </DialogHeader>

          {detailLoading || !detail ? (
            <LoadingState label="Loading timeline..." />
          ) : (
            <div className="space-y-6 text-xs">
              <div className="rounded-xl border bg-muted/40 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-sm">Dispute: {detail.category.replace(/_/g, " ")}</h3>
                    <p className="text-muted-foreground">{detail.reason}</p>
                  </div>
                  <StatusBadge status={detail.status} />
                </div>
                <div className="grid grid-cols-2 gap-2 text-muted-foreground pt-1 border-t">
                  <div>Dispute ID: <span className="font-mono text-foreground">{detail.id}</span></div>
                  <div>Booking: <span className="font-mono text-foreground">{detail.booking.code || detail.booking.id}</span></div>
                  <div>Initiated By: <span className="font-mono text-foreground">{detail.initiatorId}</span></div>
                  <div>Filed At: <span className="text-foreground">{formatIST(new Date(detail.createdAt), "dd MMM yyyy, HH:mm")}</span></div>
                </div>
                {detail.resolution && (
                  <div className="mt-2 rounded bg-background p-2 border">
                    <strong>Resolution:</strong> {detail.resolution}
                  </div>
                )}
              </div>

              {/* Timeline tabs */}
              <Tabs defaultValue="payments">
                <TabsList className="grid grid-cols-3 w-full">
                  <TabsTrigger value="payments">Payments & Refunds ({detail.payments.length})</TabsTrigger>
                  <TabsTrigger value="notifications">Notifications ({detail.notifications.length})</TabsTrigger>
                  <TabsTrigger value="audit">Audit Log ({detail.auditLog.length})</TabsTrigger>
                </TabsList>

                {/* Payments tab */}
                <TabsContent value="payments" className="space-y-3 pt-3">
                  {detail.payments.length === 0 ? (
                    <p className="text-muted-foreground">No payment records found.</p>
                  ) : (
                    detail.payments.map((p) => (
                      <div key={p.id} className="rounded-lg border p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold">{p.provider} ({p.providerOrderId})</span>
                          <StatusBadge status={p.status} />
                        </div>
                        <div className="flex items-center justify-between text-muted-foreground">
                          <span>Amount: <strong className="text-foreground">{formatINR(p.amount.paise)}</strong></span>
                          <span>Reconciled: {p.reconciledAt ? formatIST(new Date(p.reconciledAt), "dd MMM, HH:mm") : "Unreconciled"}</span>
                        </div>
                        {p.refunds.length > 0 && (
                          <div className="mt-2 pt-2 border-t space-y-1">
                            <span className="font-semibold">Refunds Issued:</span>
                            {p.refunds.map((r) => (
                              <div key={r.id} className="flex items-center justify-between bg-muted/40 p-2 rounded">
                                <span>{r.reason}</span>
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

                {/* Notifications tab */}
                <TabsContent value="notifications" className="space-y-2 pt-3">
                  {detail.notifications.length === 0 ? (
                    <p className="text-muted-foreground">No alerts dispatched.</p>
                  ) : (
                    detail.notifications.map((n) => (
                      <div key={n.id} className="flex items-center justify-between rounded-lg border p-2.5">
                        <div>
                          <div className="font-semibold">{n.type}</div>
                          <div className="text-muted-foreground text-[10px]">Recipient: {n.userId.slice(0, 8)}...</div>
                        </div>
                        <div className="text-right">
                          <StatusBadge status={n.status} />
                          <div className="text-muted-foreground text-[10px] mt-0.5">
                            {n.sentAt ? formatIST(new Date(n.sentAt), "dd MMM, HH:mm") : "Pending"}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </TabsContent>

                {/* Audit tab */}
                <TabsContent value="audit" className="space-y-2 pt-3">
                  {detail.auditLog.length === 0 ? (
                    <p className="text-muted-foreground">No audit entries.</p>
                  ) : (
                    detail.auditLog.map((a) => (
                      <div key={a.id} className="rounded-lg border p-2.5 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-semibold text-primary">{a.action}</span>
                          <span className="text-muted-foreground">
                            {formatIST(new Date(a.createdAt), "dd MMM yyyy, HH:mm:ss")}
                          </span>
                        </div>
                        <p className="text-muted-foreground">Reason: {a.reason || "None recorded"}</p>
                        <div className="text-[10px] text-muted-foreground">
                          Actor: {a.actorId || "System"} | Target: {a.targetType} ({a.targetId || "—"})
                        </div>
                      </div>
                    ))
                  )}
                </TabsContent>
              </Tabs>

              <div className="flex justify-end pt-2 border-t">
                <Button
                  onClick={() => {
                    setSelectedDisputeId(null);
                    handleOpenResolveDialog(detail);
                  }}
                >
                  Resolve This Dispute
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Resolve Dispute Action Dialog */}
      <ActionDialog
        open={Boolean(resolveTarget)}
        onOpenChange={(open) => !open && setResolveTarget(null)}
        title={`Resolve Dispute: ${resolveTarget?.booking.listing.title}`}
        description="Determine the outcome of the dispute, specify a resolution note, and optionally refund the renter up to the captured payment cap."
        confirmLabel="Submit Resolution"
        isSubmitting={isResolving}
        reasonLabel="Administrative Audit Reason (Required)"
        reasonPlaceholder="Document the investigation findings and rationale for this resolution..."
        onConfirm={handleResolveSubmit}
      >
        <div className="space-y-4 pt-2 text-xs">
          {/* Outcome selection */}
          <div className="space-y-1.5">
            <Label htmlFor="dispute-outcome">Dispute Outcome</Label>
            <Select
              value={resolveOutcome}
              onValueChange={(val: "RESOLVED" | "REJECTED" | "UNDER_REVIEW") => setResolveOutcome(val)}
            >
              <SelectTrigger id="dispute-outcome">
                <SelectValue placeholder="Select outcome" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="RESOLVED">Resolved in Renter's Favor (RESOLVED)</SelectItem>
                <SelectItem value="REJECTED">Dismiss Dispute (REJECTED)</SelectItem>
                <SelectItem value="UNDER_REVIEW">Keep Under Review (UNDER_REVIEW)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Resolution text */}
          <div className="space-y-1.5">
            <Label htmlFor="dispute-resolution">Resolution Summary (visible to parties)</Label>
            <Textarea
              id="dispute-resolution"
              value={resolutionText}
              onChange={(e) => setResolutionText(e.target.value)}
              placeholder="e.g. Host agreed space was inaccessible; issued full refund for unused time..."
              rows={2}
              required
            />
          </div>

          {/* Refund Input with cap */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="dispute-refund">Optional Refund (₹)</Label>
              <span className="text-muted-foreground text-[11px]">
                Refundable Cap: <strong className="text-foreground">{formatINR(refundCap)}</strong>
              </span>
            </div>
            <Input
              id="dispute-refund"
              type="number"
              step="1"
              min="0"
              placeholder="0 (leave empty for no refund)"
              value={refundRupees}
              onChange={(e) => setRefundRupees(e.target.value)}
            />
          </div>

          {/* Booking Outcome (required if closing dispute) */}
          {resolveOutcome !== "UNDER_REVIEW" && (
            <div className="space-y-1.5">
              <Label htmlFor="dispute-booking-outcome">Target Booking Outcome</Label>
              <Select
                value={bookingOutcome}
                onValueChange={(val: "COMPLETED" | "CANCELLED") => setBookingOutcome(val)}
              >
                <SelectTrigger id="dispute-booking-outcome">
                  <SelectValue placeholder="Target booking status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="COMPLETED">Mark Booking COMPLETED</SelectItem>
                  <SelectItem value="CANCELLED">Mark Booking CANCELLED</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </ActionDialog>
    </div>
  );
}
