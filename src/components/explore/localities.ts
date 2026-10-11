// Built-in Pune area suggestions, used for search when there's no Mapbox token.
// The first ten match prisma/seed.ts so a search lands where the seed put listings.
export const PUNE_LOCALITIES = [
  { name: "Koregaon Park", lat: 18.5362, lng: 73.894 },
  { name: "Baner", lat: 18.559, lng: 73.7868 },
  { name: "Hinjewadi", lat: 18.5913, lng: 73.7389 },
  { name: "Viman Nagar", lat: 18.5679, lng: 73.9143 },
  { name: "Kothrud", lat: 18.5074, lng: 73.8077 },
  { name: "Shivajinagar", lat: 18.5308, lng: 73.8475 },
  { name: "Hadapsar", lat: 18.5089, lng: 73.926 },
  { name: "Aundh", lat: 18.558, lng: 73.8075 },
  { name: "Wakad", lat: 18.5987, lng: 73.761 },
  { name: "Camp", lat: 18.5155, lng: 73.879 },
  { name: "Deccan", lat: 18.5165, lng: 73.841 },
  { name: "FC Road", lat: 18.5236, lng: 73.8414 },
  { name: "Magarpatta", lat: 18.5146, lng: 73.9295 },
  { name: "Kharadi", lat: 18.5515, lng: 73.9408 },
] as const;

export type Place = { name: string; lat: number; lng: number };

/** Exact name first, then the first locality whose name contains the text. */
export function findLocality(text: string): Place | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  return (
    PUNE_LOCALITIES.find((l) => l.name.toLowerCase() === t) ??
    PUNE_LOCALITIES.find((l) => l.name.toLowerCase().includes(t)) ??
    null
  );
}
