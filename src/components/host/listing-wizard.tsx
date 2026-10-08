"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { ExternalLink, Lock } from "lucide-react";
import type {
  GetAvailabilityResponse,
  HostStatusResponse,
  ListingPhoto,
  MyListingsResponse,
  OwnedListing,
} from "@/contracts";
import { ErrorState } from "@/components/common/error-state";
import { LoadingState } from "@/components/common/loading-state";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatINR } from "@/lib/money";
import { ApiError, type Issue, api, errorMessage } from "./api";
import {
  AvailabilityEditor,
  EMPTY_SCHEDULE,
  type Schedule,
  fromAvailability,
  scheduleErrors,
  toAvailabilityBody,
} from "./availability-editor";
import {
  EMPTY_FORM,
  type FieldErrors,
  type Form,
  STEPS,
  type StepKey,
  fromListing,
  isStep,
  issueErrors,
  stepOf,
  stepPatch,
  validate,
} from "./form";
import { SPACE_TYPES, STATUS_LABELS, VEHICLE_TYPES } from "./labels";
import { PhotoManager } from "./photo-manager";

const LocationMap = dynamic(() => import("./location-map"), {
  ssr: false,
  loading: () => <div className="bg-muted h-72 animate-pulse rounded-lg" aria-hidden="true" />,
});
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
const CREATE_AT: StepKey = "vehicles";
const tap = "min-h-11";

/** The owner shape only comes from /mine, so page through it to find this listing. */
async function findOwned(id: string): Promise<OwnedListing> {
  let cursor: string | null = null;
  do {
    const q: string = cursor ? `&cursor=${cursor}` : "";
    const page: MyListingsResponse = await api(`/api/listings/mine?limit=100${q}`);
    const hit = page.items.find((l) => l.id === id);
    if (hit) return hit;
    cursor = page.nextCursor;
  } while (cursor);
  throw new ApiError(404, "not_found", "We couldn't find that listing in your account.");
}

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; host: HostStatusResponse };

