"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import {
  RotateCcw,
  Info,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { StatusBadge } from "@/components/admin/status-badge";
import { ActionDialog } from "@/components/admin/action-dialog";
import { EmptyState } from "@/components/common/empty-state";
import { LoadingState } from "@/components/common/loading-state";
import { api } from "@/lib/api-client";
import { formatIST } from "@/lib/time";
import type {
  AdminJob,
  AdminListJobsResponse,
  AdminRetryJobBody,
  AdminRetryNotificationBody,
} from "@/contracts";

type AdminNotification = {
  id: string;
  userId: string;
  channel: string;
  type: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  createdAt: string;
};

type AdminListNotificationsResponse = {
  items: AdminNotification[];
  nextCursor: string | null;
};

export default function AdminJobsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading jobs and notifications..." />}>
      <JobsContent />
    </Suspense>
  );
}

function JobsContent() {
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") === "notifications" ? "notifications" : "jobs";
  const initialJobStatus = searchParams.get("status") ?? "ALL";

  const [activeTab, setActiveTab] = useState(initialTab);

  // Jobs state
  const [jobStatus, setJobStatus] = useState<string>(initialJobStatus);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [jobCursor, setJobCursor] = useState<string | null>(null);
  const [jobCursorHistory, setJobCursorHistory] = useState<string[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [jobError, setJobError] = useState<string | null>(null);

  // Notifications state
  const [notifStatus, setNotifStatus] = useState<string>("ALL");
  const [notifications, setNotifications] = useState<AdminNotification[]>([]);
  const [notifCursor, setNotifCursor] = useState<string | null>(null);
  const [notifCursorHistory, setNotifCursorHistory] = useState<string[]>([]);
  const [loadingNotifs, setLoadingNotifs] = useState(true);
  const [notifError, setNotifError] = useState<string | null>(null);

  // Retry dialog state
  const [retryJobTarget, setRetryJobTarget] = useState<AdminJob | null>(null);
  const [isRetryingJob, setIsRetryingJob] = useState(false);
  const [retryNotifTarget, setRetryNotifTarget] = useState<AdminNotification | null>(null);
  const [isRetryingNotif, setIsRetryingNotif] = useState(false);

  const fetchJobs = useCallback(
    async (cursor?: string) => {
      setLoadingJobs(true);
      setJobError(null);
      try {
        const params = new URLSearchParams();
        if (jobStatus !== "ALL") params.set("jobStatus", jobStatus);
        if (cursor) params.set("cursor", cursor);
        params.set("limit", "20");

        const data = await api<AdminListJobsResponse>(`/api/admin/jobs?${params.toString()}`);
        setJobs(data.items);
        setJobCursor(data.nextCursor);
      } catch (err) {
        setJobError(err instanceof Error ? err.message : "Failed to load jobs");
      } finally {
        setLoadingJobs(false);
      }
    },
    [jobStatus],
  );

  const fetchNotifications = useCallback(
    async (cursor?: string) => {
      setLoadingNotifs(true);
      setNotifError(null);
      try {
        const params = new URLSearchParams();
        if (notifStatus !== "ALL") params.set("status", notifStatus);
        if (cursor) params.set("cursor", cursor);
        params.set("limit", "20");

        const data = await api<AdminListNotificationsResponse>(`/api/admin/notifications?${params.toString()}`);
        setNotifications(data.items);
        setNotifCursor(data.nextCursor);
      } catch (err) {
        setNotifError(err instanceof Error ? err.message : "Failed to load notifications");
      } finally {
        setLoadingNotifs(false);
      }
    },
    [notifStatus],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    fetchJobs();
  }, [fetchJobs]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    fetchNotifications();
  }, [fetchNotifications]);

  const handleRetryJobSubmit = async (reason: string) => {
    if (!retryJobTarget) return;
    setIsRetryingJob(true);
    try {
      const body: AdminRetryJobBody = { reason };
      await api(`/api/admin/jobs/${retryJobTarget.id}/retry`, "POST", body);
      toast.success("Job re-queued for execution.");
      setRetryJobTarget(null);
      fetchJobs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to retry job");
      throw err;
    } finally {
      setIsRetryingJob(false);
    }
  };

  const handleRetryNotifSubmit = async (reason: string) => {
    if (!retryNotifTarget) return;
    setIsRetryingNotif(true);
    try {
      const body: AdminRetryNotificationBody = { reason };
      await api(`/api/admin/notifications/${retryNotifTarget.id}/retry`, "POST", body);
      toast.success("Notification delivery re-enqueued.");
      setRetryNotifTarget(null);
      fetchNotifications();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to retry notification");
      throw err;
    } finally {
      setIsRetryingNotif(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Jobs & Notifications Telemetry</h2>
          <p className="text-muted-foreground text-sm">
            Monitor dead/failed background jobs and notification delivery failures. Retry failed operations with required audit reasons (FR-13).
          </p>
        </div>
      </div>

      <div className="rounded-xl border bg-muted/40 p-4 flex items-start gap-3">
        <Info className="size-5 text-primary shrink-0 mt-0.5" aria-hidden="true" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          <strong>Queue Recovery (FR-13):</strong> Background jobs and notifications are run asynchronously.
          Administrators can manually retry DEAD jobs (resetting attempts to 0 and scheduling immediately) or FAILED notifications with an audit reason.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="jobs">Background Jobs ({jobs.length})</TabsTrigger>
          <TabsTrigger value="notifications">Dispatch Notifications ({notifications.length})</TabsTrigger>
        </TabsList>

        {/* Tab 1: Background Jobs */}
        <TabsContent value="jobs" className="space-y-4 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <div className="w-48">
                <Select
                  value={jobStatus}
                  onValueChange={(val) => {
                    if (val) {
                      setJobStatus(val);
                      setJobCursorHistory([]);
                    }
                  }}
                >
                  <SelectTrigger aria-label="Filter by job status">
                    <SelectValue placeholder="Job Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All Statuses</SelectItem>
                    <SelectItem value="DEAD">Dead (Max Retries)</SelectItem>
                    <SelectItem value="FAILED">Failed</SelectItem>
                    <SelectItem value="PENDING">Pending</SelectItem>
                    <SelectItem value="RUNNING">Running</SelectItem>
                    <SelectItem value="COMPLETED">Completed</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {jobStatus !== "ALL" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setJobStatus("ALL");
                    setJobCursorHistory([]);
                  }}
                  title="Reset filters"
                  aria-label="Reset filters"
                >
                  <RotateCcw className="size-4" />
                </Button>
              )}
            </div>
          </div>

          {loadingJobs ? (
            <LoadingState label="Loading background jobs..." />
          ) : jobError ? (
            <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-6 text-center text-destructive">
              <p className="font-semibold">{jobError}</p>
              <Button variant="outline" onClick={() => fetchJobs()} className="mt-3">
                Retry
              </Button>
            </div>
          ) : jobs.length === 0 ? (
            <EmptyState
              title="No jobs found"
              body="No background jobs recorded under the selected status filter."
              action={
                <Button variant="outline" onClick={() => setJobStatus("ALL")}>
                  Clear Filter
                </Button>
              }
            />
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Job Type</TableHead>
                      <TableHead scope="col">Status</TableHead>
                      <TableHead scope="col">Attempts</TableHead>
                      <TableHead scope="col">Scheduled At (IST)</TableHead>
                      <TableHead scope="col">Last Error</TableHead>
                      <TableHead scope="col">Created (IST)</TableHead>
                      <TableHead scope="col" className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobs.map((j) => (
                      <TableRow key={j.id}>
                        <TableCell>
                          <div className="font-mono text-xs font-semibold text-primary">{j.type}</div>
                          <div className="text-muted-foreground font-mono text-[10px]">{j.id}</div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={j.status} />
                        </TableCell>
                        <TableCell className="text-xs font-mono">
                          {j.attempts} / {j.maxAttempts}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                          {formatIST(new Date(j.runAt), "dd MMM yyyy, HH:mm:ss")}
                        </TableCell>
                        <TableCell className="max-w-xs text-xs">
                          {j.lastError ? (
                            <span className="text-destructive font-mono text-[11px] line-clamp-2">
                              {j.lastError}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                          {formatIST(new Date(j.createdAt), "dd MMM yyyy, HH:mm")}
                        </TableCell>
                        <TableCell className="text-right">
                          {j.status === "DEAD" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="min-h-11 border-destructive/30 text-destructive hover:bg-destructive/10"
                              onClick={() => setRetryJobTarget(j)}
                            >
                              Retry
                            </Button>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Showing {jobs.length} jobs</span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={jobCursorHistory.length === 0}
                    onClick={() => {
                      const newHist = [...jobCursorHistory];
                      newHist.pop();
                      setJobCursorHistory(newHist);
                      const prev = newHist[newHist.length - 1];
                      fetchJobs(prev);
                    }}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!jobCursor}
                    onClick={() => {
                      if (!jobCursor) return;
                      setJobCursorHistory((prev) => [...prev, jobCursor]);
                      fetchJobs(jobCursor);
                    }}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        {/* Tab 2: Dispatch Notifications */}
        <TabsContent value="notifications" className="space-y-4 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <div className="w-48">
                <Select
                  value={notifStatus}
                  onValueChange={(val) => {
                    if (val) {
                      setNotifStatus(val);
                      setNotifCursorHistory([]);
                    }
                  }}
                >
                  <SelectTrigger aria-label="Filter by notification status">
                    <SelectValue placeholder="Notification Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All Statuses</SelectItem>
                    <SelectItem value="FAILED">Failed</SelectItem>
                    <SelectItem value="PENDING">Pending</SelectItem>
                    <SelectItem value="SENT">Sent</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {notifStatus !== "ALL" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setNotifStatus("ALL");
                    setNotifCursorHistory([]);
                  }}
                  title="Reset filters"
                  aria-label="Reset filters"
                >
                  <RotateCcw className="size-4" />
                </Button>
              )}
            </div>
          </div>

          {loadingNotifs ? (
            <LoadingState label="Loading dispatch notifications..." />
          ) : notifError ? (
            <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-6 text-center text-destructive">
              <p className="font-semibold">{notifError}</p>
              <Button variant="outline" onClick={() => fetchNotifications()} className="mt-3">
                Retry
              </Button>
            </div>
          ) : notifications.length === 0 ? (
            <EmptyState
              title="No notifications found"
              body="No notifications recorded under the selected status filter."
              action={
                <Button variant="outline" onClick={() => setNotifStatus("ALL")}>
                  Clear Filter
                </Button>
              }
            />
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Type & Channel</TableHead>
                      <TableHead scope="col">Recipient ID</TableHead>
                      <TableHead scope="col">Status</TableHead>
                      <TableHead scope="col">Scheduled At (IST)</TableHead>
                      <TableHead scope="col">Sent At (IST)</TableHead>
                      <TableHead scope="col">Created (IST)</TableHead>
                      <TableHead scope="col" className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {notifications.map((n) => (
                      <TableRow key={n.id}>
                        <TableCell>
                          <div className="font-semibold text-xs">{n.type}</div>
                          <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-mono">
                            {n.channel}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {n.userId.slice(0, 8)}...
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={n.status} />
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                          {formatIST(new Date(n.scheduledAt), "dd MMM yyyy, HH:mm")}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                          {n.sentAt ? formatIST(new Date(n.sentAt), "dd MMM yyyy, HH:mm:ss") : "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                          {formatIST(new Date(n.createdAt), "dd MMM yyyy, HH:mm")}
                        </TableCell>
                        <TableCell className="text-right">
                          {n.status === "FAILED" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="min-h-11 border-destructive/30 text-destructive hover:bg-destructive/10"
                              onClick={() => setRetryNotifTarget(n)}
                            >
                              Retry
                            </Button>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Showing {notifications.length} notifications</span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={notifCursorHistory.length === 0}
                    onClick={() => {
                      const newHist = [...notifCursorHistory];
                      newHist.pop();
                      setNotifCursorHistory(newHist);
                      const prev = newHist[newHist.length - 1];
                      fetchNotifications(prev);
                    }}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!notifCursor}
                    onClick={() => {
                      if (!notifCursor) return;
                      setNotifCursorHistory((prev) => [...prev, notifCursor]);
                      fetchNotifications(notifCursor);
                    }}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Retry Job Confirmation Dialog */}
      <ActionDialog
        open={!!retryJobTarget}
        onOpenChange={(open) => !open && setRetryJobTarget(null)}
        title="Retry Dead Background Job"
        description="Re-queue this dead job for execution (status reset to PENDING, attempts reset to 0, runAt now). An audit reason is required for compliance (FR-13)."
        confirmLabel="Retry Job"
        variant="default"
        isSubmitting={isRetryingJob}
        reasonLabel="Audit Reason (Required for FR-13 compliance)"
        reasonPlaceholder="e.g., Transient network failure resolved, external service restored."
        onConfirm={handleRetryJobSubmit}
      >
        {retryJobTarget && (
          <div className="mb-4 rounded-lg border bg-muted/40 p-3 text-xs space-y-1">
            <div className="font-semibold text-primary">{retryJobTarget.type}</div>
            <div className="text-muted-foreground font-mono">Job ID: {retryJobTarget.id}</div>
            {retryJobTarget.lastError && (
              <div className="text-destructive font-mono text-[11px] mt-1 line-clamp-3">
                Error: {retryJobTarget.lastError}
              </div>
            )}
          </div>
        )}
      </ActionDialog>

      {/* Retry Notification Confirmation Dialog */}
      <ActionDialog
        open={!!retryNotifTarget}
        onOpenChange={(open) => !open && setRetryNotifTarget(null)}
        title="Retry Failed Notification"
        description="Re-enqueue delivery for this failed notification with the same idempotency key. An audit reason is required for compliance (FR-13)."
        confirmLabel="Retry Notification"
        variant="default"
        isSubmitting={isRetryingNotif}
        reasonLabel="Audit Reason (Required for FR-13 compliance)"
        reasonPlaceholder="e.g., Email provider outage resolved, recipient address verified."
        onConfirm={handleRetryNotifSubmit}
      >
        {retryNotifTarget && (
          <div className="mb-4 rounded-lg border bg-muted/40 p-3 text-xs space-y-1">
            <div className="font-semibold">{retryNotifTarget.type}</div>
            <div className="text-muted-foreground font-mono">Notification ID: {retryNotifTarget.id}</div>
            <div className="text-muted-foreground font-mono">Recipient: {retryNotifTarget.userId}</div>
          </div>
        )}
      </ActionDialog>
    </div>
  );
}
