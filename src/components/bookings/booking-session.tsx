"use client";

import { useId, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Script from "next/script";
import { toast } from "sonner";
import {
  type BookingDetail,
  CreateDisputeBody,
  type ExtendBookingResponse,
  type RenewMonthlyResponse,
} from "@/contracts";
import type { DisputeCategory } from "@/generated/prisma/enums";
import { api, ApiError, newIdempotencyKey } from "@/lib/api-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ReviewForm } from "@/components/reviews/review-form";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatIST, parseISTLocal } from "@/lib/time";
import { MONTHLY_STATUS_LABEL, formatWhenIST } from "./labels";

const MIN = 60_000;
// ponytail: no arrival-window policy exists yet; the check-in API (Phase 4) enforces the real rule.
const ARRIVAL_EARLY_MINUTES = 15;

// One shared 1s clock. The server snapshot is null, so nothing time-based renders until hydration.
const subscribe = (cb: () => void) => {
  const t = setInterval(cb, 1000);
  return () => clearInterval(t);
};
const getNow = () => Math.floor(Date.now() / 1000) * 1000;
const useNow = () => useSyncExternalStore(subscribe, getNow, () => null);

type Phase = { label: string; target: string } | null;

/** What the header counts down to, given the server's booking status. */
function countdownPhase(b: BookingDetail, now: number): Phase {
  const start = Date.parse(b.startAt);
  const end = Date.parse(b.endAt);
  if (b.status === "CONFIRMED" && now < start) return { label: "Starts in", target: b.startAt };
  if ((b.status === "CONFIRMED" || b.status === "ACTIVE") && now < end)
    return { label: "Time remaining", target: b.endAt };
  if (b.status === "GRACE_PERIOD" || b.status === "ACTIVE")
    return { label: "Grace period ends in", target: b.gracePeriodEndsAt };
  return null;
}

function parts(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return {
    d: Math.floor(s / 86400),
    h: Math.floor((s % 86400) / 3600),
    m: Math.floor((s % 3600) / 60),
    s: s % 60,
  };
}
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
function visibleDuration(ms: number) {
  const { d, h, m, s } = parts(ms);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}
/** Minute resolution, so the live region changes (and is announced) at most once a minute. */
function spokenDuration(ms: number) {
  const { d, h, m } = parts(ms);
  const bits = [d && plural(d, "day"), h && plural(h, "hour"), plural(m, "minute")].filter(Boolean);
  return bits.join(" ");
}

function handleBookingError(e: unknown) {
  if (e instanceof ApiError) {
    if (e.status === 501) {
      toast.info("Coming soon", { description: "This action isn't available yet." });
      return;
    }
    toast.error(e.message || "Something went wrong. Please try again.");
    return;
  }
  toast.error("You seem to be offline. Check your connection and try again.");
}

/** A fresh Idempotency-Key per attempt; kept across retries of a failed attempt. */
function useIdempotencyKey() {
  const key = useRef<string | null>(null);
  return {
    get: () => (key.current ??= newIdempotencyKey()),
    reset: () => void (key.current = null),
  };
}

const actionClass = "h-11 px-4";

export function BookingSession({ booking: b }: { booking: BookingDetail }) {
  const now = useNow();
  const router = useRouter();
  const phase = now === null ? null : countdownPhase(b, now);
  const remaining = phase && now !== null ? Date.parse(phase.target) - now : 0;
  const live = ["CONFIRMED", "ACTIVE", "GRACE_PERIOD", "OVERSTAY"].includes(b.status);

  return (
    <>
      <Script src="https://checkout.razorpay.com/v1/checkout.js" />
      <section
        aria-labelledby="session-time-title"
        className="bg-primary/5 border-primary/20 mt-6 rounded-xl border p-4 md:p-6"
      >
        <h2 id="session-time-title" className="text-muted-foreground text-sm font-medium">
          {live ? "Ends" : "Booked for"}
        </h2>
        <p className="text-2xl font-bold md:text-3xl">
          {live
            ? formatWhenIST(b.endAt)
            : `${formatWhenIST(b.startAt)} – ${formatWhenIST(b.endAt)}`}
        </p>
        {phase ? (
          <div className="mt-3">
            <p className="text-muted-foreground text-sm">{phase.label}</p>
            <p
              aria-hidden="true"
              className="text-primary text-4xl font-bold tabular-nums md:text-5xl"
              data-testid="countdown"
            >
              {visibleDuration(remaining)}
            </p>
            <p className="sr-only" aria-live="polite" aria-atomic="true">
              {phase.label} {spokenDuration(remaining)}
            </p>
          </div>
        ) : null}
        {b.status === "GRACE_PERIOD" || b.status === "ACTIVE" ? (
          <p className="text-muted-foreground mt-2 text-sm">
            Grace period until {formatIST(new Date(b.gracePeriodEndsAt), "h:mm a")} IST.
          </p>
        ) : null}
      </section>

      <StatusBanner b={b} />

      {now !== null ? <Actions b={b} now={now} onDone={() => router.refresh()} /> : null}

      {b.monthlyAgreement ? <MonthlyCard b={b} /> : null}

      {b.status === "COMPLETED" ? <ReviewForm booking={b} /> : null}
    </>
  );
}

function StatusBanner({ b }: { b: BookingDetail }) {
  if (b.status === "GRACE_PERIOD")
    return (
      <Alert className="mt-4">
        <AlertTitle>Your booked time has ended</AlertTitle>
        <AlertDescription>
          Please move your vehicle by {formatIST(new Date(b.gracePeriodEndsAt), "h:mm a")} IST, then
          tap &ldquo;I&apos;ve left&rdquo;. Need more time? Extend your booking if the space is
          free. If something is stopping you from leaving, report a problem and our support team
          will help.
        </AlertDescription>
      </Alert>
    );
  if (b.status === "OVERSTAY")
    return (
      <Alert className="mt-4">
        <AlertTitle>The grace period has ended</AlertTitle>
        <AlertDescription>
          We&apos;ve let the host know, and support will review what happened before anything else
          is decided. A missed checkout tap on its own isn&apos;t treated as proof of an overstay.
          If you&apos;ve already left, tap &ldquo;I&apos;ve left&rdquo;. If you disagree or
          something went wrong, report a problem to open a dispute.
        </AlertDescription>
      </Alert>
    );
  if (b.status === "DISPUTED")
    return (
      <Alert className="mt-4">
        <AlertTitle>Support is reviewing this booking</AlertTitle>
        <AlertDescription>We&apos;ll notify you when there&apos;s an update.</AlertDescription>
      </Alert>
    );
  return null;
}

function Actions({ b, now, onDone }: { b: BookingDetail; now: number; onDone: () => void }) {
  const start = Date.parse(b.startAt);
  const end = Date.parse(b.endAt);
  const graceEnd = Date.parse(b.gracePeriodEndsAt);
  const s = b.status;
  const canStart =
    (s === "CONFIRMED" || s === "ACTIVE") &&
    !b.checkedInAt &&
    now >= start - ARRIVAL_EARLY_MINUTES * MIN &&
    now < end;
  const canLeave =
    !b.checkedOutAt &&
    (s === "ACTIVE" ||
      s === "GRACE_PERIOD" ||
      s === "OVERSTAY" ||
      (s === "CONFIRMED" && !!b.checkedInAt));
  const canExtend =
    b.rentalType !== "MONTHLY" &&
    (s === "CONFIRMED" || s === "ACTIVE" || s === "GRACE_PERIOD") &&
    now < graceEnd;
  const canReport = ["CONFIRMED", "ACTIVE", "GRACE_PERIOD", "OVERSTAY", "COMPLETED"].includes(s);
  const canCancel = (s === "PENDING_PAYMENT" || s === "CONFIRMED") && !b.checkedInAt && now < start;
  if (!canStart && !canLeave && !canExtend && !canReport && !canCancel) return null;

  return (
    <section aria-labelledby="actions-title" className="mt-6">
      <h2 id="actions-title" className="sr-only">
        Actions
      </h2>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {canStart ? (
          <SimpleAction
            label="Start parking"
            path={`/api/bookings/${b.id}/check-in`}
            success="Parking started. Enjoy your stay."
            onDone={onDone}
          />
        ) : null}
        {canLeave ? (
          <SimpleAction
            label="I've left"
            path={`/api/bookings/${b.id}/check-out`}
            success="Thanks! Your departure is recorded."
            onDone={onDone}
            variant="outline"
          />
        ) : null}
        {canExtend ? <ExtendDialog b={b} onDone={onDone} /> : null}
        {canReport ? <ReportDialog b={b} onDone={onDone} /> : null}
        {canCancel ? <CancelDialog b={b} onDone={onDone} /> : null}
      </div>
    </section>
  );
}

function SimpleAction({
  label,
  path,
  success,
  onDone,
  variant,
}: {
  label: string;
  path: string;
  success: string;
  onDone: () => void;
  variant?: "outline";
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      className={actionClass}
      variant={variant}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api(path, { method: "POST", body: {} });
          toast.success(success);
          onDone();
        } catch (e) {
          handleBookingError(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}

async function ensureRazorpay(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (window.Razorpay) return true;
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

/** Dialog shell with a submit button that stays busy while the request runs. */
function ActionDialog({
  trigger,
  title,
  description,
  submitLabel,
  onSubmit,
  children,
}: {
  trigger: string;
  title: string;
  description: React.ReactNode;
  submitLabel: string;
  /** Resolves true when the dialog should close. */
  onSubmit: (setBusyMessage: (msg: string | null) => void) => Promise<boolean>;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (!next) setBusyMessage(null);
      }}
    >
      <DialogTrigger render={<Button className={actionClass} variant="outline" />}>
        {trigger}
      </DialogTrigger>
      {/* The footer's full-size close button replaces the small corner X (44px targets). */}
      <DialogContent showCloseButton={false}>
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const close = await onSubmit(setBusyMessage);
              if (close) setOpen(false);
            } finally {
              setBusy(false);
              setBusyMessage(null);
            }
          }}
          noValidate
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription render={<div />}>{description}</DialogDescription>
          </DialogHeader>
          {children}
          {busyMessage ? (
            <p role="status" aria-live="polite" className="font-medium text-sm">
              {busyMessage}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose
              render={<Button type="button" variant="outline" className={actionClass} disabled={busy} />}
            >
              Keep booking as is
            </DialogClose>
            <Button type="submit" className={actionClass} disabled={busy}>
              {busyMessage ?? submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CancelDialog({ b, onDone }: { b: BookingDetail; onDone: () => void }) {
  const key = useIdempotencyKey();
  return (
    <ActionDialog
      trigger="Cancel booking"
      title="Cancel this booking?"
      submitLabel="Cancel booking"
      description={
        <>
          <p>{b.terms.cancellation}</p>
          <p className="mt-2">Any refund is processed separately and shown on this booking.</p>
        </>
      }
      onSubmit={async () => {
        try {
          await api(`/api/bookings/${b.id}/cancel`, {
            method: "POST",
            body: {},
            headers: { "idempotency-key": key.get() },
          });
          key.reset();
          toast.success("Booking cancelled.");
          onDone();
          return true;
        } catch (e) {
          handleBookingError(e);
          return false;
        }
      }}
    />
  );
}

const toLocalInput = (iso: string) => formatIST(new Date(iso), "yyyy-MM-dd'T'HH:mm");

function ExtendDialog({ b, onDone }: { b: BookingDetail; onDone: () => void }) {
  const key = useIdempotencyKey();
  const id = useId();
  const [value, setValue] = useState(() =>
    toLocalInput(new Date(Date.parse(b.endAt) + 60 * MIN).toISOString()),
  );
  const [error, setError] = useState<string | null>(null);
  return (
    <ActionDialog
      trigger="Extend"
      title="Extend your booking"
      submitLabel="Check price"
      description="We'll check the space is free and show the extra cost before you pay."
      onSubmit={async (setBusyMessage) => {
        let newEnd: Date;
        try {
          newEnd = parseISTLocal(value);
        } catch {
          setError("Enter a valid date and time.");
          return false;
        }
        if (newEnd.getTime() <= Date.parse(b.endAt)) {
          setError("Choose a time after your current end time.");
          return false;
        }
        setError(null);
        try {
          const res = await api<ExtendBookingResponse>(`/api/bookings/${b.id}/extend`, {
            method: "POST",
            body: { newEndAt: newEnd.toISOString() },
            headers: { "idempotency-key": key.get() },
          });
          key.reset();

          if (!res.requiresPayment || !res.payment) {
            toast.success("Booking extended.");
            onDone();
            return true;
          }

          // Open Razorpay Checkout for the extension payment
          await ensureRazorpay();
          if (!window.Razorpay) {
            setError("Payment checkout could not be loaded. Please try again.");
            return false;
          }

          return await new Promise<boolean>((resolve) => {
            const order = res.payment!;
            const rzp = new window.Razorpay!({
              key: order.keyId,
              order_id: order.orderId,
              amount: order.amount.paise,
              currency: order.amount.currency,
              name: "ParkShare",
              description: "Extend booking",
              prefill: order.prefill,
              handler: async (r: {
                razorpay_order_id: string;
                razorpay_payment_id: string;
                razorpay_signature: string;
              }) => {
                setBusyMessage("Confirming…");
                try {
                  const confirmed = await api<BookingDetail>(
                    `/api/bookings/${b.id}/confirm-payment`,
                    {
                      method: "POST",
                      body: {
                        razorpayOrderId: r.razorpay_order_id,
                        razorpayPaymentId: r.razorpay_payment_id,
                        razorpaySignature: r.razorpay_signature,
                      },
                      headers: { "idempotency-key": newIdempotencyKey() },
                    },
                  );

                  // Poll until endAt moves
                  const targetEnd = newEnd.getTime();
                  let currentEnd = Date.parse(confirmed.endAt);
                  const until = Date.now() + 60_000;

                  while (currentEnd < targetEnd && Date.now() < until) {
                    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2000));
                    const latest = await api<BookingDetail>(`/api/bookings/${b.id}`).catch(
                      () => null,
                    );
                    if (latest) {
                      currentEnd = Date.parse(latest.endAt);
                    }
                  }

                  toast.success("Booking extended.");
                  onDone();
                  resolve(true);
                } catch (err) {
                  handleBookingError(err);
                  resolve(false);
                }
              },
              modal: {
                ondismiss: () => {
                  toast.info("Payment cancelled.");
                  resolve(false);
                },
              },
            });

            rzp.on("payment.failed", (r: { error?: { description?: string } }) => {
              toast.error(
                `The payment failed${r.error?.description ? `: ${r.error.description}` : ""}.`,
              );
              resolve(false);
            });

            rzp.open();
          });
        } catch (e) {
          handleBookingError(e);
          return false;
        }
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor={`${id}-end`}>New end time (IST)</Label>
        <Input
          id={`${id}-end`}
          type="datetime-local"
          className="h-11"
          min={toLocalInput(b.endAt)}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        {error ? (
          <p id={`${id}-err`} role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </div>
    </ActionDialog>
  );
}

const REPORT_CATEGORIES: { value: DisputeCategory; label: string }[] = [
  { value: "ACCESS_DENIED", label: "I can't get into the space" },
  { value: "SPACE_UNAVAILABLE", label: "The space is occupied or unavailable" },
  { value: "OVERSTAY", label: "I disagree with an overstay" },
  { value: "DAMAGE", label: "Damage to my vehicle" },
  { value: "PAYMENT", label: "A payment problem" },
  { value: "OTHER", label: "Something else" },
];

function ReportDialog({ b, onDone }: { b: BookingDetail; onDone: () => void }) {
  const id = useId();
  const [category, setCategory] = useState<DisputeCategory>(
    b.status === "OVERSTAY" || b.status === "GRACE_PERIOD" ? "OVERSTAY" : "ACCESS_DENIED",
  );
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <ActionDialog
      trigger="Report a problem"
      title="Report a problem"
      submitLabel="Send report"
      description="Tell us what happened. Our support team reviews every report and will contact you."
      onSubmit={async () => {
        const body = CreateDisputeBody.safeParse({ bookingId: b.id, category, description });
        if (!body.success) {
          setError("Describe the problem in at least 10 characters.");
          return false;
        }
        setError(null);
        try {
          await api("/api/disputes", { method: "POST", body: body.data });
          setDescription("");
          toast.success("Report sent. We'll be in touch.");
          onDone();
          return true;
        } catch (e) {
          handleBookingError(e);
          return false;
        }
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor={`${id}-cat`}>What went wrong?</Label>
        <select
          id={`${id}-cat`}
          className="border-input bg-background h-11 rounded-lg border px-3 text-sm"
          value={category}
          onChange={(e) => setCategory(e.target.value as DisputeCategory)}
        >
          {REPORT_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-desc`}>Details</Label>
        <Textarea
          id={`${id}-desc`}
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        {error ? (
          <p id={`${id}-err`} role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </div>
    </ActionDialog>
  );
}

function MonthlyCard({ b }: { b: BookingDetail }) {
  const m = b.monthlyAgreement!;
  const router = useRouter();
  const key = useIdempotencyKey();
  const [busy, setBusy] = useState(false);
  const canRenew = m.status === "ACTIVE";
  return (
    <section aria-labelledby="monthly-title" className="mt-6 rounded-xl border p-4">
      <h2 id="monthly-title" className="text-lg font-semibold">
        Monthly rental
      </h2>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Status</dt>
        <dd>{MONTHLY_STATUS_LABEL[m.status]}</dd>
        <dt className="text-muted-foreground">Term ends</dt>
        <dd>{formatWhenIST(m.currentTermEndAt)}</dd>
        {m.renewalDueAt ? (
          <>
            <dt className="text-muted-foreground">Renew by</dt>
            <dd>{formatWhenIST(m.renewalDueAt)}</dd>
          </>
        ) : null}
      </dl>
      <p className="text-muted-foreground mt-3 text-sm">
        Renewal is manual. You won&apos;t be charged automatically.
      </p>
      {canRenew ? (
        <Button
          className={`${actionClass} mt-3`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await api<RenewMonthlyResponse>(`/api/monthly/${m.id}/renew`, {
                method: "POST",
                body: {},
                headers: { "idempotency-key": key.get() },
              });
              key.reset();
              toast.success("Next month is held for you. Pay to confirm it.");
              router.push(`/checkout/${res.hold.id}`);
            } catch (e) {
              handleBookingError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Renew for next month
        </Button>
      ) : null}
    </section>
  );
}
