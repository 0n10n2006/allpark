import Link from "next/link";
import { BadgeCheck, MapPin, ShieldAlert } from "lucide-react";
import type { GetAvailabilityResponse, PublicListing, Quote, Vehicle } from "@/contracts";
import { ReportDialog } from "@/components/reports/report-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatINR } from "@/lib/money";
import { formatIST, startOfDayIST } from "@/lib/time";
import { BookingPanel, type OfferedRental } from "./booking-panel";

const DAY = 24 * 60 * 60 * 1000;

export const VEHICLE_LABELS: Record<string, string> = {
  TWO_WHEELER: "Two-wheeler",
  HATCHBACK: "Hatchback",
  SEDAN: "Sedan",
  SUV: "SUV",
  VAN: "Van",
};

const SPACE_LABELS: Record<string, string> = {
  OPEN: "Open",
  COVERED: "Covered",
  GARAGE: "Garage",
  BASEMENT: "Basement",
  STILT: "Stilt",
  DRIVEWAY: "Driveway",
};

const RENTALS: {
  type: Quote["rentalType"];
  key: keyof PublicListing["prices"];
  label: string;
  unit: string;
}[] = [
  { type: "HOURLY", key: "hourly", label: "Hourly", unit: "hour" },
  { type: "DAILY", key: "daily", label: "Daily", unit: "day" },
  { type: "WEEKLY", key: "weekly", label: "Weekly", unit: "week" },
  { type: "MONTHLY", key: "monthly", label: "Monthly", unit: "month" },
];

type Props = {
  listing: PublicListing;
  availability: GetAvailabilityResponse;
  /** null when signed out. */
  vehicles: Vehicle[] | null;
  now: Date;
  mapboxToken: string | null;
  isSignedIn?: boolean;
};

