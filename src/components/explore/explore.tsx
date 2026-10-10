"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LocateFixed, MapPinOff, Search } from "lucide-react";
import type { ListingCard as Card, SearchListingsResponse } from "@/contracts";
import { api } from "@/lib/api-client";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FiltersSheet } from "./filters-sheet";
import { ListingCard, priceLabel } from "./listing-card";
import { PUNE_LOCALITIES, findLocality, type Place } from "./localities";
import { AREA_RADIUS_M, apiQuery, areaCentre, withArea, withFilters } from "./query";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
const ExploreMap = dynamic(() => import("./explore-map"), {
  ssr: false,
  loading: () => <Skeleton className="h-full min-h-72 w-full rounded-xl" />,
});

const fetchPage = (params: URLSearchParams, cursor: string | null) =>
  api<SearchListingsResponse>(`/api/listings?${apiQuery(params, cursor)}`);

/** Mapbox geocoding limited to Pune; without a token, the built-in locality list. */
async function geocode(text: string): Promise<Place | null> {
  if (!MAPBOX_TOKEN) return findLocality(text);
  const url = new URL(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(text)}.json`,
  );
  url.search = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    bbox: "73.7,18.4,74.05,18.65",
    country: "in",
    limit: "1",
  }).toString();
  try {
    const res = await fetch(url);
    const hit = res.ok ? (await res.json()).features?.[0] : null;
    if (hit) return { name: hit.text ?? text, lng: hit.center[0], lat: hit.center[1] };
  } catch {}
  return findLocality(text);
}

type Results = { key: string; items: Card[]; nextCursor: string | null; error: string | null };
type GeoState = "idle" | "locating" | "denied" | "unavailable";

export function Explore() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const key = params.toString();

  const [results, setResults] = useState<Results | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState<"idle" | "loading" | "error">("idle");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [geo, setGeo] = useState<GeoState>("idle");
  const [notFound, setNotFound] = useState<string | null>(null);

  // First page whenever the URL query changes; a stale response is dropped.
  useEffect(() => {
    let live = true;
    fetchPage(new URLSearchParams(key), null).then(
      (p) => live && setResults({ key, ...p, error: null }),
      (e: Error) => live && setResults({ key, items: [], nextCursor: null, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [key, attempt]);

  const loading = results?.key !== key;
  const navigate = (next: URLSearchParams) => {
    setMore("idle");
    router.push(`${pathname}?${next.toString()}`);
  };

  async function loadMore() {
    if (!results?.nextCursor) return;
    setMore("loading");
    try {
      const p = await fetchPage(params, results.nextCursor);
      setResults((r) =>
        r && r.key === key
          ? { ...r, items: [...r.items, ...p.items], nextCursor: p.nextCursor }
          : r,
      );
      setMore("idle");
    } catch {
      setMore("error");
    }
  }

  async function searchText(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = String(new FormData(e.currentTarget).get("area") ?? "").trim();
    if (!text) return;
    const place = await geocode(text);
    setNotFound(place ? null : text);
    if (place)
      navigate(
        withArea(params, {
          q: place.name,
          lat: place.lat,
          lng: place.lng,
          radiusMeters: AREA_RADIUS_M,
        }),
      );
  }

  // FR-03 AC4 + privacy: one position request per click, never watched, coarsened before
  // it goes into a shareable URL.
  function locateMe() {
    if (!("geolocation" in navigator)) return setGeo("unavailable");
    setGeo("locating");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setGeo("idle");
        const round = (v: number) => Math.round(v * 1000) / 1000;
        navigate(
          withArea(params, {
            q: "Near you",
            lat: round(coords.latitude),
            lng: round(coords.longitude),
            radiusMeters: AREA_RADIUS_M,
          }),
        );
      },
      (err) => setGeo(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable"),
      { timeout: 10_000, maximumAge: 300_000 },
    );
  }

  const items = results && !loading ? results.items : [];
  const rentalType = params.get("rentalType");
  const hasTimes = params.has("startAt");
  const area = params.get("q");

  const list = (
    <section aria-labelledby="results-heading" className="min-w-0">
      <h2 id="results-heading" className="sr-only">
        Results
      </h2>
      <p className="text-muted-foreground mb-3 text-sm" aria-live="polite">
        {loading
          ? "Searching…"
          : results?.error
            ? ""
            : `${items.length}${results?.nextCursor ? "+" : ""} spaces${area ? ` near ${area}` : " in Pune"}`}
      </p>
      {loading ? (
        <ul className="grid gap-3" aria-busy="true" aria-label="Loading results">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex gap-3 rounded-xl border p-3">
              <Skeleton className="size-24 shrink-0 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-1/4" />
              </div>
            </li>
          ))}
        </ul>
      ) : results?.error ? (
        <ErrorState
          message={results.error}
          onRetry={() => {
            setResults(null);
            setAttempt((a) => a + 1);
          }}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={MapPinOff}
          title="No spaces found"
          body="No spaces here for those times — try widening the area or changing times."
        />
      ) : (
        <>
          <ul className="grid gap-3" aria-label="Parking spaces">
            {items.map((card) => (
              <ListingCard
                key={card.id}
                card={card}
                price={priceLabel(card, rentalType, hasTimes)}
                selected={card.id === selectedId}
                onSelect={() => setSelectedId(card.id)}
              />
            ))}
          </ul>
          {results?.nextCursor ? (
            <div className="mt-4 flex flex-col items-center gap-2">
              {more === "error" ? (
                <p role="alert" className="text-destructive text-sm">
                  Couldn&apos;t load more spaces.
                </p>
              ) : null}
              <Button
                variant="outline"
                className="min-h-11"
                disabled={more === "loading"}
                onClick={loadMore}
              >
                {more === "loading" ? "Loading…" : more === "error" ? "Try again" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );

  return (
    <div className="mt-6 grid gap-4">
      <div className="flex flex-wrap gap-2">
        <form role="search" onSubmit={searchText} className="contents">
          <label htmlFor="area" className="sr-only">
            Area or landmark in Pune
          </label>
          <Input
            id="area"
            name="area"
            list="pune-localities"
            defaultValue={area && area !== "Near you" && area !== "Map area" ? area : ""}
            key={area ?? ""}
            placeholder="Area or landmark, e.g. Baner"
            autoComplete="off"
            className="h-11 min-w-0 flex-[1_1_12rem]"
          />
          <datalist id="pune-localities">
            {PUNE_LOCALITIES.map((l) => (
              <option key={l.name} value={l.name} />
            ))}
          </datalist>
          <Button type="submit" className="min-h-11">
            <Search aria-hidden="true" />
            Search
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={locateMe}
            disabled={geo === "locating"}
          >
            <LocateFixed aria-hidden="true" />
            {geo === "locating" ? "Locating…" : "Use my location"}
          </Button>
        </form>
        {/* Outside the search form: the sheet's form is portalled, but React still bubbles
            its submit event up the component tree. */}
        <FiltersSheet params={params} onApply={(f) => navigate(withFilters(params, f))} />
      </div>
      <div aria-live="polite" className="empty:hidden">
        {geo === "denied" ? (
          <p className="bg-muted rounded-lg p-3 text-sm">
            Location access is blocked. You can still search by area or landmark above.
          </p>
        ) : geo === "unavailable" ? (
          <p className="bg-muted rounded-lg p-3 text-sm">
            We couldn&apos;t get your location. Search by area or landmark instead.
          </p>
        ) : notFound ? (
          <p className="bg-muted rounded-lg p-3 text-sm">
            We couldn&apos;t find &ldquo;{notFound}&rdquo; in Pune. Try a locality such as Baner,
            Kothrud, or Viman Nagar.
          </p>
        ) : null}
      </div>

      {MAPBOX_TOKEN ? (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          {list}
          <div className="order-first h-72 md:sticky md:top-20 md:order-none md:h-[calc(100dvh-7rem)]">
            <ExploreMap
              token={MAPBOX_TOKEN}
              items={items}
              centre={areaCentre(params)}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                document
                  .getElementById(`card-${id}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
              }}
              onSearchArea={(bbox) => navigate(withArea(params, { q: "Map area", ...bbox }))}
            />
          </div>
        </div>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">Map unavailable in this environment.</p>
          {list}
        </>
      )}
    </div>
  );
}
