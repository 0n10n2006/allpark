"use client";

import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { VehicleType } from "@/generated/prisma/enums";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { rupeesToPaise } from "@/lib/money";
import { formatIST, parseISTLocal } from "@/lib/time";
import { filterCount } from "./query";

const RENTAL_TYPES = [
  ["ANY", "Any"],
  ["HOURLY", "Hourly"],
  ["DAILY", "Daily"],
  ["MULTI_DAY", "Multi-day"],
  ["WEEKLY", "Weekly"],
  ["MONTHLY", "Monthly"],
] as const;
const AMENITIES = [
  ["lit", "Well lit"],
  ["evCharging", "EV charging"],
  ["security", "Security"],
] as const;
const LOCAL = "yyyy-MM-dd'T'HH:mm";

const toLocal = (iso: string | null, pattern = LOCAL) =>
  iso && !Number.isNaN(Date.parse(iso)) ? formatIST(new Date(iso), pattern) : "";
const toRupees = (paise: string | null) => (paise ? String(Number(paise) / 100) : "");
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace("_", " ");

/** Filters live in the URL; this sheet edits a draft and applies it in one navigation. */
export function FiltersSheet({
  params,
  onApply,
}: {
  params: URLSearchParams;
  onApply: (filters: Record<string, string | undefined>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rentalType, setRentalType] = useState(params.get("rentalType") ?? "ANY");
  const [error, setError] = useState<string | null>(null);
  const count = filterCount(params);
  const amenities = (params.get("amenities") ?? "").split(",");

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? "").trim();
    try {
      let startAt: string | undefined;
      let endAt: string | undefined;
      if (rentalType === "MONTHLY") {
        if (text("startDate")) startAt = parseISTLocal(`${text("startDate")}T00:00`).toISOString();
      } else if (text("start") || text("end")) {
        if (!text("start") || !text("end"))
          throw new RangeError("Choose both a start and an end time.");
        startAt = parseISTLocal(text("start")).toISOString();
        endAt = parseISTLocal(text("end")).toISOString();
        if (endAt <= startAt) throw new RangeError("The end time must be after the start time.");
      }
      const paise = (k: string) => (text(k) ? String(rupeesToPaise(Number(text(k)))) : undefined);
      setError(null);
      onApply({
        rentalType: rentalType === "ANY" ? undefined : rentalType,
        startAt,
        endAt,
        minPricePaise: paise("minPrice"),
        maxPricePaise: paise("maxPrice"),
        vehicleType: text("vehicleType") || undefined,
        minHeightCm: text("minHeightCm") || undefined,
        // Only "true": covered=false would mean uncovered-only on the server.
        covered: f.get("covered") ? "true" : undefined,
        amenities:
          AMENITIES.filter(([k]) => f.get(k))
            .map(([k]) => k)
            .join(",") || undefined,
      });
      setOpen(false);
    } catch (err) {
      setError(err instanceof RangeError ? err.message : "Check the dates and times.");
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) setRentalType(params.get("rentalType") ?? "ANY");
        setError(null);
        setOpen(next);
      }}
    >
      <SheetTrigger render={<Button variant="outline" className="min-h-11" />}>
        <SlidersHorizontal aria-hidden="true" />
        Filters
        {count ? (
          <Badge className="ml-1">
            {count}
            <span className="sr-only"> active</span>
          </Badge>
        ) : null}
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[90dvh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription>Times are in India Standard Time.</SheetDescription>
        </SheetHeader>
        <form
          key={params.toString()}
          onSubmit={submit}
          className="mx-auto grid w-full max-w-2xl gap-5 px-4"
        >
          <fieldset className="grid gap-3">
            <legend className="mb-2 text-sm font-medium">When</legend>
            <Tabs value={rentalType} onValueChange={(v) => setRentalType(String(v))}>
              <TabsList aria-label="Rental type" className="h-auto w-full flex-wrap">
                {RENTAL_TYPES.map(([value, label]) => (
                  <TabsTrigger key={value} value={value} className="min-h-9">
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {rentalType === "MONTHLY" ? (
              <label className="grid gap-1 text-sm">
                Start date
                <Input
                  type="date"
                  name="startDate"
                  defaultValue={toLocal(params.get("startAt"), "yyyy-MM-dd")}
                />
              </label>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  Start
                  <Input
                    type="datetime-local"
                    name="start"
                    defaultValue={toLocal(params.get("startAt"))}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  End
                  <Input
                    type="datetime-local"
                    name="end"
                    defaultValue={toLocal(params.get("endAt"))}
                  />
                </label>
              </div>
            )}
          </fieldset>

          <fieldset className="grid grid-cols-2 gap-3">
            <legend className="mb-2 text-sm font-medium">Price (₹)</legend>
            <label className="grid gap-1 text-sm">
              Min
              <Input
                type="number"
                name="minPrice"
                min={0}
                step="any"
                inputMode="decimal"
                defaultValue={toRupees(params.get("minPricePaise"))}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Max
              <Input
                type="number"
                name="maxPrice"
                min={0}
                step="any"
                inputMode="decimal"
                defaultValue={toRupees(params.get("maxPricePaise"))}
              />
            </label>
          </fieldset>

          <fieldset className="grid grid-cols-2 gap-3">
            <legend className="mb-2 text-sm font-medium">Your vehicle</legend>
            <label className="grid gap-1 text-sm">
              Type
              <select
                name="vehicleType"
                defaultValue={params.get("vehicleType") ?? ""}
                className="border-input h-8 rounded-lg border bg-transparent px-2"
              >
                <option value="">Any</option>
                {Object.values(VehicleType).map((v) => (
                  <option key={v} value={v}>
                    {titleCase(v)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Height (cm)
              <Input
                type="number"
                name="minHeightCm"
                min={1}
                step={1}
                inputMode="numeric"
                defaultValue={params.get("minHeightCm") ?? ""}
              />
            </label>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Features</legend>
            <label className="flex min-h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="covered"
                defaultChecked={params.get("covered") === "true"}
                className="size-4"
              />
              Covered
            </label>
            {AMENITIES.map(([k, label]) => (
              <label key={k} className="flex min-h-9 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name={k}
                  defaultChecked={amenities.includes(k)}
                  className="size-4"
                />
                {label}
              </label>
            ))}
          </fieldset>

          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
          <SheetFooter className="flex-row px-0">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 flex-1"
              onClick={() => {
                onApply({});
                setOpen(false);
              }}
            >
              Clear all
            </Button>
            <Button type="submit" className="min-h-11 flex-1">
              Show results
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