export function ListingDetail({
  listing,
  availability,
  vehicles,
  now,
  mapboxToken,
  isSignedIn,
}: Props) {
  const offered: OfferedRental[] = RENTALS.flatMap((r) => {
    const price = listing.prices[r.key];
    return price ? [{ type: r.type, label: r.label, unit: r.unit, paise: price.paise }] : [];
  });
  const limits = [
    listing.maxHeightCm && `Height up to ${listing.maxHeightCm} cm`,
    listing.maxWidthCm && `Width up to ${listing.maxWidthCm} cm`,
    listing.maxLengthCm && `Length up to ${listing.maxLengthCm} cm`,
  ].filter(Boolean);
  const amenities = [
    listing.covered && "Covered",
    listing.lit && "Well lit",
    listing.evCharging && "EV charging",
    listing.security && "Security on site",
  ].filter(Boolean);

  return (
    <article className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="min-w-0 space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold break-words">{listing.title}</h1>
          <p className="text-muted-foreground flex items-center gap-1">
            <MapPin aria-hidden="true" className="size-4 shrink-0" />
            {listing.locality}, {listing.city} · {SPACE_LABELS[listing.spaceType]}
          </p>
          <VerificationBadge verified={listing.host.verified} hostName={listing.host.name} />
        </header>

        <Gallery photos={listing.photos} title={listing.title} />

        <Section title="About this space">
          <p className="whitespace-pre-line">{listing.description}</p>
        </Section>

        <Section title="Location">
          {mapboxToken ? (
            // eslint-disable-next-line @next/next/no-img-element -- Mapbox static image, no next/image config
            <img
              src={`https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${listing.approxLng},${listing.approxLat},14/600x300?access_token=${encodeURIComponent(mapboxToken)}`}
              alt={`Map of the area around ${listing.locality}`}
              width={600}
              height={300}
              className="h-auto w-full rounded-lg border"
            />
          ) : null}
          <p className="mt-2">
            In <strong>{listing.locality}</strong>, {listing.city}. The map shows the approximate
            area only. The exact address and access instructions are shared after your booking is
            confirmed.
          </p>
        </Section>

        <Section title="Prices">
          <ul className="space-y-1">
            {offered.map((o) => (
              <li key={o.type}>
                {o.label}: <strong>{formatINR(o.paise)}</strong> per {o.unit}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-2 text-sm">
            Minimum booking {listing.minDurationMinutes} minutes. You see the full price, including
            any fees, before you pay.
          </p>
        </Section>

        <Section title="Vehicles and size limits">
          <p>Fits: {listing.vehicleTypes.map((v) => VEHICLE_LABELS[v]).join(", ")}</p>
          {limits.length ? (
            <ul className="mt-1 list-disc pl-5">
              {limits.map((l) => (
                <li key={String(l)}>{l}</li>
              ))}
            </ul>
          ) : null}
        </Section>

        {amenities.length ? (
          <Section title="Amenities">
            <ul className="flex flex-wrap gap-2">
              {amenities.map((a) => (
                <li key={String(a)} className="bg-muted rounded-full px-3 py-1 text-sm">
                  {a}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {listing.hostRules ? (
          <Section title="Host rules">
            <p className="whitespace-pre-line">{listing.hostRules}</p>
          </Section>
        ) : null}

        <Section title="Cancellation policy">
          <p>{listing.cancellationPolicy.summary}</p>
        </Section>

        <AvailabilityPreview availability={availability} now={now} />

        <div className="border-t pt-4">
          {isSignedIn ? (
            <ReportDialog listingId={listing.id} listingTitle={listing.title} />
          ) : (
            <Link
              href={`/sign-in?callbackUrl=${encodeURIComponent(`/listings/${listing.id}`)}`}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm underline"
            >
              Sign in to report
            </Link>
          )}
        </div>
      </div>

      <aside aria-labelledby="book-title" className="lg:sticky lg:top-24 lg:self-start">
        <BookingPanel
          listingId={listing.id}
          offered={offered}
          vehicles={vehicles}
          allowedVehicleTypes={listing.vehicleTypes}
        />
      </aside>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** FR-11: say exactly what was checked, and nothing more. */
function VerificationBadge({ verified, hostName }: { verified: boolean; hostName: string | null }) {
  return verified ? (
    <p className="flex items-start gap-2 rounded-lg border border-emerald-600/30 bg-emerald-50 p-3 text-sm text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50">
      <BadgeCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        <strong>Verified host{hostName ? `: ${hostName}` : ""}.</strong> ParkShare reviewed this
        host&apos;s identity and contact details. The host declared they have the right to rent this
        space; ParkShare has not inspected the space itself.
      </span>
    </p>
  ) : (
    <p className="flex items-start gap-2 rounded-lg border p-3 text-sm">
      <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>This host&apos;s verification has not been completed yet.</span>
    </p>
  );
}

function Gallery({ photos, title }: { photos: PublicListing["photos"]; title: string }) {
  if (!photos.length)
    return (
      <p className="bg-muted text-muted-foreground rounded-lg p-8 text-center">No photos yet</p>
    );
  return (
    <ul aria-label="Photos" className="grid grid-cols-2 gap-2">
      {photos.map((p, i) => (
        <li key={p.id} className={i === 0 ? "col-span-2" : undefined}>
          {/* eslint-disable-next-line @next/next/no-img-element -- remote host photos, no next/image config */}
          <img
            src={p.url}
            alt={`${title}, photo ${i + 1} of ${photos.length}`}
            loading={i === 0 ? "eager" : "lazy"}
            width={800}
            height={600}
            className="bg-muted aspect-[4/3] h-auto w-full rounded-lg object-cover"
          />
        </li>
      ))}
    </ul>
  );
}

const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** Next 7 days in IST: open hours from the weekly rules, then host blocks and bookings. */
function AvailabilityPreview({
  availability,
  now,
}: {
  availability: GetAvailabilityResponse;
  now: Date;
}) {
  const today = startOfDayIST(now).getTime();
  const days = Array.from({ length: 7 }, (_, i) => {
    // IST has no DST, so every day is exactly 24 h.
    const start = today + i * DAY;
    const end = start + DAY;
    const weekday = Number(formatIST(new Date(start), "i")) % 7; // ISO 1–7 → 0 = Sunday
    const open = availability.rules
      .filter((r) => r.weekday === weekday)
      .map((r) =>
        r.startMinute === 0 && r.endMinute === 1440
          ? "Open 24 hours"
          : `${hhmm(r.startMinute)}–${hhmm(r.endMinute)}`,
      );
    const clip = (s: string, e: string) => {
      const a = Math.max(new Date(s).getTime(), start);
      const b = Math.min(new Date(e).getTime(), end);
      return a < b
        ? `${formatIST(new Date(a), "HH:mm")}–${b === end ? "24:00" : formatIST(new Date(b), "HH:mm")}`
        : null;
    };
    const blocked = availability.exceptions
      .filter((x) => x.unavailable)
      .map((x) => clip(x.startAt, x.endAt))
      .filter(Boolean);
    const booked = availability.busy.map((b) => clip(b.startAt, b.endAt)).filter(Boolean);
    return { start, open, blocked, booked };
  });

  return (
    <Section title="Availability, next 7 days">
      <p className="text-muted-foreground text-sm">Times are in India Standard Time (IST).</p>
      <ul className="divide-y rounded-lg border">
        {days.map((d) => (
          <li key={d.start} className="grid gap-1 p-3 sm:grid-cols-[8rem_1fr]">
            <span className="font-medium">{formatIST(new Date(d.start), "EEE d MMM")}</span>
            <span className="text-sm">
              {d.open.length ? d.open.join(", ") : "Closed"}
              {d.blocked.length ? (
                <span className="block">Blocked by host: {d.blocked.join(", ")}</span>
              ) : null}
              {d.booked.length ? (
                <span className="block">Already booked: {d.booked.join(", ")}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function ListingSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading listing"
      className="grid gap-8 lg:grid-cols-[1fr_24rem]"
    >
      <div className="space-y-4">
        <Skeleton className="h-9 w-3/4" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="aspect-[4/3] w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton className="h-96 w-full" />
    </div>
  );
}
