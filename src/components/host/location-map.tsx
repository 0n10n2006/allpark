"use client";

import Map, { Marker, NavigationControl } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";

const PUNE = { latitude: 18.5204, longitude: 73.8567 };

/** Click or drag the pin to set the exact spot. Lat/lng inputs stay as the keyboard path. */
export default function LocationMap({
  token,
  lat,
  lng,
  onPick,
}: {
  token: string;
  lat: number | null;
  lng: number | null;
  onPick: (lat: number, lng: number) => void;
}) {
  const pin = lat !== null && lng !== null ? { latitude: lat, longitude: lng } : null;
  const pick = (p: { lat: number; lng: number }) =>
    onPick(Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6)));
  return (
    <div
      className="h-72 overflow-hidden rounded-lg border"
      role="region"
      aria-label="Map: click to place the pin"
    >
      <Map
        mapboxAccessToken={token}
        initialViewState={{ ...(pin ?? PUNE), zoom: pin ? 16 : 12 }}
        mapStyle="mapbox://styles/mapbox/streets-v12"
        onClick={(e) => pick(e.lngLat)}
      >
        <NavigationControl />
        {pin ? <Marker {...pin} draggable onDragEnd={(e) => pick(e.lngLat)} /> : null}
      </Map>
    </div>
  );
}
