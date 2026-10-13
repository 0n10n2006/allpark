"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import {
  Search,
  MapPin,
  Eye,
  ShieldAlert,
  RotateCcw,
  Image as ImageIcon,
  CheckCircle,
  AlertCircle,
  ExternalLink,
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
import { ActionDialog } from "@/components/admin/action-dialog";
import { EmptyState } from "@/components/common/empty-state";
import { LoadingState } from "@/components/common/loading-state";
import { api } from "@/lib/api-client";
import { formatINR } from "@/lib/money";
import { formatIST } from "@/lib/time";
import type {
  AdminListing,
  AdminListListingsResponse,
  AdminSuspendListingBody,
} from "@/contracts";

export default function AdminListingsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading listings..." />}>
      <ListingsContent />
    </Suspense>
  );
}

function ListingsContent() {
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [listingStatus, setListingStatus] = useState<string>("ALL");
  const [listings, setListings] = useState<AdminListing[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedListing, setSelectedListing] = useState<AdminListing | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<AdminListing | null>(null);
  const [isSuspending, setIsSuspending] = useState(false);

  const fetchListings = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (listingStatus !== "ALL") params.set("listingStatus", listingStatus);
        if (cursor) params.set("cursor", cursor);
        params.set("limit", "20");

        const data = await api<AdminListListingsResponse>(`/api/admin/listings?${params.toString()}`);
        setListings(data.items);
        setNextCursor(data.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load listings");
      } finally {
        setLoading(false);
      }
    },
    [q, listingStatus],
  );

  useEffect(() => {
    fetchListings();
  }, [fetchListings]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCursorHistory([]);
    setQ(searchInput.trim());
  };

  const handleResetFilters = () => {
    setSearchInput("");
    setQ("");
    setListingStatus("ALL");
    setCursorHistory([]);
  };

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, nextCursor]);
    fetchListings(nextCursor);
  };

  const handleSuspendToggle = async (reason: string) => {
    if (!suspendTarget) return;
    setIsSuspending(true);
    const newSuspendedState = suspendTarget.status !== "SUSPENDED";
    try {
      await api(`/api/admin/listings/${suspendTarget.id}/suspend`, "POST", {
        suspended: newSuspendedState,
        reason,
      } satisfies AdminSuspendListingBody);

      toast.success(
        newSuspendedState
          ? "Listing suspended and removed from search."
          : "Listing unsuspended and restored to published status.",
      );
      setSuspendTarget(null);
      fetchListings();
      if (selectedListing?.id === suspendTarget.id) {
        setSelectedListing((prev) =>
          prev
            ? {
                ...prev,
                status: newSuspendedState ? "SUSPENDED" : "PUBLISHED",
                suspendedReason: newSuspendedState ? reason : null,
              }
            : null,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update listing status.");
      throw err;
    } finally {
      setIsSuspending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Listings Management</h2>
          <p className="text-muted-foreground text-sm">
            Inspect all listings (including private addresses) and manage moderation suspensions (FR-13).
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
              placeholder="Search by title, city, locality, or address..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9"
              aria-label="Search listings"
            />
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <div className="w-44">
            <Select
              value={listingStatus}
              onValueChange={(val) => {
                setListingStatus(val);
                setCursorHistory([]);
              }}
            >
              <SelectTrigger aria-label="Filter by listing status">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Statuses</SelectItem>
                <SelectItem value="PUBLISHED">Published</SelectItem>
                <SelectItem value="DRAFT">Draft</SelectItem>
                <SelectItem value="SUSPENDED">Suspended</SelectItem>
                <SelectItem value="ARCHIVED">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(q || listingStatus !== "ALL") && (
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

      {/* Content */}
      {loading ? (
        <LoadingState label="Loading listings..." />
      ) : error ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-6 text-center text-destructive">
          <p className="font-semibold">{error}</p>
          <Button variant="outline" onClick={() => fetchListings()} className="mt-3">
            Retry
          </Button>
        </div>
      ) : listings.length === 0 ? (
        <EmptyState
          title="No listings found"
          body="Try adjusting your search criteria or status filter."
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
                  <TableHead scope="col">Title & Location</TableHead>
                  <TableHead scope="col">Type</TableHead>
                  <TableHead scope="col">Hourly Rate</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Host ID</TableHead>
                  <TableHead scope="col">Created</TableHead>
                  <TableHead scope="col" className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listings.map((l) => {
                  const isSuspended = l.status === "SUSPENDED";
                  return (
                    <TableRow key={l.id} className={isSuspended ? "bg-muted/40 opacity-80" : ""}>
                      <TableCell>
                        <div className="font-medium">{l.title}</div>
                        <div className="text-muted-foreground flex items-center gap-1 text-xs">
                          <MapPin className="size-3" aria-hidden="true" />
                          <span>{l.locality}, {l.city}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs font-medium">
                          {l.spaceType}
                        </span>
                      </TableCell>
                      <TableCell className="font-semibold">
                        {l.pricing.hourly ? formatINR(l.pricing.hourly.paise) : "—"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={l.status} />
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {l.hostId.slice(0, 8)}...
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {formatIST(new Date(l.createdAt), "dd MMM yyyy")}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSelectedListing(l)}
                            aria-label={`View details for ${l.title}`}
                          >
                            <Eye className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className={isSuspended ? "text-emerald-600" : "text-destructive"}
                            onClick={() => setSuspendTarget(l)}
                            title={isSuspended ? "Unsuspend Listing" : "Suspend Listing"}
                            aria-label={isSuspended ? `Unsuspend ${l.title}` : `Suspend ${l.title}`}
                          >
                            {isSuspended ? <CheckCircle className="size-4" /> : <AlertCircle className="size-4" />}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Showing {listings.length} listings</span>
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
                  fetchListings(prevCursor);
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

      {/* Detail Dialog with Private Fields & Address */}
      <Dialog open={Boolean(selectedListing)} onOpenChange={(open) => !open && setSelectedListing(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Listing Detail</DialogTitle>
            <DialogDescription>
              Includes private address and security fields accessible only to administrators.
            </DialogDescription>
          </DialogHeader>

          {selectedListing && (
            <div className="space-y-5 text-sm">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold">{selectedListing.title}</h3>
                  <p className="text-muted-foreground text-xs">{selectedListing.description}</p>
                </div>
                <StatusBadge status={selectedListing.status} />
              </div>

              {selectedListing.suspendedReason && (
                <div className="rounded border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">
                  <strong>Suspension Reason:</strong> {selectedListing.suspendedReason}
                </div>
              )}

              {/* Private Address Section (FR-13) */}
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-semibold text-primary">
                    <MapPin className="size-4" aria-hidden="true" />
                    <span>Exact Location (Private / Admin-Only)</span>
                  </div>
                  <span className="bg-primary/20 text-primary text-[10px] font-bold uppercase rounded px-1.5 py-0.5">
                    Private Field
                  </span>
                </div>
                <div className="space-y-1 text-xs">
                  <div><strong>Address:</strong> {selectedListing.location.address}</div>
                  <div><strong>Locality:</strong> {selectedListing.location.locality}, {selectedListing.location.city}</div>
                  <div><strong>Coordinates:</strong> {selectedListing.location.lat}, {selectedListing.location.lng}</div>
                  {selectedListing.accessInstructions && (
                    <div className="mt-2 pt-2 border-t border-primary/10">
                      <strong>Access Instructions:</strong> {selectedListing.accessInstructions}
                    </div>
                  )}
                </div>
              </div>

              {/* Space Specifications */}
              <div className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-xs">
                <div><strong>Space Type:</strong> {selectedListing.spaceType}</div>
                <div><strong>Vehicle Types:</strong> {selectedListing.vehicleTypes.join(", ")}</div>
                <div><strong>Host ID:</strong> <span className="font-mono">{selectedListing.hostId}</span></div>
                <div><strong>Created:</strong> {formatIST(new Date(selectedListing.createdAt), "dd MMM yyyy, HH:mm")}</div>
              </div>

              {/* Pricing */}
              <div className="rounded-lg border p-3 space-y-2 text-xs">
                <div className="font-semibold">Pricing Rates:</div>
                <div className="grid grid-cols-3 gap-2">
                  <div>Hourly: <span className="font-bold">{selectedListing.pricing.hourly ? formatINR(selectedListing.pricing.hourly.paise) : "—"}</span></div>
                  <div>Daily: <span className="font-bold">{selectedListing.pricing.daily ? formatINR(selectedListing.pricing.daily.paise) : "—"}</span></div>
                  <div>Monthly: <span className="font-bold">{selectedListing.pricing.monthly ? formatINR(selectedListing.pricing.monthly.paise) : "—"}</span></div>
                </div>
              </div>

              {/* Photos & Photo Moderation Note */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-semibold text-xs">
                    <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span>Listing Photos ({selectedListing.photos.length})</span>
                  </div>
                  <span className="text-[11px] text-muted-foreground italic">
                    Photo moderation API: not provided upstream
                  </span>
                </div>
                {selectedListing.photos.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No photos uploaded for this listing.</p>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    {selectedListing.photos.map((p) => (
                      <div key={p.id} className="relative aspect-video rounded-md overflow-hidden border bg-muted">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.url} alt="Listing photo" className="object-cover size-full" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Suspend / Unsuspend Action Dialog */}
      <ActionDialog
        open={Boolean(suspendTarget)}
        onOpenChange={(open) => !open && setSuspendTarget(null)}
        title={
          suspendTarget?.status === "SUSPENDED"
            ? `Unsuspend Listing: ${suspendTarget?.title}`
            : `Suspend Listing: ${suspendTarget?.title}`
        }
        description={
          suspendTarget?.status === "SUSPENDED"
            ? "Unsuspending this listing will return it to published status and restore it to search results."
            : "Suspending this listing immediately removes it from public search and prevents new bookings. Existing booking history remains intact (FR-13)."
        }
        confirmLabel={suspendTarget?.status === "SUSPENDED" ? "Restore to Search" : "Suspend Listing"}
        variant={suspendTarget?.status === "SUSPENDED" ? "default" : "destructive"}
        isSubmitting={isSuspending}
        reasonLabel="Moderation Audit Reason (Required)"
        reasonPlaceholder="Specify the policy violation, safety report, or verification issue..."
        onConfirm={handleSuspendToggle}
      />
    </div>
  );
}
