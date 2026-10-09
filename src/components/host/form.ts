import { CreateListingBody, UpdateListingBody, type OwnedListing } from "@/contracts";
import { rupeesToPaise } from "@/lib/money";
import type { Issue } from "./api";

export const STEPS = [
  { key: "basics", label: "Basics" },
  { key: "location", label: "Location" },
  { key: "vehicles", label: "Vehicles & size" },
  { key: "pricing", label: "Pricing" },
  { key: "availability", label: "Availability" },
  { key: "photos", label: "Photos" },
  { key: "access", label: "Access & rules" },
  { key: "review", label: "Review & publish" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];
export const isStep = (s: string | null): s is StepKey => STEPS.some((x) => x.key === s);

/** Everything the inputs edit, as strings the way inputs hold them. */
export type Form = {
  title: string;
  description: string;
  spaceType: OwnedListing["spaceType"] | "";
  address: string;
  locality: string;
  lat: string;
  lng: string;
  vehicleTypes: OwnedListing["vehicleTypes"];
  maxHeightCm: string;
  maxWidthCm: string;
  maxLengthCm: string;
  covered: boolean;
  lit: boolean;
  evCharging: boolean;
  security: boolean;
  hourly: string;
  daily: string;
  weekly: string;
  monthly: string;
  minDurationMinutes: string;
  turnoverBufferMinutes: string;
  accessInstructions: string;
  hostRules: string;
  cancellationPolicy: string;
};

export const EMPTY_FORM: Form = {
  title: "",
  description: "",
  spaceType: "",
  address: "",
  locality: "",
  lat: "",
  lng: "",
  vehicleTypes: [],
  maxHeightCm: "",
  maxWidthCm: "",
  maxLengthCm: "",
  covered: false,
  lit: false,
  evCharging: false,
  security: false,
  hourly: "",
  daily: "",
  weekly: "",
  monthly: "",
  minDurationMinutes: "60",
  turnoverBufferMinutes: "0",
  accessInstructions: "",
  hostRules: "",
  cancellationPolicy: "standard",
};

const str = (n: number | null | undefined) => (n == null ? "" : String(n));
const rupees = (m: { paise: number } | null) => (m ? String(m.paise / 100) : "");

export function fromListing(l: OwnedListing): Form {
  return {
    title: l.title,
    description: l.description,
    spaceType: l.spaceType,
    address: l.address,
    locality: l.locality,
    lat: String(l.lat),
    lng: String(l.lng),
    vehicleTypes: l.vehicleTypes,
    maxHeightCm: str(l.maxHeightCm),
    maxWidthCm: str(l.maxWidthCm),
    maxLengthCm: str(l.maxLengthCm),
    covered: l.covered,
    lit: l.lit,
    evCharging: l.evCharging,
    security: l.security,
    hourly: rupees(l.prices.hourly),
    daily: rupees(l.prices.daily),
    weekly: rupees(l.prices.weekly),
    monthly: rupees(l.prices.monthly),
    minDurationMinutes: String(l.minDurationMinutes),
    turnoverBufferMinutes: String(l.turnoverBufferMinutes),
    accessInstructions: l.accessInstructions ?? "",
    hostRules: l.hostRules ?? "",
    cancellationPolicy: l.cancellationPolicy.key,
  };
}

/** Blank → null; anything unparsable → NaN so zod rejects it rather than us guessing. */
const optInt = (s: string) => (s.trim() === "" ? null : Number(s));
const num = (s: string) => (s.trim() === "" ? NaN : Number(s));
const paise = (s: string) => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? rupeesToPaise(n) : NaN;
};
const optText = (s: string) => (s.trim() === "" ? null : s);

