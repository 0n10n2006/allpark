"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  CheckCircle,
  XCircle,
  RotateCcw,
  ExternalLink,
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
  AdminPhoto,
  AdminListPhotosResponse,
  AdminModeratePhotoBody,
} from "@/contracts";

export default function AdminPhotosPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading photo moderation queue..." />}>
      <PhotosContent />
    </Suspense>
  );
}

function PhotosContent() {
  const searchParams = useSearchParams();
  const initialStatus = searchParams.get("status") ?? "PENDING";
  const initialListingId = searchParams.get("listingId") ?? "";

  const [moderationStatus, setModerationStatus] = useState<string>(initialStatus);
  const [listingId, setListingId] = useState<string>(initialListingId);
  const [photos, setPhotos] = useState<AdminPhoto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Moderate dialog state
  const [moderateTarget, setModerateTarget] = useState<AdminPhoto | null>(null);
  const [moderateDecision, setModerateDecision] = useState<"APPROVED" | "REJECTED">("APPROVED");
  const [isModerating, setIsModerating] = useState(false);

  const fetchPhotos = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (moderationStatus && moderationStatus !== "ALL") params.set("status", moderationStatus);
        if (listingId.trim()) params.set("listingId", listingId.trim());
        if (cursor) params.set("cursor", cursor);
        params.set("limit", "20");

        const data = await api<AdminListPhotosResponse>(`/api/admin/photos?${params.toString()}`);
        setPhotos(data.items);
        setNextCursor(data.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load photos");
      } finally {
        setLoading(false);
      }
    },
    [moderationStatus, listingId],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    fetchPhotos();
  }, [fetchPhotos]);

  const handleResetFilters = () => {
    setModerationStatus("PENDING");
    setListingId("");
  };

  const handleNextPage = () => {
    if (!nextCursor) return;
    fetchPhotos(nextCursor);
  };

  const handleOpenModerate = (photo: AdminPhoto, decision: "APPROVED" | "REJECTED") => {
    setModerateTarget(photo);
    setModerateDecision(decision);
  };

  const handleModerateSubmit = async (reason: string) => {
    if (!moderateTarget) return;
    setIsModerating(true);
    try {
      const body: AdminModeratePhotoBody = {
        decision: moderateDecision,
        reason,
      };

      await api(`/api/admin/photos/${moderateTarget.id}/moderate`, "POST", body);

      toast.success(
        moderateDecision === "APPROVED"
          ? "Photo approved and marked visible publicly."
          : "Photo rejected and hidden from public search.",
      );
      setModerateTarget(null);
      fetchPhotos();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to moderate photo");
      throw err;
    } finally {
      setIsModerating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Photo Moderation Queue</h2>
          <p className="text-muted-foreground text-sm">
            Review uploaded listing photos before or after publication. Approve clean photos or reject inappropriate images with required audit reasons (FR-02 / FR-13).
          </p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
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
                <SelectItem value="PENDING">Pending Moderation</SelectItem>
                <SelectItem value="ALL">All Statuses</SelectItem>
                <SelectItem value="APPROVED">Approved</SelectItem>
                <SelectItem value="REJECTED">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {listingId && (
            <div className="flex items-center gap-1.5 rounded-md border bg-muted px-2.5 py-1 text-xs">
              <span className="text-muted-foreground">Listing:</span>
              <span className="font-mono">{listingId.slice(0, 8)}...</span>
              <button
                type="button"
                onClick={() => setListingId("")}
                className="ml-1 text-muted-foreground hover:text-foreground"
                aria-label="Clear listing filter"
              >
                &times;
              </button>
            </div>
          )}

          {(moderationStatus !== "PENDING" || listingId) && (
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

      {/* Photos table */}
      {loading ? (
        <LoadingState label="Loading photo moderation queue..." />
      ) : error ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-6 text-center text-destructive">
          <p className="font-semibold">{error}</p>
          <Button variant="outline" onClick={() => fetchPhotos()} className="mt-3">
            Retry
          </Button>
        </div>
      ) : photos.length === 0 ? (
        <EmptyState
          title="No photos in moderation queue"
          body="All uploaded listing photos have been moderated or filter returned zero results."
          action={
            <Button variant="outline" onClick={handleResetFilters}>
              Clear Filters
            </Button>
          }
        />
      ) : (
        <div className="rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Photo</TableHead>
                <TableHead>Listing</TableHead>
                <TableHead>Position</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Uploaded</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {photos.map((photo) => (
                <TableRow key={photo.id}>
                  <TableCell>
                    <a
                      href={photo.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group relative block aspect-video w-20 overflow-hidden rounded-md border bg-muted"
                      title="View full image"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={photo.url}
                        alt="Listing photo"
                        className="size-full object-cover transition-transform group-hover:scale-105"
                      />
                      <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
                        <ExternalLink className="size-3.5 text-white" />
                      </div>
                    </a>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-sm">
                      {photo.listingTitle ?? "Untitled Listing"}
                    </div>
                    <div className="font-mono text-muted-foreground text-xs">
                      ID: {photo.listingId}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm font-mono text-muted-foreground">
                    #{photo.position}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={photo.moderationStatus} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                    {formatIST(new Date(photo.createdAt), "dd MMM yyyy, HH:mm")}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-emerald-700 hover:text-emerald-800 hover:bg-emerald-50 border-emerald-300 min-h-11"
                        disabled={photo.moderationStatus === "APPROVED"}
                        onClick={() => handleOpenModerate(photo, "APPROVED")}
                      >
                        <CheckCircle className="mr-1 size-3.5" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-destructive hover:bg-destructive/10 border-destructive/30 min-h-11"
                        disabled={photo.moderationStatus === "REJECTED"}
                        onClick={() => handleOpenModerate(photo, "REJECTED")}
                      >
                        <XCircle className="mr-1 size-3.5" />
                        Reject
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {nextCursor && (
            <div className="flex items-center justify-center border-t p-4">
              <Button variant="outline" size="sm" onClick={handleNextPage}>
                Load More Photos
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Moderation confirmation dialog */}
      <ActionDialog
        open={!!moderateTarget}
        onOpenChange={(open) => !open && setModerateTarget(null)}
        title={moderateDecision === "APPROVED" ? "Approve Photo" : "Reject Photo"}
        description={
          moderateDecision === "APPROVED"
            ? "Approving this photo will make it visible to public search and renter listings."
            : "Rejecting this photo will hide it from public search and renter listings (PRD FR-02)."
        }
        confirmLabel={moderateDecision === "APPROVED" ? "Approve" : "Reject"}
        variant={moderateDecision === "APPROVED" ? "default" : "destructive"}
        isSubmitting={isModerating}
        reasonLabel="Audit Reason (Required for FR-13 compliance)"
        reasonPlaceholder={
          moderateDecision === "APPROVED"
            ? "e.g., Image matches listing description, clear parking space shown."
            : "e.g., Inappropriate content, blurry/unrecognizable, contains personal info."
        }
        onConfirm={handleModerateSubmit}
      >
        {moderateTarget && (
          <div className="mb-4 flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
            <div className="relative aspect-video w-20 overflow-hidden rounded border bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={moderateTarget.url} alt="Target" className="size-full object-cover" />
            </div>
            <div className="text-xs space-y-1">
              <div className="font-semibold">{moderateTarget.listingTitle ?? "Untitled"}</div>
              <div className="text-muted-foreground font-mono">Photo ID: {moderateTarget.id}</div>
              <div className="text-muted-foreground">Position: #{moderateTarget.position}</div>
            </div>
          </div>
        )}
      </ActionDialog>
    </div>
  );
}
