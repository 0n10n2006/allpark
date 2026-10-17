"use client";

import { useEffect, useId, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TZDate } from "@date-fns/tz";
import { addMonths } from "date-fns";
import type { BookingDetail, Quote, Vehicle } from "@/contracts";

type RentalType = Quote["rentalType"];
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { postWithHeaders, reasonOf } from "@/components/checkout/api-client";
import { ApiError, api } from "@/lib/api-client";
import { formatMmSs, useSecondsLeft } from "@/components/checkout/countdown";
import { formatINR } from "@/lib/money";
import { APP_TIMEZONE, formatIST, parseISTLocal } from "@/lib/time";

export type OfferedRental = { type: RentalType; label: string; unit: string; paise: number };

type Props = {
  listingId: string;
  offered: OfferedRental[];
  /** null when signed out. */
  vehicles: Vehicle[] | null;
  allowedVehicleTypes: string[];
};

const HOUR = 60 * 60 * 1000;
const DEFAULT_LENGTH: Record<RentalType, number> = {
  HOURLY: 2 * HOUR,
  DAILY: 24 * HOUR,
  MULTI_DAY: 48 * HOUR,
  WEEKLY: 7 * 24 * HOUR,
  MONTHLY: 0,
};
const LOCAL = "yyyy-MM-dd'T'HH:mm";

export const DISPUTE_PATH =
  "If something goes wrong (blocked access, a dispute about your end time), use “Report a problem” on your booking. ParkShare support reviews every dispute; no penalty is applied automatically.";

/** A priced attempt: the Idempotency-Key lives and dies with its quote, so retries reuse it. */
type Attempt = { quote: Quote; idempotencyKey: string };