/** The PATCH body for one step's fields. Steps with no listing fields return null. */
export function stepPatch(step: StepKey, f: Form): UpdateListingBody | null {
  switch (step) {
    case "basics":
      return {
        title: f.title,
        description: f.description,
        ...(f.spaceType ? { spaceType: f.spaceType } : {}),
      };
    case "location":
      return { address: f.address, locality: f.locality, lat: num(f.lat), lng: num(f.lng) };
    case "vehicles":
      return {
        vehicleTypes: f.vehicleTypes,
        maxHeightCm: optInt(f.maxHeightCm),
        maxWidthCm: optInt(f.maxWidthCm),
        maxLengthCm: optInt(f.maxLengthCm),
        covered: f.covered,
        lit: f.lit,
        evCharging: f.evCharging,
        security: f.security,
      };
    case "pricing":
      return {
        hourlyPaise: paise(f.hourly),
        dailyPaise: paise(f.daily),
        weeklyPaise: paise(f.weekly),
        monthlyPaise: paise(f.monthly),
        minDurationMinutes: num(f.minDurationMinutes),
        turnoverBufferMinutes: num(f.turnoverBufferMinutes),
      };
    case "access":
      return {
        accessInstructions: optText(f.accessInstructions),
        hostRules: optText(f.hostRules),
        cancellationPolicy: f.cancellationPolicy,
      };
    default:
      return null;
  }
}

/** Plain-language messages; zod's defaults are written for developers. */
const MESSAGES: Record<string, string> = {
  title: "Enter a title of 3 to 120 characters.",
  description: "Describe the space in at least 10 characters.",
  spaceType: "Choose a space type.",
  address: "Enter the full address (at least 5 characters).",
  locality: "Enter the locality, e.g. Kothrud.",
  lat: "Enter a latitude between -90 and 90, e.g. 18.5204.",
  lng: "Enter a longitude between -180 and 180, e.g. 73.8567.",
  vehicleTypes: "Choose at least one vehicle type.",
  maxHeightCm: "Enter a whole number of centimetres, or leave it blank.",
  maxWidthCm: "Enter a whole number of centimetres, or leave it blank.",
  maxLengthCm: "Enter a whole number of centimetres, or leave it blank.",
  hourlyPaise: "Enter a price in rupees, or leave it blank.",
  dailyPaise: "Enter a price in rupees, or leave it blank.",
  weeklyPaise: "Enter a price in rupees, or leave it blank.",
  monthlyPaise: "Enter a price in rupees, or leave it blank.",
  minDurationMinutes: "Enter a minimum of at least 15 minutes (up to 31 days).",
  turnoverBufferMinutes: "Enter a buffer from 0 to 240 minutes.",
  accessInstructions: "Keep access instructions under 2,000 characters.",
  hostRules: "Keep rules under 2,000 characters.",
};

export type FieldErrors = Record<string, string>;

/** Client-side check of a step's patch. `create` also requires every field POST needs. */
export function validate(patch: UpdateListingBody, f: Form, create: boolean): FieldErrors {
  const r = (create ? CreateListingBody : UpdateListingBody).safeParse(patch);
  const errors: FieldErrors = {};
  if (!r.success)
    for (const i of r.error.issues) {
      const key = String(i.path[0] ?? "");
      errors[key] ??= MESSAGES[key] ?? i.message;
    }
  if ("title" in patch && !f.spaceType) errors.spaceType = MESSAGES.spaceType;
  return errors;
}

/** Which step owns a server issue path (publish 422s and PATCH 400/422s). */
export function stepOf(path: Issue["path"]): StepKey {
  const key = String(path[0] ?? "");
  if (["title", "description", "spaceType"].includes(key)) return "basics";
  if (["address", "locality", "lat", "lng"].includes(key)) return "location";
  if (
    key.startsWith("max") ||
    ["vehicleTypes", "covered", "lit", "evCharging", "security"].includes(key)
  )
    return "vehicles";
  if (key === "prices" || key.endsWith("Paise") || key.endsWith("Minutes")) return "pricing";
  if (["availability", "rules", "exceptions"].includes(key)) return "availability";
  if (key.startsWith("photo") || key === "publicId") return "photos";
  return "access";
}

export const issueErrors = (issues: Issue[]): FieldErrors =>
  Object.fromEntries(issues.map((i) => [String(i.path[0] ?? ""), i.message]));
