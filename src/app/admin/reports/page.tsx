"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import {
  RotateCcw,
  ExternalLink,
} from "lucide-react";
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
import { StatusBadge } from "@/components/admin/status-badge";
import { ActionDialog } from "@/components/admin/action-dialog";
import { EmptyState } from "@/components/common/empty-state";
import { LoadingState } from "@/components/common/loading-state";
import { api } from "@/lib/api-client";
import { formatIST } from "@/lib/time";
import type {
  AdminReport,
  AdminListReportsResponse,
  AdminResolveReportBody,
} from "@/contracts";

export default function AdminReportsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading reports..." />}>
      <ReportsContent />
    </Suspense>
  );
}

function ReportsContent() {
  const [reportStatus, setReportStatus] = useState<string>("ALL");
  const [targetType, setTargetType] = useState<string>("ALL");
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Resolve dialog state
  const [resolveTarget, setResolveTarget] = useState<AdminReport | null>(null);
  const [resolveAction, setResolveAction] = useState<"DISMISS" | "ACTION">("ACTION");
  const [resolutionText, setResolutionText] = useState("");
  const [isResolving, setIsResolving] = useState(false);

  const fetchReports = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (reportStatus !== "ALL") params.set("status", reportStatus);
        if (targetType !== "ALL") params.set("targetType", targetType);
        if (cursor) params.set("cursor", cursor);
        params.set("limit", "20");

        const data = await api<AdminListReportsResponse>(`/api/admin/reports?${params.toString()}`);
        setReports(data.items);
        setNextCursor(data.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load reports");
      } finally {
        setLoading(false);
      }
    },
    [reportStatus, targetType],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    fetchReports();
  }, [fetchReports]);

  const handleResetFilters = () => {
    setReportStatus("ALL");
    setTargetType("ALL");
    setCursorHistory([]);
  };

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, nextCursor]);
    fetchReports(nextCursor);
  };

  const handleOpenResolveDialog = (report: AdminReport) => {
    setResolveTarget(report);
    setResolveAction("ACTION");
    setResolutionText("");
  };

  const handleResolveSubmit = async (reason: string) => {
    if (!resolveTarget) return;
    if (resolutionText.trim().length < 3) {
      toast.error("Resolution must be at least 3 characters.");
      throw new Error("Resolution must be at least 3 characters.");
    }

    setIsResolving(true);
    try {
      const body: AdminResolveReportBody = {
        action: resolveAction,
        resolution: resolutionText.trim(),
        reason,
      };

      await api(`/api/admin/reports/${resolveTarget.id}/resolve`, "POST", body);

      toast.success(
        resolveAction === "ACTION"
          ? "Report actioned and disciplinary measure recorded."
          : "Report dismissed without further action.",
      );
      setResolveTarget(null);
      fetchReports();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resolve report");
      throw err;
    } finally {
      setIsResolving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Reports Moderation Queue</h2>
          <p className="text-muted-foreground text-sm">
            Review user-submitted reports for fraud, inaccuracies, or safety issues. Take corrective action or dismiss with audit reasons (FR-11 / FR-13).
          </p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-48">
            <Select
              value={reportStatus}
              onValueChange={(val) => {
                if (val) {
                  setReportStatus(val);
                  setCursorHistory([]);
                }
              }}
            >
              <SelectTrigger aria-label="Filter by report status">
                <SelectValue placeholder="Report Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Statuses</SelectItem>
                <SelectItem value="OPEN">Open Reports</SelectItem>
                <SelectItem value="RESOLVED">Resolved (Actioned)</SelectItem>
                <SelectItem value="DISMISSED">Dismissed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="w-48">
            <Select
              value={targetType}
              onValueChange={(val) => {
                if (val) {
                  setTargetType(val);
                  setCursorHistory([]);
                }
              }}
            >
              <SelectTrigger aria-label="Filter by target type">
                <SelectValue placeholder="Target Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Targets</SelectItem>
                <SelectItem value="LISTING">Listing</SelectItem>
                <SelectItem value="USER">User</SelectItem>
                <SelectItem value="BOOKING">Booking</SelectItem>
                <SelectItem value="REVIEW">Review</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(reportStatus !== "ALL" || targetType !== "ALL") && (
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

      {/* Reports table */}
      {loading ? (
        <LoadingState label="Loading reports queue..." />
      ) : error ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-6 text-center text-destructive">
          <p className="font-semibold">{error}</p>
          <Button variant="outline" onClick={() => fetchReports()} className="mt-3">
            Retry
          </Button>
        </div>
      ) : reports.length === 0 ? (
        <EmptyState
          title="No reports in queue"
          body="All user and listing reports have been resolved or dismissed."
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
                  <TableHead scope="col">Target</TableHead>
                  <TableHead scope="col">Reason & Description</TableHead>
                  <TableHead scope="col">Evidence</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Filed At (IST)</TableHead>
                  <TableHead scope="col" className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reports.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <span className="font-mono text-xs font-semibold">{r.targetType}</span>
                      <div className="font-mono text-[10px] text-muted-foreground">{r.targetId.slice(0, 8)}...</div>
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <div className="font-semibold text-xs">{r.reason.replace(/_/g, " ")}</div>
                      <p className="text-muted-foreground text-xs line-clamp-2">{r.description}</p>
                      {r.resolution && (
                        <div className="mt-1 text-[10px] text-primary">
                          <strong>Resolution:</strong> {r.resolution}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {r.evidenceUrls.length > 0 ? (
                        <div className="flex flex-col gap-1">
                          {r.evidenceUrls.map((url, i) => (
                            <a
                              key={url}
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline flex items-center gap-1 text-[11px]"
                            >
                              <span>Evidence #{i + 1}</span>
                              <ExternalLink className="size-3" aria-hidden="true" />
                            </a>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {formatIST(new Date(r.createdAt), "dd MMM yyyy, HH:mm")}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.status === "OPEN" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleOpenResolveDialog(r)}
                        >
                          Resolve
                        </Button>
                      ) : (
                        <span className="text-muted-foreground text-xs">Resolved</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Showing {reports.length} reports</span>
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
                  fetchReports(prevCursor);
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

      {/* Resolve Report Action Dialog */}
      <ActionDialog
        open={Boolean(resolveTarget)}
        onOpenChange={(open) => !open && setResolveTarget(null)}
        title={`Resolve Report: ${resolveTarget?.targetType} (${resolveTarget?.reason.replace(/_/g, " ")})`}
        description={
          resolveAction === "ACTION" && resolveTarget?.targetType === "LISTING"
            ? "Choosing ACTION will automatically suspend the reported listing and update the report status to RESOLVED."
            : "Review report findings and specify corrective actions or dismiss without violation."
        }
        confirmLabel={resolveAction === "ACTION" ? "Apply Disciplinary Action" : "Dismiss Report"}
        variant={resolveAction === "ACTION" ? "destructive" : "default"}
        isSubmitting={isResolving}
        reasonLabel="Administrative Audit Reason (Required)"
        reasonPlaceholder="Document the moderation findings and policy criteria applied..."
        onConfirm={handleResolveSubmit}
      >
        <div className="space-y-3 pt-2 text-xs">
          <div className="space-y-1.5">
            <Label htmlFor="report-action">Action Decision</Label>
            <Select
              value={resolveAction}
              onValueChange={(val) => {
                if (val === "DISMISS" || val === "ACTION") setResolveAction(val);
              }}
            >
              <SelectTrigger id="report-action">
                <SelectValue placeholder="Select decision" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTION">Take Disciplinary Action (ACTION)</SelectItem>
                <SelectItem value="DISMISS">Dismiss Report (DISMISS)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="report-resolution">Resolution Summary</Label>
            <Textarea
              id="report-resolution"
              value={resolutionText}
              onChange={(e) => setResolutionText(e.target.value)}
              placeholder="e.g. Investigation confirmed false address; suspended listing and warned host..."
              rows={2}
              required
            />
          </div>
        </div>
      </ActionDialog>
    </div>
  );
}
