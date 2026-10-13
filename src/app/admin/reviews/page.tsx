"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import {
  Star,
  CheckCircle,
  XCircle,
  RotateCcw,
} from "lucide-react";
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
import { StatusBadge } from "@/components/admin/status-badge";
import { ActionDialog } from "@/components/admin/action-dialog";
import { EmptyState } from "@/components/common/empty-state";
import { LoadingState } from "@/components/common/loading-state";
import { api } from "@/lib/api-client";
import { formatIST } from "@/lib/time";
import type {
  AdminReview,
  AdminListReviewsResponse,
  AdminModerateReviewBody,
} from "@/contracts";

export default function AdminReviewsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading reviews..." />}>
      <ReviewsContent />
    </Suspense>
  );
}

function ReviewsContent() {
  const [moderationStatus, setModerationStatus] = useState<string>("ALL");
  const [reviews, setReviews] = useState<AdminReview[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Moderate dialog state
  const [moderateTarget, setModerateTarget] = useState<AdminReview | null>(null);
  const [moderateDecision, setModerateDecision] = useState<"APPROVED" | "REJECTED">("APPROVED");
  const [isModerating, setIsModerating] = useState(false);

  const fetchReviews = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (moderationStatus !== "ALL") params.set("moderationStatus", moderationStatus);
        if (cursor) params.set("cursor", cursor);
        params.set("limit", "20");

        const data = await api<AdminListReviewsResponse>(`/api/admin/reviews?${params.toString()}`);
        setReviews(data.items);
        setNextCursor(data.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load reviews");
      } finally {
        setLoading(false);
      }
    },
    [moderationStatus],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    fetchReviews();
  }, [fetchReviews]);

  const handleResetFilters = () => {
    setModerationStatus("ALL");
    setCursorHistory([]);
  };

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, nextCursor]);
    fetchReviews(nextCursor);
  };

  const handleOpenModerate = (review: AdminReview, decision: "APPROVED" | "REJECTED") => {
    setModerateTarget(review);
    setModerateDecision(decision);
  };

  const handleModerateSubmit = async (reason: string) => {
    if (!moderateTarget) return;
    setIsModerating(true);
    try {
      const body: AdminModerateReviewBody = {
        decision: moderateDecision,
        reason,
      };

      await api(`/api/admin/reviews/${moderateTarget.id}/moderate`, "POST", body);

      toast.success(
        moderateDecision === "APPROVED"
          ? "Review approved and published to listing."
          : "Review rejected and suppressed from listing.",
      );
      setModerateTarget(null);
      fetchReviews();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to moderate review");
      throw err;
    } finally {
      setIsModerating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Review Moderation Queue</h2>
          <p className="text-muted-foreground text-sm">
            Moderate submitted reviews with comments before publication. Approve clean feedback or reject abusive content with required audit reasons (FR-11 / FR-13).
          </p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2">
          <div className="w-52">
            <Select
              value={moderationStatus}
              onValueChange={(val) => {
                if (val) {
                  setModerationStatus(val);
                  setCursorHistory([]);
                }
              }}
            >
              <SelectTrigger aria-label="Filter by moderation status">
                <SelectValue placeholder="Moderation Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Statuses</SelectItem>
                <SelectItem value="PENDING">Pending Moderation</SelectItem>
                <SelectItem value="APPROVED">Approved</SelectItem>
                <SelectItem value="REJECTED">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {moderationStatus !== "ALL" && (
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

      {/* Reviews table */}
      {loading ? (
        <LoadingState label="Loading review moderation queue..." />
      ) : error ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-6 text-center text-destructive">
          <p className="font-semibold">{error}</p>
          <Button variant="outline" onClick={() => fetchReviews()} className="mt-3">
            Retry
          </Button>
        </div>
      ) : reviews.length === 0 ? (
        <EmptyState
          title="No reviews in moderation queue"
          body="All submitted reviews have been moderated or filter returned zero results."
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
                  <TableHead scope="col">Listing</TableHead>
                  <TableHead scope="col">Reviewer</TableHead>
                  <TableHead scope="col">Rating</TableHead>
                  <TableHead scope="col">Comment</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Submitted At (IST)</TableHead>
                  <TableHead scope="col" className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reviews.map((rev) => (
                  <TableRow key={rev.id}>
                    <TableCell>
                      <div className="font-medium text-xs">{rev.listingTitle}</div>
                      <div className="text-muted-foreground font-mono text-[10px]">
                        Booking: {rev.bookingId.slice(0, 8)}...
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {rev.reviewerFirstName || "Anonymous"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 text-xs font-semibold">
                        <span>{rev.rating}</span>
                        <Star className="size-3 fill-amber-400 text-amber-500" aria-hidden="true" />
                      </div>
                    </TableCell>
                    <TableCell className="max-w-xs text-xs">
                      {rev.comment ? (
                        <p className="line-clamp-2">{rev.comment}</p>
                      ) : (
                        <span className="text-muted-foreground italic">No comment (rating only)</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={rev.moderationStatus} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {formatIST(new Date(rev.createdAt), "dd MMM yyyy, HH:mm")}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-emerald-600 hover:text-emerald-700"
                          onClick={() => handleOpenModerate(rev, "APPROVED")}
                          title="Approve Review"
                          aria-label={`Approve review for ${rev.listingTitle}`}
                        >
                          <CheckCircle className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => handleOpenModerate(rev, "REJECTED")}
                          title="Reject Review"
                          aria-label={`Reject review for ${rev.listingTitle}`}
                        >
                          <XCircle className="size-4" />
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
            <span>Showing {reviews.length} reviews</span>
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
                  fetchReviews(prevCursor);
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

      {/* Moderate Action Dialog */}
      <ActionDialog
        open={Boolean(moderateTarget)}
        onOpenChange={(open) => !open && setModerateTarget(null)}
        title={
          moderateDecision === "APPROVED"
            ? `Approve Review: ${moderateTarget?.listingTitle}`
            : `Reject Review: ${moderateTarget?.listingTitle}`
        }
        description={
          moderateDecision === "APPROVED"
            ? "Approving this review will publish it immediately to the public listing page and factor its rating into the listing's average score."
            : "Rejecting this review suppresses it from public display. The rating will not be factored into the listing's public score."
        }
        confirmLabel={moderateDecision === "APPROVED" ? "Approve & Publish" : "Reject Review"}
        variant={moderateDecision === "APPROVED" ? "default" : "destructive"}
        isSubmitting={isModerating}
        reasonLabel="Moderation Audit Reason (Required)"
        reasonPlaceholder="e.g. Content adheres to community guidelines / Contains profanity or personal attacks..."
        onConfirm={handleModerateSubmit}
      >
        {moderateTarget?.comment && (
          <div className="rounded-lg border bg-muted/30 p-3 text-xs space-y-1">
            <span className="font-semibold text-muted-foreground">Review Content:</span>
            <p className="italic">&ldquo;{moderateTarget.comment}&rdquo;</p>
          </div>
        )}
      </ActionDialog>
    </div>
  );
}