export function BookingPanel({ listingId, offered, vehicles, allowedVehicleTypes }: Props) {
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();
  const ids = useId();
  const [rentalType, setRentalType] = useState<RentalType>(offered[0]?.type ?? "HOURLY");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [monthStart, setMonthStart] = useState("");
  const [minLocal, setMinLocal] = useState<string>();
  const [vehicleId, setVehicleId] = useState(
    () => vehicles?.find((v) => allowedVehicleTypes.includes(v.type))?.id ?? "",
  );
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [pending, setPending] = useState<"quote" | "hold" | null>(null);
  const [error, setError] = useState<{ title: string; body: string; retry?: boolean } | null>(null);
  const [taken, setTaken] = useState(false);
  const secondsLeft = useSecondsLeft(attempt?.quote.expiresAt ?? null);
  const quoteExpired = secondsLeft === 0;

  // Defaults need the clock, so set them after mount: start at the next hour + 1.
  useEffect(() => {
    const now = Date.now();
    const s = new Date(Math.ceil(now / HOUR) * HOUR + HOUR);
    /* eslint-disable react-hooks/set-state-in-effect -- one-time clock-based defaults */
    setMinLocal(formatIST(new Date(now), LOCAL));
    setStart((v) => v || formatIST(s, LOCAL));
    setEnd((v) => v || formatIST(new Date(s.getTime() + DEFAULT_LENGTH.HOURLY), LOCAL));
    setMonthStart((v) => v || formatIST(new Date(now + 24 * HOUR), "yyyy-MM-dd"));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  /** Any input change invalidates the price, the agreement, and the attempt key. */
  function changed() {
    setAttempt(null);
    setAgreed(false);
    setError(null);
  }

  function chooseType(t: RentalType) {
    setRentalType(t);
    if (t !== "MONTHLY" && start) {
      try {
        setEnd(formatIST(new Date(parseISTLocal(start).getTime() + DEFAULT_LENGTH[t]), LOCAL));
      } catch {}
    }
    changed();
  }

  function interval(): { startAt: Date; endAt: Date } | string {
    try {
      if (rentalType === "MONTHLY") {
        const s = parseISTLocal(`${monthStart}T00:00`);
        // Matches the server's monthly term: same IST date next month.
        return { startAt: s, endAt: new Date(addMonths(new TZDate(s, APP_TIMEZONE), 1).getTime()) };
      }
      const s = parseISTLocal(start);
      const e = parseISTLocal(end);
      return e > s ? { startAt: s, endAt: e } : "The end time must be after the start time.";
    } catch {
      return "Enter a valid date and time.";
    }
  }

  async function getPrice() {
    if (pending) return;
    const iv = interval();
    if (typeof iv === "string") return setError({ title: "Check your times", body: iv });
    setPending("quote");
    setError(null);
    setTaken(false);
    try {
      const quote = await api<Quote>("/api/quotes", {
        method: "POST",
        body: {
          listingId,
          rentalType,
          startAt: iv.startAt.toISOString(),
          endAt: iv.endAt.toISOString(),
          vehicleId: vehicleId || undefined,
        },
      });
      setAttempt({ quote, idempotencyKey: crypto.randomUUID() });
      setAgreed(false);
    } catch (e) {
      setError(describe(e, "We couldn't get a price."));
    } finally {
      setPending(null);
    }
  }

  async function reserve() {
    if (pending || !attempt || !agreed || quoteExpired) return;
    setPending("hold");
    setError(null);
    try {
      const booking = await postWithHeaders<BookingDetail>(
        "/api/bookings/hold",
        { quoteId: attempt.quote.id },
        { "Idempotency-Key": attempt.idempotencyKey },
      );
      // The hidden listing route stays mounted (Activity): reset it so "Back" or
      // "Start again" shows a fresh panel, never a used quote and its spent key.
      changed();
      startNavigation(() => router.push(`/checkout/${booking.id}`));
    } catch (e) {
      if (reasonOf(e) === "slot_unavailable") {
        setTaken(true);
        changed();
      } else if (e instanceof ApiError && e.status === 422) {
        // Expired or otherwise unusable quote, or a schedule/vehicle problem: price again.
        changed();
        setError(describe(e, "We couldn't reserve this space."));
      } else {
        // Network, 409 try_again / in progress, 5xx: retrying reuses the same key.
        setError({ ...describe(e, "We couldn't reserve this space."), retry: true });
      }
    }
    setPending(null);
  }

  if (!offered.length)
    return (
      <Panel>
        <p>This space isn&apos;t taking bookings right now.</p>
      </Panel>
    );

  if (!vehicles)
    return (
      <Panel>
        <p className="mb-4">Sign in to check prices for your dates and reserve this space.</p>
        <Link
          href={`/sign-in?callbackUrl=${encodeURIComponent(`/listings/${listingId}`)}`}
          className="bg-primary text-primary-foreground inline-flex h-11 w-full items-center justify-center rounded-lg font-medium"
        >
          Sign in to book
        </Link>
      </Panel>
    );

  if (!vehicles.length)
    return (
      <Panel>
        <p className="mb-4">Add your vehicle so the host knows what will park here.</p>
        <Link
          href="/account"
          className="bg-primary text-primary-foreground inline-flex h-11 w-full items-center justify-center rounded-lg font-medium"
        >
          Add a vehicle in your account
        </Link>
      </Panel>
    );

  const q = attempt?.quote;
  const inputClass = "border-input bg-background h-11 w-full rounded-lg border px-3";
  const isTimeError = Boolean(error && error.title === "Check your times");
  const timeErrorId = `${ids}-time-error`;

  return (
    <Panel>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void getPrice();
        }}
      >
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Rental type</legend>
          <div className="bg-muted grid auto-cols-fr grid-flow-col gap-1 rounded-lg p-1">
            {offered.map((o) => (
              <label
                key={o.type}
                className="has-checked:bg-background has-focus-visible:ring-ring flex h-10 cursor-pointer items-center justify-center rounded-md text-sm font-medium has-checked:shadow-sm has-focus-visible:ring-2"
              >
                <input
                  type="radio"
                  name="rentalType"
                  value={o.type}
                  checked={rentalType === o.type}
                  onChange={() => chooseType(o.type)}
                  className="sr-only"
                />
                {o.label}
              </label>
            ))}
          </div>
        </fieldset>

        {rentalType === "MONTHLY" ? (
          <div className="space-y-1">
            <label htmlFor={`${ids}-month`} className="text-sm font-medium">
              Start date (IST)
            </label>
            <input
              id={`${ids}-month`}
              type="date"
              required
              min={minLocal?.slice(0, 10)}
              value={monthStart}
              onChange={(e) => {
                setMonthStart(e.target.value);
                changed();
              }}
              aria-invalid={isTimeError ? true : undefined}
              aria-describedby={isTimeError ? timeErrorId : undefined}
              className={inputClass}
            />
            {isTimeError && error ? (
              <p id={timeErrorId} className="text-destructive text-sm" role="alert">
                {error.body}
              </p>
            ) : null}
            <p className="text-muted-foreground text-xs">
              One month from 00:00 IST on this date. You renew each month yourself.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            <div className="space-y-1">
              <label htmlFor={`${ids}-start`} className="text-sm font-medium">
                Start (IST)
              </label>
              <input
                id={`${ids}-start`}
                type="datetime-local"
                required
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  changed();
                }}
                aria-invalid={isTimeError ? true : undefined}
                aria-describedby={isTimeError ? timeErrorId : undefined}
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${ids}-end`} className="text-sm font-medium">
                End (IST)
              </label>
              <input
                id={`${ids}-end`}
                type="datetime-local"
                required
                value={end}
                onChange={(e) => {
                  setEnd(e.target.value);
                  changed();
                }}
                aria-invalid={isTimeError ? true : undefined}
                aria-describedby={isTimeError ? timeErrorId : undefined}
                className={inputClass}
              />
              {isTimeError && error ? (
                <p id={timeErrorId} className="text-destructive text-sm" role="alert">
                  {error.body}
                </p>
              ) : null}
            </div>
          </div>
        )}

        <div className="space-y-1">
          <label htmlFor={`${ids}-vehicle`} className="text-sm font-medium">
            Vehicle
          </label>
          <select
            id={`${ids}-vehicle`}
            required
            value={vehicleId}
            onChange={(e) => {
              setVehicleId(e.target.value);
              changed();
            }}
            className={inputClass}
          >
            <option value="" disabled>
              Choose a vehicle
            </option>
            {vehicles.map((v) => {
              const fits = allowedVehicleTypes.includes(v.type);
              return (
                <option key={v.id} value={v.id} disabled={!fits}>
                  {v.nickname ? `${v.nickname} · ` : ""}
                  {v.registration}
                  {fits ? "" : " (doesn't fit this space)"}
                </option>
              );
            })}
          </select>
        </div>

        <Button
          type="submit"
          onClick={() => void getPrice()}
          variant={q ? "outline" : "default"}
          className="h-11 w-full"
          disabled={pending !== null || navigating}
        >
          {pending === "quote" ? "Getting price…" : q ? "Update price" : "Get price"}
        </Button>
      </form>

      <div aria-live="polite" className="mt-4 space-y-4 empty:hidden">
        {taken ? (
          <Alert role="alert">
            <AlertTitle>Just taken</AlertTitle>
            <AlertDescription>
              Someone reserved this time a moment ago. Pick another time and get a new price.
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{error.title}</AlertTitle>
            <AlertDescription>
              <p>{error.body}</p>
              {error.retry ? (
                <Button variant="outline" className="mt-2" onClick={() => void reserve()}>
                  Try again
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {navigating ? <p className="text-muted-foreground text-sm">Opening checkout…</p> : null}
        {pending === "quote" ? (
          <p className="text-muted-foreground text-sm">Calculating your price…</p>
        ) : null}
      </div>

      {q ? (
        <section aria-labelledby={`${ids}-quote`} className="mt-6 space-y-4 border-t pt-4">
          <h3 id={`${ids}-quote`} className="font-semibold">
            Price breakdown
          </h3>
          <dl className="space-y-1 text-sm">
            {q.lineItems.map((li) => (
              <div key={li.code} className="flex justify-between gap-4">
                <dt>{li.label}</dt>
                <dd className="shrink-0">
                  {li.kind === "discount" ? "−" : ""}
                  {formatINR(li.amount.paise)}
                </dd>
              </div>
            ))}
            <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold">
              <dt>Total to pay</dt>
              <dd className="shrink-0">{formatINR(q.total.paise)}</dd>
            </div>
          </dl>
          <p className="text-sm" role="timer" aria-live="off">
            {quoteExpired
              ? "This price has expired. Get a new price to continue."
              : secondsLeft !== null
                ? `Price held for ${formatMmSs(secondsLeft)}`
                : null}
          </p>

          <Terms quote={q} />

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              required
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 size-5 shrink-0"
            />
            <span>I agree to these terms, the cancellation policy, and the overstay rules.</span>
          </label>

          <Button
            className="h-11 w-full"
            disabled={!agreed || quoteExpired || pending !== null || navigating}
            onClick={() => void reserve()}
          >
            {pending === "hold" ? "Reserving…" : `Reserve for ${formatINR(q.total.paise)}`}
          </Button>
          <p className="text-muted-foreground text-xs">
            Reserving holds the space for a few minutes while you pay. You won&apos;t be charged
            yet.
          </p>
        </section>
      ) : null}
    </Panel>
  );
}

/** FR-05/FR-08: end time, grace, overstay, cancellation, and dispute path before payment. */
export function Terms({ quote }: { quote: Pick<Quote, "startAt" | "endAt" | "terms"> }) {
  return (
    <dl className="space-y-3 text-sm">
      <div>
        <dt className="font-medium">Your booking</dt>
        <dd>
          {formatIST(new Date(quote.startAt), "EEE d MMM yyyy, h:mm a")} to{" "}
          <strong>{formatIST(new Date(quote.endAt), "EEE d MMM yyyy, h:mm a")}</strong> IST
        </dd>
      </div>
      <div>
        <dt className="font-medium">Grace period and overstay</dt>
        <dd>
          Please leave by your end time. {quote.terms.overstay} Grace ends at{" "}
          {formatIST(
            new Date(new Date(quote.endAt).getTime() + quote.terms.gracePeriodMinutes * 60_000),
            "h:mm a",
          )}{" "}
          IST.
        </dd>
      </div>
      <div>
        <dt className="font-medium">Cancellation</dt>
        <dd>{quote.terms.cancellation}</dd>
      </div>
      <div>
        <dt className="font-medium">Problems and disputes</dt>
        <dd>{DISPUTE_PATH}</dd>
      </div>
    </dl>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl border p-4 shadow-sm sm:p-6">
      <h2 id="book-title" className="mb-4 text-xl font-semibold">
        Book this space
      </h2>
      {children}
    </div>
  );
}

function describe(e: unknown, fallback: string): { title: string; body: string } {
  if (!(e instanceof ApiError))
    return { title: fallback, body: "Check your connection and try again." };
  switch (e.status) {
    case 401:
      return {
        title: "Please sign in again",
        body: "Your session has ended. Sign in and try again.",
      };
    case 404:
      return { title: fallback, body: "This space or vehicle is no longer available." };
    case 409:
      return {
        title: fallback,
        body: "Another request is still finishing. Try again in a moment.",
      };
    case 429:
      return { title: "Too many attempts", body: "Please wait a minute and try again." };
    case 400:
    case 422:
      return { title: fallback, body: e.message };
    default:
      return { title: fallback, body: "Something went wrong on our side. Try again." };
  }
}
