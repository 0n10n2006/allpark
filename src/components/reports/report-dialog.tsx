"use client";

import { useId, useState } from "react";
import { Flag } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api-client";
import type { CreateReportResponse } from "@/contracts/reports";

export interface ReportDialogProps {
  listingId: string;
  listingTitle?: string;
  trigger?: React.ReactNode;
}

const REPORT_REASONS = [
  { value: "INACCURATE_LISTING", label: "Inaccurate listing or photos" },
  { value: "ACCESS_PROBLEM", label: "Access problem or gate locked" },
  { value: "FAKE_OR_UNAUTHORIZED_LISTING", label: "Fake or unauthorized space" },
  { value: "SUSPICIOUS_BEHAVIOR", label: "Suspicious behavior or fraud" },
  { value: "INAPPROPRIATE_CONTENT", label: "Inappropriate or offensive content" },
  { value: "SAFETY", label: "Safety or security hazard" },
  { value: "OTHER", label: "Other issue" },
] as const;

export function ReportDialog({ listingId, listingTitle, trigger }: ReportDialogProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("INACCURATE_LISTING");
  const [description, setDescription] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setReason("INACCURATE_LISTING");
    setDescription("");
    setEvidenceUrl("");
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (description.trim().length < 10) {
      setError("Please describe the issue in at least 10 characters");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const evidenceUrls = evidenceUrl
        .split(/[\n,]/)
        .map((u) => u.trim())
        .filter((u) => u.length > 0);

      await api<CreateReportResponse>("/api/reports", {
        method: "POST",
        body: {
          targetType: "LISTING",
          targetId: listingId,
          reason,
          description: description.trim(),
          evidenceUrls: evidenceUrls.length > 0 ? evidenceUrls : undefined,
        },
      });

      toast.success("Report submitted. Our trust & safety team will review it.");
      resetForm();
      setOpen(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        toast.error(err.message);
      } else {
        setError("Failed to submit report. Please try again.");
        toast.error("Failed to submit report");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetForm();
      }}
    >
      <DialogTrigger
        render={
          trigger ? (
            <div>{trigger}</div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-muted-foreground hover:text-foreground"
            >
              <Flag className="size-4" /> Report this listing
            </Button>
          )
        }
      />

      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <form onSubmit={handleSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Report this listing</DialogTitle>
            <DialogDescription>
              {listingTitle
                ? `Help us keep ParkShare safe by reporting issues with ${listingTitle}.`
                : "Help us keep ParkShare safe by reporting issues with this listing."}
            </DialogDescription>
          </DialogHeader>

          <div>
            <Label htmlFor={`${id}-reason`} className="text-sm font-medium">
              What is the problem?
            </Label>
            <select
              id={`${id}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              disabled={busy}
            >
              {REPORT_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <Label htmlFor={`${id}-desc`} className="text-sm font-medium">
                Description
              </Label>
              <span className="text-xs text-muted-foreground">
                {description.length} / 5000 (min 10)
              </span>
            </div>
            <Textarea
              id={`${id}-desc`}
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 5000))}
              placeholder="Please provide details about what went wrong..."
              className="mt-1.5 min-h-24 resize-y"
              maxLength={5000}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-err` : undefined}
            />
          </div>

          <div>
            <Label htmlFor={`${id}-evidence`} className="text-sm font-medium">
              Evidence image URL (optional)
            </Label>
            <input
              id={`${id}-evidence`}
              type="url"
              value={evidenceUrl}
              onChange={(e) => setEvidenceUrl(e.target.value)}
              placeholder="https://res.cloudinary.com/.../evidence/..."
              className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              disabled={busy}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Photos uploaded via Cloudinary evidence or listing folders.
            </p>
          </div>

          {error ? (
            <p id={`${id}-err`} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter className="gap-2 sm:gap-0">
            <DialogClose render={<Button type="button" variant="outline" disabled={busy} />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Submitting..." : "Submit report"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