export function ListingWizard({ mode }: { mode: "new" | "edit" }) {
  const params = useParams<{ id?: string }>();
  const search = useSearchParams();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [listing, setListing] = useState<OwnedListing | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [photos, setPhotos] = useState<ListingPhoto[]>([]);
  const [schedule, setSchedule] = useState<Schedule>(EMPTY_SCHEDULE);
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [scheduleLoaded, setScheduleLoaded] = useState(true);
  const [attested, setAttested] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [publishIssues, setPublishIssues] = useState<Issue[] | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const raw = search.get("step");
  const maxIdx = listing ? STEPS.length - 1 : STEPS.findIndex((s) => s.key === CREATE_AT);
  const wanted = isStep(raw) ? STEPS.findIndex((s) => s.key === raw) : 0;
  const idx = Math.min(wanted, maxIdx);
  const step = STEPS[idx].key;

  const fetchAll = useCallback(async () => {
    try {
      const host = await api<HostStatusResponse>("/api/me");
      if (mode === "edit" && params.id) {
        const l = await findOwned(params.id);
        setListing(l);
        setForm(fromListing(l));
        setPhotos(l.photos);
        setAttested(l.hostAttestedAt !== null);
        try {
          setSchedule(
            fromAvailability(
              await api<GetAvailabilityResponse>(`/api/listings/${l.id}/availability`),
            ),
          );
          setScheduleLoaded(true);
        } catch {
          // ponytail: GET availability is still a stub (T2.1); unchanged steps don't overwrite.
          setScheduleLoaded(false);
        }
      }
      setLoad({ kind: "ready", host });
    } catch (e) {
      setLoad({ kind: "error", message: errorMessage(e) });
    }
  }, [mode, params.id]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (firstRender.current) firstRender.current = false;
    else headingRef.current?.focus();
  }, [step]);

  const pathFor = (id: string | undefined) =>
    id ? `/host/listings/${id}/edit` : "/host/listings/new";
  const hrefFor = (s: StepKey) => `${pathFor(listing?.id)}?step=${s}`;
  const go = (s: StepKey, id = listing?.id) =>
    window.history.pushState(null, "", `${pathFor(id)}?step=${s}`);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  /** Replace this step's errors, keep the other steps' (e.g. from a publish attempt). */
  const showErrors = (errs: FieldErrors, s: StepKey = step) =>
    setErrors((prev) => ({
      ...Object.fromEntries(Object.entries(prev).filter(([k]) => stepOf([k]) !== s)),
      ...errs,
    }));

  if (load.kind === "loading") return <LoadingState label="Loading the listing editor" />;
  if (load.kind === "error")
    return (
      <ErrorState
        message={load.message}
        onRetry={() => {
          setLoad({ kind: "loading" });
          void fetchAll();
        }}
      />
    );
  const host = load.host;
  if (!host.roles.includes("HOST"))
    return (
      <section className="rounded-xl border p-6">
        <h2 className="font-semibold">Become a host first</h2>
        <p className="mt-1 text-sm">You need a host account before you can create a listing.</p>
        <Link href="/host" className={buttonVariants({ className: `${tap} mt-4 px-4` })}>
          Go to host onboarding
        </Link>
      </section>
    );

  const next = STEPS[idx + 1]?.key;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !next) return;
    setSaveError(null);
    setSaving(true);
    try {
      if (step === "availability") {
        const errs = scheduleErrors(schedule);
        setRowErrors(errs);
        if (Object.keys(errs).length) return;
        if (listing && scheduleDirty) {
          const r = await api<GetAvailabilityResponse>(
            `/api/listings/${listing.id}/availability`,
            "POST",
            toAvailabilityBody(schedule),
          );
          setSchedule(fromAvailability(r));
          setScheduleDirty(false);
          setScheduleLoaded(true);
        }
        showErrors({});
        return go(next);
      }
      if (step === "photos") return go(next);
      const patch = stepPatch(step, form)!;
      if (!listing && step !== CREATE_AT) {
        const errs = validate(patch, form, false);
        showErrors(errs);
        if (!Object.keys(errs).length) go(next);
        return;
      }
      if (!listing) {
        const body = {
          ...stepPatch("basics", form),
          ...stepPatch("location", form),
          ...patch,
        };
        const errs = validate(body, form, true);
        if (Object.keys(errs).length) {
          setErrors(errs);
          const first = stepOf([Object.keys(errs)[0]]);
          if (first !== step)
            setSaveError(`Fix the ${STEPS.find((s) => s.key === first)!.label} step first.`);
          return;
        }
        const created = await api<OwnedListing>("/api/listings", "POST", body);
        setListing(created);
        setPhotos(created.photos);
        setErrors({});
        return go(next, created.id);
      }
      const errs = validate(patch, form, false);
      showErrors(errs);
      if (Object.keys(errs).length) return;
      const updated = await api<OwnedListing>(`/api/listings/${listing.id}`, "PATCH", patch);
      setListing(updated);
      go(next);
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) setErrors(issueErrors(err.issues));
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!listing) return;
    setSaveError(null);
    setNeedsVerification(false);
    if (!attested) {
      const issues = [
        { path: ["attestAuthority"], message: "Confirm you're authorized to rent out this space" },
      ];
      setPublishIssues(issues);
      setErrors((p) => ({ ...p, ...issueErrors(issues) }));
      return;
    }
    setSaving(true);
    try {
      const l = await api<OwnedListing>(`/api/listings/${listing.id}/publish`, "POST", {
        attestAuthority: true,
      });
      setListing(l);
      setPublishIssues(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setNeedsVerification(true);
      else if (err instanceof ApiError && err.issues.length) {
        setPublishIssues(err.issues);
        setErrors((p) => ({ ...p, ...issueErrors(err.issues) }));
      } else setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // ── Field helpers ──
  const fieldProps = (k: string, hint?: boolean) => ({
    id: `f-${k}`,
    "aria-invalid": errors[k] ? true : undefined,
    "aria-describedby":
      [hint ? `f-${k}-hint` : "", errors[k] ? `f-${k}-err` : ""].filter(Boolean).join(" ") ||
      undefined,
  });
  const fieldError = (k: string) =>
    errors[k] ? (
      <p id={`f-${k}-err`} className="text-destructive text-sm">
        {errors[k]}
      </p>
    ) : null;
  const text = (
    k: keyof Form,
    label: string,
    opts: {
      hint?: string;
      type?: string;
      area?: boolean;
      inputMode?: "decimal" | "numeric";
      maxLength?: number;
    } = {},
  ) => {
    const Comp = opts.area ? Textarea : Input;
    return (
      <div className="grid gap-1">
        <label htmlFor={`f-${k}`} className="font-medium">
          {label}
        </label>
        {opts.hint ? (
          <p id={`f-${k}-hint`} className="text-muted-foreground text-sm">
            {opts.hint}
          </p>
        ) : null}
        <Comp
          {...fieldProps(k, !!opts.hint)}
          className={opts.area ? "min-h-28" : tap}
          type={opts.type}
          inputMode={opts.inputMode}
          maxLength={opts.maxLength}
          value={form[k] as string}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set(k, e.target.value as Form[typeof k])
          }
        />
        {fieldError(k)}
      </div>
    );
  };
  const check = (k: "covered" | "lit" | "evCharging" | "security", label: string) => (
    <label className={`flex items-center gap-3 ${tap}`}>
      <input
        type="checkbox"
        className="size-5"
        checked={form[k]}
        onChange={(e) => set(k, e.target.checked)}
      />
      {label}
    </label>
  );
  const price = (k: "hourly" | "daily" | "weekly" | "monthly", label: string) => (
    <div className="grid gap-1">
      <label htmlFor={`f-${k}Paise`} className="font-medium">
        {label} (₹)
      </label>
      <Input
        {...fieldProps(`${k}Paise`)}
        className={tap}
        type="number"
        min={0}
        step="0.01"
        inputMode="decimal"
        placeholder="Not offered"
        value={form[k]}
        onChange={(e) => set(k, e.target.value)}
      />
      {fieldError(`${k}Paise`)}
    </div>
  );

  const lat = form.lat.trim() === "" ? NaN : Number(form.lat);
  const lng = form.lng.trim() === "" ? NaN : Number(form.lng);

  const body = (() => {
    switch (step) {
      case "basics":
        return (
          <>
            {text("title", "Title", {
              hint: "e.g. Covered car spot near Kothrud depot",
              maxLength: 120,
            })}
            {text("description", "Description", {
              area: true,
              hint: "What renters should know: size, surface, nearby landmarks.",
              maxLength: 5000,
            })}
            <div className="grid gap-1">
              <label htmlFor="f-spaceType" className="font-medium">
                Space type
              </label>
              <select
                {...fieldProps("spaceType")}
                className={`${tap} border-input bg-background rounded-lg border px-2`}
                value={form.spaceType}
                onChange={(e) => set("spaceType", e.target.value as Form["spaceType"])}
              >
                <option value="">Choose a space type</option>
                {Object.entries(SPACE_TYPES).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              {fieldError("spaceType")}
            </div>
          </>
        );
      case "location":
        return (
          <>
            <p className="flex gap-2 rounded-lg border p-3 text-sm">
              <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              The exact address is only shown to confirmed renters. Before booking, renters see the
              locality and a pin rounded to about 300 m.
            </p>
            {text("address", "Full address", { area: true, maxLength: 500 })}
            {text("locality", "Locality", {
              hint: "Shown publicly, e.g. Kothrud or Baner.",
              maxLength: 120,
            })}
            {MAPBOX_TOKEN ? (
              <LocationMap
                token={MAPBOX_TOKEN}
                lat={Number.isFinite(lat) ? lat : null}
                lng={Number.isFinite(lng) ? lng : null}
                onPick={(la, ln) => setForm((f) => ({ ...f, lat: String(la), lng: String(ln) }))}
              />
            ) : (
              <p className="text-sm">
                Find your spot on a map, then copy its coordinates:{" "}
                <a
                  className="text-primary inline-flex min-h-11 items-center gap-1 underline"
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(form.address || "Pune")}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Find on map <ExternalLink aria-hidden="true" className="size-4" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
                . In Google Maps, right-click the exact spot and click the numbers to copy them.
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {text("lat", "Latitude", { inputMode: "decimal", hint: "e.g. 18.5204" })}
              {text("lng", "Longitude", { inputMode: "decimal", hint: "e.g. 73.8567" })}
            </div>
          </>
        );
      case "vehicles":
        return (
          <>
            <fieldset
              className="grid gap-1"
              aria-describedby={errors.vehicleTypes ? "f-vehicleTypes-err" : undefined}
            >
              <legend className="font-medium">Vehicles that fit</legend>
              {Object.entries(VEHICLE_TYPES).map(([v, l]) => (
                <label key={v} className={`flex items-center gap-3 ${tap}`}>
                  <input
                    type="checkbox"
                    className="size-5"
                    checked={form.vehicleTypes.includes(v as keyof typeof VEHICLE_TYPES)}
                    onChange={(e) =>
                      set(
                        "vehicleTypes",
                        e.target.checked
                          ? [...form.vehicleTypes, v as keyof typeof VEHICLE_TYPES]
                          : form.vehicleTypes.filter((x) => x !== v),
                      )
                    }
                  />
                  {l}
                </label>
              ))}
              {fieldError("vehicleTypes")}
            </fieldset>
            <fieldset className="grid gap-4 sm:grid-cols-3">
              <legend className="mb-1 font-medium">Size limits in cm (leave blank if none)</legend>
              {text("maxHeightCm", "Max height", { inputMode: "numeric" })}
              {text("maxWidthCm", "Max width", { inputMode: "numeric" })}
              {text("maxLengthCm", "Max length", { inputMode: "numeric" })}
            </fieldset>
            <fieldset className="grid gap-1">
              <legend className="font-medium">Features</legend>
              {check("covered", "Covered")}
              {check("lit", "Well lit")}
              {check("evCharging", "EV charging")}
              {check("security", "Security (guard or CCTV)")}
            </fieldset>
          </>
        );
      case "pricing":
        return (
          <>
            <p className="text-muted-foreground text-sm">
              Set a price for each rental type you offer; leave a type blank to not offer it.
            </p>
            {errors.prices ? (
              <p id="f-prices-err" className="text-destructive text-sm">
                {errors.prices}
              </p>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              {price("hourly", "Per hour")}
              {price("daily", "Per day")}
              {price("weekly", "Per week")}
              {price("monthly", "Per month")}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {text("minDurationMinutes", "Minimum booking (minutes)", {
                type: "number",
                inputMode: "numeric",
              })}
              {text("turnoverBufferMinutes", "Gap between bookings (minutes)", {
                type: "number",
                inputMode: "numeric",
                hint: "Time kept free after each booking, 0–240.",
              })}
            </div>
          </>
        );
      case "availability":
        return (
          <>
            {!scheduleLoaded && !scheduleDirty ? (
              <p className="rounded-lg border p-3 text-sm">
                Your saved schedule can&apos;t be displayed here yet. Leave this step as it is to
                keep it; any change you make here replaces the whole schedule.
              </p>
            ) : null}
            {errors.availability ? (
              <p className="text-destructive text-sm">{errors.availability}</p>
            ) : null}
            <AvailabilityEditor
              value={schedule}
              errors={rowErrors}
              onChange={(s) => {
                setSchedule(s);
                setScheduleDirty(true);
              }}
            />
          </>
        );
      case "photos":
        return (
          <>
            {errors.photos ? <p className="text-destructive text-sm">{errors.photos}</p> : null}
            <PhotoManager listingId={listing!.id} photos={photos} onChange={setPhotos} />
          </>
        );
      case "access":
        return (
          <>
            {text("accessInstructions", "Access instructions", {
              area: true,
              maxLength: 2000,
              hint: "Private: only shared with renters after their booking is confirmed. Gate codes, where to find the key, whom to call.",
            })}
            {text("hostRules", "Rules for renters", {
              area: true,
              maxLength: 2000,
              hint: "Shown publicly, e.g. no washing cars, no overnight stays.",
            })}
            <div className="grid gap-1">
              <label htmlFor="f-cancellationPolicy" className="font-medium">
                Cancellation policy
              </label>
              <select
                {...fieldProps("cancellationPolicy", true)}
                className={`${tap} border-input bg-background rounded-lg border px-2`}
                value={form.cancellationPolicy}
                onChange={(e) => set("cancellationPolicy", e.target.value)}
              >
                <option value="standard">Standard</option>
              </select>
              <p id="f-cancellationPolicy-hint" className="text-muted-foreground text-sm">
                Hourly: full refund up to 2 h before start. Daily: full refund up to 24 h before,
                50% up to 2 h before. Monthly: full refund up to 7 days before.
              </p>
            </div>
            <label className={`flex items-start gap-3 ${tap}`}>
              <input
                id="f-attestAuthority"
                type="checkbox"
                className="mt-1 size-5 shrink-0"
                checked={attested}
                aria-invalid={errors.attestAuthority ? true : undefined}
                aria-describedby={errors.attestAuthority ? "f-attestAuthority-err" : undefined}
                onChange={(e) => {
                  setAttested(e.target.checked);
                  if (e.target.checked) setErrors((p) => ({ ...p, attestAuthority: "" }));
                }}
              />
              <span>
                I&apos;m authorized to rent out this space (I own it, or the owner or society allows
                it). Recorded when you publish.
              </span>
            </label>
            {fieldError("attestAuthority")}
          </>
        );
      case "review":
        return listing ? (
          <Review listing={listing} photos={photos} attested={attested} hrefFor={hrefFor} go={go} />
        ) : null;
    }
  })();

  return (
    <div className="space-y-6">
      <nav aria-label="Listing steps">
        <ol className="flex gap-2 overflow-x-auto pb-2">
          {STEPS.map((s, i) => {
            const reachable = i <= maxIdx;
            const label = (
              <>
                <span className="tabular-nums">{i + 1}.</span> {s.label}
              </>
            );
            const cls = `flex min-h-11 items-center whitespace-nowrap rounded-full border px-3 text-sm ${i === idx ? "bg-primary text-primary-foreground border-primary" : ""}`;
            return (
              <li key={s.key}>
                {reachable ? (
                  <a
                    href={hrefFor(s.key)}
                    aria-current={i === idx ? "step" : undefined}
                    className={cls}
                    onClick={(e) => {
                      e.preventDefault();
                      go(s.key);
                    }}
                  >
                    {label}
                  </a>
                ) : (
                  <span className={`${cls} text-muted-foreground`}>{label}</span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {listing ? (
        <p className="text-sm">
          Status: <Badge variant="secondary">{STATUS_LABELS[listing.status]}</Badge>
          {step !== "review" ? " · Changes are saved as a draft when you continue." : null}
        </p>
      ) : null}

      <form onSubmit={submit} noValidate className="space-y-6">
        <fieldset className="space-y-4">
          <legend className="sr-only">
            Step {idx + 1} of {STEPS.length}: {STEPS[idx].label}
          </legend>
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
            Step {idx + 1} of {STEPS.length}: {STEPS[idx].label}
          </h2>
          {body}
        </fieldset>

        {saveError ? (
          <p role="alert" className="text-destructive text-sm">
            {saveError}
          </p>
        ) : null}

        {step === "review" ? (
          <PublishPanel
            listing={listing!}
            host={host}
            saving={saving}
            issues={publishIssues}
            needsVerification={needsVerification}
            hrefFor={hrefFor}
            go={go}
            onPublish={() => void publish()}
          />
        ) : null}

        <div className="flex flex-wrap gap-3">
          {idx > 0 ? (
            <Button
              type="button"
              variant="outline"
              className={`${tap} px-4`}
              onClick={() => go(STEPS[idx - 1].key)}
            >
              Back
            </Button>
          ) : null}
          {next ? (
            <Button type="submit" className={`${tap} px-4`} disabled={saving}>
              {saving
                ? "Saving…"
                : !listing && step !== CREATE_AT
                  ? "Continue"
                  : "Save and continue"}
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

type Nav = { hrefFor: (s: StepKey) => string; go: (s: StepKey) => void };

function StepLink({ s, hrefFor, go, children }: Nav & { s: StepKey; children: React.ReactNode }) {
  return (
    <a
      href={hrefFor(s)}
      className="text-primary inline-flex min-h-11 items-center underline"
      onClick={(e) => {
        e.preventDefault();
        go(s);
      }}
    >
      {children}
    </a>
  );
}

function Review({
  listing,
  photos,
  attested,
  ...nav
}: Nav & {
  listing: OwnedListing;
  photos: ListingPhoto[];
  attested: boolean;
}) {
  const prices = (["hourly", "daily", "weekly", "monthly"] as const).flatMap((k) => {
    const p = listing.prices[k];
    return p ? [`${formatINR(p.paise)} ${k}`] : [];
  });
  const rows: [StepKey, string, string][] = [
    ["basics", "Title", listing.title],
    ["basics", "Space type", SPACE_TYPES[listing.spaceType]],
    ["location", "Locality", `${listing.locality}, ${listing.city}`],
    ["vehicles", "Vehicles", listing.vehicleTypes.map((v) => VEHICLE_TYPES[v]).join(", ")],
    ["pricing", "Prices", prices.join(" · ") || "None set"],
    ["photos", "Photos", `${photos.length}`],
    ["access", "Authority attested", attested ? "Yes" : "Not yet"],
  ];
  return (
    <dl className="divide-y rounded-lg border">
      {rows.map(([s, k, v]) => (
        <div key={k} className="flex flex-wrap items-center gap-x-4 px-3 py-1">
          <dt className="w-40 font-medium">{k}</dt>
          <dd className="min-w-0 flex-1 break-words">{v}</dd>
          <dd>
            <StepLink s={s} {...nav}>
              Edit<span className="sr-only"> {k}</span>
            </StepLink>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function PublishPanel({
  listing,
  host,
  saving,
  issues,
  needsVerification,
  onPublish,
  ...nav
}: Nav & {
  listing: OwnedListing;
  host: HostStatusResponse;
  saving: boolean;
  issues: Issue[] | null;
  needsVerification: boolean;
  onPublish: () => void;
}) {
  if (listing.status === "PUBLISHED")
    return (
      <section
        role="status"
        className="rounded-lg border border-emerald-600/40 bg-emerald-50 p-4 dark:bg-emerald-950/30"
      >
        <h3 className="font-semibold">Your listing is published</h3>
        <p className="mt-1 text-sm">Renters can now find and book it.</p>
        <Link
          href="/host"
          className={buttonVariants({ variant: "outline", className: `${tap} mt-3` })}
        >
          Back to my listings
        </Link>
      </section>
    );
  const verified = host.hostVerificationStatus === "VERIFIED";
  return (
    <section className="space-y-3">
      {!verified ? (
        <p className="rounded-lg border p-3 text-sm">
          Your draft is saved. You can publish once ParkShare verifies your host account (status:{" "}
          {host.hostVerificationStatus.toLowerCase().replace("_", " ")}).
        </p>
      ) : null}
      {needsVerification ? (
        <div role="alert" className="border-destructive/40 bg-destructive/10 rounded-lg border p-4">
          <h3 className="font-semibold">Host verification required</h3>
          <p className="mt-1 text-sm">
            Only verified hosts can publish listings. Your draft is saved; you can publish it after
            a ParkShare admin approves your host application.{" "}
            <Link href="/host" className="underline">
              See your verification status
            </Link>
          </p>
        </div>
      ) : null}
      {issues?.length ? (
        <div role="alert" className="border-destructive/40 bg-destructive/10 rounded-lg border p-4">
          <h3 className="font-semibold">Fix these before publishing</h3>
          <ul className="mt-2 space-y-1">
            {issues.map((i, k) => {
              const s = stepOf(i.path);
              return (
                <li key={k} className="text-sm">
                  {i.message}:{" "}
                  <StepLink s={s} {...nav}>
                    go to {STEPS.find((x) => x.key === s)!.label}
                  </StepLink>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <Button type="button" className={`${tap} px-6`} disabled={saving} onClick={onPublish}>
        {saving ? "Publishing…" : "Publish listing"}
      </Button>
    </section>
  );
}
