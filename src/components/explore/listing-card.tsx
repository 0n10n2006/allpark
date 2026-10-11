import Link from "next/link";
import { Navigation } from "lucide-react";
import type { ListingCard as Card } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";

const UNIT: Record<string, string> = {
  HOURLY: "/ hour",
  DAILY: "/ day",
  MULTI_DAY: "/ day",
  WEEKLY: "/ week",
  MONTHLY: "/ month",
};

/** "₹120 total" for a priced interval, "₹40 / hour" for a type, else "from ₹20". */
export function priceLabel(card: Card, rentalType: string | null, hasTimes: boolean) {
  if (!card.priceFrom) return "Price on request";
  const amount = formatINR(card.priceFrom.paise);
  if (rentalType && hasTimes) return `${amount} total`;
  if (rentalType) return `${amount} ${UNIT[rentalType] ?? ""}`.trim();
  return `from ${amount}`;
}

function distanceLabel(m: number) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m away` : `${(m / 1000).toFixed(1)} km away`;
}

export function ListingCard({
  card,
  price,
  selected,
  onSelect,
}: {
  card: Card;
  price: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${card.approxLat},${card.approxLng}`;
  return (
    <li
      id={`card-${card.id}`}
      onMouseEnter={onSelect}
      onFocus={onSelect}
      className={cn(
        "bg-card relative flex gap-3 rounded-xl border p-3 transition-shadow",
        selected && "ring-primary ring-2",
      )}
    >
      {card.photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote host photos, no remotePatterns
        <img
          src={card.photoUrl}
          alt=""
          loading="lazy"
          className="bg-muted size-24 shrink-0 rounded-lg object-cover sm:size-28"
        />
      ) : (
        <div className="bg-muted size-24 shrink-0 rounded-lg sm:size-28" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 className="text-base leading-snug font-semibold">
          <Link
            href={`/listings/${card.id}`}
            className="after:absolute after:inset-0 after:rounded-xl focus-visible:underline"
          >
            {card.title}
          </Link>
        </h2>
        <p className="text-muted-foreground text-sm">
          {card.locality}
          {card.distanceMeters !== null ? ` · ${distanceLabel(card.distanceMeters)}` : null}
        </p>
        <p className="font-semibold">{price}</p>
        <ul className="flex flex-wrap gap-1" aria-label="Restrictions and features">
          <li>
            <Badge variant="secondary">{card.covered ? "Covered" : "Open-air"}</Badge>
          </li>
          {card.maxHeightCm ? (
            <li>
              <Badge variant="outline">Height limit {(card.maxHeightCm / 100).toFixed(1)} m</Badge>
            </li>
          ) : null}
        </ul>
        <a
          href={directions}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary relative z-10 mt-1 inline-flex w-fit items-center gap-1 text-sm underline-offset-4 hover:underline"
        >
          <Navigation aria-hidden="true" className="size-3.5" />
          Directions to area (approximate)
        </a>
      </div>
    </li>
  );
}
