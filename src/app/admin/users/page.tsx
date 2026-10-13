"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Search,
  UserCheck,
  UserX,
  Eye,
  Car,
  CalendarDays,
  ShieldCheck,
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
import { StatusBadge } from "@/components/admin/status-badge";
import { ActionDialog } from "@/components/admin/action-dialog";
import { EmptyState } from "@/components/common/empty-state";
import { LoadingState } from "@/components/common/loading-state";
import { api } from "@/lib/api-client";
import { formatINR } from "@/lib/money";
import { formatIST } from "@/lib/time";
import type {
  AdminUser,
  AdminListUsersResponse,
  AdminVerifyHostBody,
  AdminSuspendUserBody,
} from "@/contracts";

type UserDetail = {
  user: AdminUser;
  vehicles: Array<{ id: string; registration: string; type: string; nickname: string | null }>;
  bookings: Array<{
    id: string;
    code: string | null;
    status: string;
    startAt: string;
    endAt: string;
    totalPaise: number;
    listing: { id: string; title: string };
  }>;
};

export default function AdminUsersPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading users..." />}>
      <UsersContent />
    </Suspense>
  );
}

function UsersContent() {
  const searchParams = useSearchParams();
  const initialVerification = searchParams.get("hostVerificationStatus") ?? "ALL";

  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [role, setRole] = useState<string>("ALL");
  const [verificationStatus, setVerificationStatus] = useState<string>(initialVerification);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Detail & Action modal state
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [verifyTarget, setVerifyTarget] = useState<AdminUser | null>(null);
  const [verifyDecision, setVerifyDecision] = useState<"VERIFIED" | "REJECTED">("VERIFIED");
  const [isVerifying, setIsVerifying] = useState(false);

  const [suspendTarget, setSuspendTarget] = useState<AdminUser | null>(null);
  const [isSuspending, setIsSuspending] = useState(false);

  const fetchUsers = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (role !== "ALL") params.set("role", role);
        if (verificationStatus !== "ALL") params.set("hostVerificationStatus", verificationStatus);
        if (cursor) params.set("cursor", cursor);
        params.set("limit", "20");

        const data = await api<AdminListUsersResponse>(`/api/admin/users?${params.toString()}`);
        setUsers(data.items);
        setNextCursor(data.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load users");
      } finally {
        setLoading(false);
      }
    },
    [q, role, verificationStatus],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    fetchUsers();
  }, [fetchUsers]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCursorHistory([]);
    setQ(searchInput.trim());
  };

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, nextCursor]);
    fetchUsers(nextCursor);
  };

  const handleResetFilters = () => {
    setSearchInput("");
    setQ("");
    setRole("ALL");
    setVerificationStatus("ALL");
    setCursorHistory([]);
  };

  const openUserDetail = async (userId: string) => {
    setSelectedUserId(userId);
    setDetailLoading(true);
    try {
      const data = await api<UserDetail>(`/api/admin/users/${userId}`);
      setDetail(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load user detail");
      setSelectedUserId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleVerifyHost = async (reason: string) => {
    if (!verifyTarget) return;
    setIsVerifying(true);
    try {
      await api(`/api/admin/users/${verifyTarget.id}/verify-host`, "POST", {
        decision: verifyDecision,
        reason,
      } satisfies AdminVerifyHostBody);

      toast.success(
        verifyDecision === "VERIFIED"
          ? "Host verified successfully."
          : "Host verification rejected.",
      );
      setVerifyTarget(null);
      fetchUsers();
      if (selectedUserId === verifyTarget.id) {
        openUserDetail(verifyTarget.id);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to verify host.");
      throw err;
    } finally {
      setIsVerifying(false);
    }
  };

  const handleSuspendUser = async (reason: string) => {
    if (!suspendTarget) return;
    setIsSuspending(true);
    const newSuspendedState = !suspendTarget.suspendedAt;
    try {
      await api(`/api/admin/users/${suspendTarget.id}/suspend`, "POST", {
        suspended: newSuspendedState,
        reason,
      } satisfies AdminSuspendUserBody);

      toast.success(
        newSuspendedState
          ? "User suspended and sessions invalidated."
          : "User suspension lifted.",
      );
      setSuspendTarget(null);
      fetchUsers();
      if (selectedUserId === suspendTarget.id) {
        openUserDetail(suspendTarget.id);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update suspension.");
      throw err;
    } finally {
      setIsSuspending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Users Management</h2>
          <p className="text-muted-foreground text-sm">
            Search user profiles, manage host verification (FR-11), and administer account suspensions (FR-13).
          </p>
        </div>
      </div>

      {/* Filters and search */}
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center">
        <form onSubmit={handleSearchSubmit} className="flex flex-1 items-center gap-2">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-2.5 left-3 size-4" aria-hidden="true" />
            <Input
              type="search"
              placeholder="Search by name, email, or phone..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9"
              aria-label="Search users"
            />
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <div className="w-36">
            <Select
              value={role}
              onValueChange={(val) => {
                if (val) {
                  setRole(val);
                  setCursorHistory([]);
                }
              }}
            >
              <SelectTrigger aria-label="Filter by role">
                <SelectValue placeholder="All Roles" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Roles</SelectItem>
                <SelectItem value="RENTER">Renter</SelectItem>
                <SelectItem value="HOST">Host</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="w-48">
            <Select
              value={verificationStatus}
              onValueChange={(val) => {
                if (val) {
                  setVerificationStatus(val);
                  setCursorHistory([]);
                }
              }}
            >
              <SelectTrigger aria-label="Filter by verification">
                <SelectValue placeholder="Verification Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Verification</SelectItem>
                <SelectItem value="PENDING">Pending Verification</SelectItem>
                <SelectItem value="VERIFIED">Verified</SelectItem>
                <SelectItem value="REJECTED">Rejected</SelectItem>
                <SelectItem value="NOT_STARTED">Not Started</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(q || role !== "ALL" || verificationStatus !== "ALL") && (
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
        <LoadingState label="Loading users list..." />
      ) : error ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-6 text-center text-destructive">
          <p className="font-semibold">{error}</p>
          <Button variant="outline" onClick={() => fetchUsers()} className="mt-3">
            Retry
          </Button>
        </div>
      ) : users.length === 0 ? (
        <EmptyState
          title="No users found"
          body="Try adjusting your search query or verification filter."
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
                  <TableHead scope="col">User</TableHead>
                  <TableHead scope="col">Roles</TableHead>
                  <TableHead scope="col">Verification</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Registered</TableHead>
                  <TableHead scope="col" className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => {
                  const isSuspended = Boolean(u.suspendedAt);
                  return (
                    <TableRow key={u.id} className={isSuspended ? "bg-muted/50 opacity-80" : ""}>
                      <TableCell>
                        <div className="font-medium">{u.name || "Unnamed user"}</div>
                        <div className="text-muted-foreground text-xs">{u.email || u.phone || u.id.slice(0, 8)}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {u.roles.map((r) => (
                            <span
                              key={r}
                              className="bg-muted text-muted-foreground inline-block rounded px-1.5 py-0.5 text-xs font-mono font-medium"
                            >
                              {r}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={u.hostVerificationStatus} />
                      </TableCell>
                      <TableCell>
                        {isSuspended ? (
                          <StatusBadge status="SUSPENDED" />
                        ) : (
                          <span className="text-muted-foreground text-xs">Active</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                        {formatIST(new Date(u.createdAt), "dd MMM yyyy")}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openUserDetail(u.id)}
                            aria-label={`View details for ${u.name || u.id}`}
                          >
                            <Eye className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-primary hover:text-primary"
                            onClick={() => {
                              setVerifyTarget(u);
                              setVerifyDecision(
                                u.hostVerificationStatus === "PENDING" ? "VERIFIED" : "VERIFIED",
                              );
                            }}
                            title="Verify Host"
                            aria-label={`Verify host ${u.name || u.id}`}
                          >
                            <UserCheck className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className={isSuspended ? "text-emerald-600" : "text-destructive"}
                            onClick={() => setSuspendTarget(u)}
                            title={isSuspended ? "Reactivate User" : "Suspend User"}
                            aria-label={isSuspended ? `Reactivate ${u.name || u.id}` : `Suspend ${u.name || u.id}`}
                          >
                            <UserX className="size-4" />
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
            <span>Showing {users.length} users</span>
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
                  fetchUsers(prevCursor);
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

      {/* User Detail Dialog */}
      <Dialog open={Boolean(selectedUserId)} onOpenChange={(open) => !open && setSelectedUserId(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>User Profile & History</DialogTitle>
            <DialogDescription>
              Complete account detail, vehicles, and booking history.
            </DialogDescription>
          </DialogHeader>

          {detailLoading || !detail ? (
            <LoadingState label="Loading detail..." />
          ) : (
            <div className="space-y-6">
              {/* Profile summary */}
              <div className="rounded-xl border bg-muted/30 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-base">{detail.user.name || "Unnamed user"}</h3>
                  <StatusBadge status={detail.user.suspendedAt ? "SUSPENDED" : "ACTIVE"} />
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <div>Email: <span className="text-foreground font-medium">{detail.user.email || "—"}</span></div>
                  <div>Phone: <span className="text-foreground font-medium">{detail.user.phone || "—"}</span></div>
                  <div>User ID: <span className="font-mono text-foreground">{detail.user.id}</span></div>
                  <div>Joined: <span className="text-foreground">{formatIST(new Date(detail.user.createdAt), "dd MMM yyyy, HH:mm")}</span></div>
                </div>
                {detail.user.suspendedAt && (
                  <div className="mt-2 rounded border border-destructive/20 bg-destructive/10 p-2 text-xs text-destructive">
                    <strong>Suspended on:</strong> {formatIST(new Date(detail.user.suspendedAt), "dd MMM yyyy, HH:mm")}<br />
                    <strong>Reason:</strong> {detail.user.suspendedReason || "No reason recorded"}
                  </div>
                )}
              </div>

              {/* Host verification compliance box (FR-11) */}
              <div className="rounded-xl border p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
                    <h3 className="font-semibold text-sm">Host Verification Status</h3>
                  </div>
                  <StatusBadge status={detail.user.hostVerificationStatus} />
                </div>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Host verification confirms submitted document identity only. It does <strong>not</strong> imply
                  or constitute any guarantee of space quality, safety, security, or host reliability (FR-11).
                </p>
              </div>

              {/* Vehicles */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Car className="size-4 text-muted-foreground" aria-hidden="true" />
                  <h3 className="font-semibold text-sm">Registered Vehicles ({detail.vehicles.length})</h3>
                </div>
                {detail.vehicles.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No vehicles registered.</p>
                ) : (
                  <ul className="divide-y rounded-lg border text-xs">
                    {detail.vehicles.map((v) => (
                      <li key={v.id} className="flex items-center justify-between p-2.5">
                        <span className="font-mono font-semibold">{v.registration}</span>
                        <span className="text-muted-foreground">{v.nickname || v.type}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Recent Bookings */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <CalendarDays className="size-4 text-muted-foreground" aria-hidden="true" />
                  <h3 className="font-semibold text-sm">Recent Bookings ({detail.bookings.length})</h3>
                </div>
                {detail.bookings.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No bookings recorded.</p>
                ) : (
                  <ul className="divide-y rounded-lg border text-xs">
                    {detail.bookings.map((b) => (
                      <li key={b.id} className="p-2.5 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{b.listing.title}</span>
                          <StatusBadge status={b.status} />
                        </div>
                        <div className="flex items-center justify-between text-muted-foreground">
                          <span>{formatIST(new Date(b.startAt), "dd MMM, HH:mm")} – {formatIST(new Date(b.endAt), "dd MMM, HH:mm")}</span>
                          <span className="font-semibold text-foreground">{formatINR(b.totalPaise)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Verify Host Dialog */}
      <ActionDialog
        open={Boolean(verifyTarget)}
        onOpenChange={(open) => !open && setVerifyTarget(null)}
        title={`Verify Host: ${verifyTarget?.name || verifyTarget?.email || verifyTarget?.id.slice(0, 8)}`}
        description="Verify or reject host identity documentation. Verification confirms identity documents only and carries no quality guarantee (FR-11)."
        confirmLabel={verifyDecision === "VERIFIED" ? "Approve Verification" : "Reject Verification"}
        variant={verifyDecision === "VERIFIED" ? "default" : "destructive"}
        isSubmitting={isVerifying}
        reasonLabel="Verification Audit Reason (Required)"
        reasonPlaceholder="e.g. Verified Aadhaar / PAN identity document against submitted host profile..."
        onConfirm={handleVerifyHost}
      >
        <fieldset className="space-y-2 pt-2">
          <legend className="text-sm font-medium">Verification Decision</legend>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="radio"
                name="verify-decision"
                value="VERIFIED"
                checked={verifyDecision === "VERIFIED"}
                onChange={() => setVerifyDecision("VERIFIED")}
                className="size-4 text-primary"
              />
              <span>Approve (VERIFIED)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-sm text-destructive">
              <input
                type="radio"
                name="verify-decision"
                value="REJECTED"
                checked={verifyDecision === "REJECTED"}
                onChange={() => setVerifyDecision("REJECTED")}
                className="size-4 text-destructive"
              />
              <span>Reject (REJECTED)</span>
            </label>
          </div>
        </fieldset>
      </ActionDialog>

      {/* Suspend / Unsuspend Dialog */}
      <ActionDialog
        open={Boolean(suspendTarget)}
        onOpenChange={(open) => !open && setSuspendTarget(null)}
        title={
          suspendTarget?.suspendedAt
            ? `Reactivate User: ${suspendTarget?.name || suspendTarget?.id.slice(0, 8)}`
            : `Suspend User: ${suspendTarget?.name || suspendTarget?.id.slice(0, 8)}`
        }
        description={
          suspendTarget?.suspendedAt
            ? "Lifting suspension will restore account access and allow the user to sign in."
            : "Suspending this user will immediately invalidate all active sessions, sign them out everywhere, and restrict access across the entire platform (FR-13)."
        }
        confirmLabel={suspendTarget?.suspendedAt ? "Reactivate Account" : "Suspend Account"}
        variant={suspendTarget?.suspendedAt ? "default" : "destructive"}
        isSubmitting={isSuspending}
        reasonLabel="Suspension Audit Reason (Required)"
        reasonPlaceholder="Explain the security, policy, or fraudulent behavior justifying this action..."
        onConfirm={handleSuspendUser}
      />
    </div>
  );
}
