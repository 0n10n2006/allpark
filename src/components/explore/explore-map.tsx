"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useRef, useState } from "react";
import Map, { Marker, NavigationControl, type MapRef } from "react-map-gl/mapbox";
import type { ListingCard } from "@/contracts";
import { Button } from "@/components/ui/button";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import { bboxFromBounds } from "./query";

const PUNE = { latitude: 18.5204, longitude: 73.8567 };

/** Loaded with next/dynamic (ssr: false), only when NEXT_PUBLIC_MAPBOX_TOKEN is set. */
export default function ExploreMap({
  token,
  items,
  centre,
  selectedId,
  onSelect,
  onSearchArea,
}: {
  token: string;
  items: ListingCard[];
  centre: { lat: number; lng: number } | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSearchArea: (bbox: ReturnType<typeof bboxFromBounds>) => void;
}) {
  const ref = useRef<MapRef>(null);
  const [moved, setMoved] = useState(false);

  // A new text or location search recentres the map; that move isn't the user's.
  useEffect(() => {
    if (centre) ref.current?.flyTo({ center: [centre.lng, centre.lat], zoom: 13 });
  }, [centre?.lat, centre?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative h-full min-h-72 overflow-hidden rounded-xl border">
      <Map
        ref={ref}
        mapboxAccessToken={token}
        initialViewState={
          centre ? { latitude: centre.lat, longitude: centre.lng, zoom: 13 } : { ...PUNE, zoom: 11 }
        }
        mapStyle="mapbox://styles/mapbox/streets-v12"
        style={{ width: "100%", height: "100%" }}
        // Only user gestures carry an originalEvent; flyTo/fit moves don't.
        onMoveEnd={(e) => {
          if ("originalEvent" in e && e.originalEvent) setMoved(true);
        }}
      >
        <NavigationControl position="top-right" showCompass={false} />
        {items.map((item) => (
          <Marker
            key={item.id}
            latitude={item.approxLat}
            longitude={item.approxLng}
            anchor="bottom"
            style={{ zIndex: item.id === selectedId ? 1 : 0 }}
          >
            <button
              type="button"
              aria-label={`${item.title}, approximate location`}
              aria-pressed={item.id === selectedId}
              onClick={() => onSelect(item.id)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs font-semibold shadow",
                item.id === selectedId
                  ? "bg-primary text-primary-foreground scale-110"
                  : "bg-background text-foreground",
              )}
            >
              {item.priceFrom ? formatINR(item.priceFrom.paise) : "—"}
            </button>
          </Marker>
        ))}
      </Map>
      {moved ? (
        <Button
          className="absolute top-3 left-1/2 -translate-x-1/2 shadow"
          onClick={() => {
            const b = ref.current?.getBounds();
            if (!b) return;
            setMoved(false);
            onSearchArea(
              bboxFromBounds({
                west: b.getWest(),
                south: b.getSouth(),
                east: b.getEast(),
                north: b.getNorth(),
              }),
            );
          }}
        >
          Search this area
        </Button>
      ) : null}
    </div>
  );
}
