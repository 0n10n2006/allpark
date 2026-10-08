"use client";

import { Plus, Trash2 } from "lucide-react";
import type { GetAvailabilityResponse, UpdateAvailabilityBody } from "@/contracts";
import { formatIST, parseISTLocal } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Display Monday first; values are the contract's weekday numbers (0 = Sunday).
const DAYS = [
  [1, "Monday"],
  [2, "Tuesday"],
  [3, "Wednesday"],
  [4, "Thursday"],
  [5, "Friday"],
  [6, "Saturday"],
  [0, "Sunday"],
] as const;

type Range = { start: string; end: string };
type Exception = { start: string; end: string; unavailable: boolean; reason: string };
export type Schedule = {
  always: boolean;
  days: Record<number, Range[]>;
  exceptions: Exception[];
};

export const EMPTY_SCHEDULE: Schedule = { always: false, days: {}, exceptions: [] };

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const minutes = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
/** An end of 00:00 means midnight at the end of the day. */
const endMinutes = (s: string) => minutes(s) || 1440;
const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export function fromAvailability(a: GetAvailabilityResponse): Schedule {
  const days: Schedule["days"] = {};
  for (const r of a.rules)
    (days[r.weekday] ??= []).push({ start: hhmm(r.startMinute), end: hhmm(r.endMinute) });
  const always =
    a.rules.length === 7 && a.rules.every((r) => r.startMinute === 0 && r.endMinute === 1440);
  return {
    always,
    days: always ? {} : days,
    exceptions: a.exceptions.map((e) => ({
      start: formatIST(new Date(e.startAt), "yyyy-MM-dd"),
      // Stored end is exclusive; show the last day it covers.
      end: formatIST(new Date(Date.parse(e.endAt) - 60_000), "yyyy-MM-dd"),
      unavailable: e.unavailable,
      reason: e.reason ?? "",
    })),
  };
}

/** Problems keyed by row id ("d1-0", "x0"); empty when the schedule can be saved. */
export function scheduleErrors(s: Schedule): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!s.always)
    for (const [day] of DAYS) {
      const ranges = (s.days[day] ?? []).map((r, i) => ({ ...r, i }));
      for (const r of ranges)
        if (!r.start || !r.end || minutes(r.start) >= endMinutes(r.end))
          errors[`d${day}-${r.i}`] = "The end time must be after the start time.";
      const sorted = ranges
        .filter((r) => !errors[`d${day}-${r.i}`])
        .sort((a, b) => minutes(a.start) - minutes(b.start));
      for (let k = 1; k < sorted.length; k++)
        if (minutes(sorted[k].start) < endMinutes(sorted[k - 1].end))
          errors[`d${day}-${sorted[k].i}`] = "This range overlaps another one on the same day.";
    }
  s.exceptions.forEach((e, i) => {
    if (!e.start || !e.end || e.end < e.start)
      errors[`x${i}`] = "Choose a start date and an end date on or after it.";
  });
  return errors;
}

export function toAvailabilityBody(s: Schedule): UpdateAvailabilityBody {
  const rules = s.always
    ? DAYS.map(([weekday]) => ({ weekday, startMinute: 0, endMinute: 1440 }))
    : DAYS.flatMap(([weekday]) =>
        (s.days[weekday] ?? []).map((r) => ({
          weekday,
          startMinute: minutes(r.start),
          endMinute: endMinutes(r.end),
        })),
      );
  return {
    rules,
    exceptions: s.exceptions.map((e) => ({
      startAt: parseISTLocal(`${e.start}T00:00`).toISOString(),
      endAt: parseISTLocal(`${nextDay(e.end)}T00:00`).toISOString(),
      unavailable: e.unavailable,
      reason: e.reason.trim() || null,
    })),
  };
}

const tap = "min-h-11";

export function AvailabilityEditor({
  value,
  onChange,
  errors,
}: {
  value: Schedule;
  onChange: (s: Schedule) => void;
  errors: Record<string, string>;
}) {
  const setDay = (day: number, ranges: Range[]) =>
    onChange({ ...value, days: { ...value.days, [day]: ranges } });
  const setException = (i: number, patch: Partial<Exception>) =>
    onChange({
      ...value,
      exceptions: value.exceptions.map((e, k) => (k === i ? { ...e, ...patch } : e)),
    });

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Times are in India Standard Time (IST). An end time of 00:00 means midnight.
      </p>
      <label className={`flex items-center gap-3 ${tap}`}>
        <input
          type="checkbox"
          className="size-5"
          checked={value.always}
          onChange={(e) => onChange({ ...value, always: e.target.checked })}
        />
        Open 24 hours, 7 days a week
      </label>

      {value.always ? null : (
        <div className="space-y-4">
          {DAYS.map(([day, name]) => {
            const ranges = value.days[day] ?? [];
            return (
              <fieldset key={day} className="rounded-lg border p-3">
                <legend className="px-1 font-medium">{name}</legend>
                {ranges.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Closed</p>
                ) : null}
                <ul className="space-y-3">
                  {ranges.map((r, i) => {
                    const id = `d${day}-${i}`;
                    const err = errors[id];
                    return (
                      <li key={i} className="flex flex-wrap items-end gap-2">
                        <label className="grid gap-1 text-sm">
                          From
                          <Input
                            type="time"
                            className={`${tap} w-32`}
                            value={r.start}
                            aria-invalid={err ? true : undefined}
                            aria-describedby={err ? `${id}-err` : undefined}
                            onChange={(e) =>
                              setDay(
                                day,
                                ranges.map((x, k) =>
                                  k === i ? { ...x, start: e.target.value } : x,
                                ),
                              )
                            }
                          />
                        </label>
                        <label className="grid gap-1 text-sm">
                          To
                          <Input
                            type="time"
                            className={`${tap} w-32`}
                            value={r.end}
                            aria-invalid={err ? true : undefined}
                            aria-describedby={err ? `${id}-err` : undefined}
                            onChange={(e) =>
                              setDay(
                                day,
                                ranges.map((x, k) => (k === i ? { ...x, end: e.target.value } : x)),
                              )
                            }
                          />
                        </label>
                        <Button
                          type="button"
                          variant="ghost"
                          className={`${tap} min-w-11`}
                          onClick={() =>
                            setDay(
                              day,
                              ranges.filter((_, k) => k !== i),
                            )
                          }
                        >
                          <Trash2 aria-hidden="true" />
                          <span className="sr-only">
                            Remove {name} range {i + 1}
                          </span>
                        </Button>
                        {err ? (
                          <p id={`${id}-err`} className="text-destructive w-full text-sm">
                            {err}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <Button
                  type="button"
                  variant="outline"
                  className={`${tap} mt-3`}
                  onClick={() => setDay(day, [...ranges, { start: "09:00", end: "18:00" }])}
                >
                  <Plus aria-hidden="true" /> Add time range
                  <span className="sr-only"> for {name}</span>
                </Button>
              </fieldset>
            );
          })}
        </div>
      )}

      <fieldset className="rounded-lg border p-3">
        <legend className="px-1 font-medium">Exceptions</legend>
        <p className="text-muted-foreground text-sm">
          Block out dates (holidays, repairs) or open extra days outside the weekly schedule. Date
          ranges include both the start and end dates.
        </p>
        <ul className="mt-3 space-y-4">
          {value.exceptions.map((x, i) => {
            const err = errors[`x${i}`];
            const describedBy = err ? `x${i}-err` : undefined;
            return (
              <li key={i} className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  First day
                  <Input
                    type="date"
                    className={tap}
                    value={x.start}
                    aria-invalid={err ? true : undefined}
                    aria-describedby={describedBy}
                    onChange={(e) => setException(i, { start: e.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  Last day
                  <Input
                    type="date"
                    className={tap}
                    value={x.end}
                    aria-invalid={err ? true : undefined}
                    aria-describedby={describedBy}
                    onChange={(e) => setException(i, { end: e.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  Type
                  <select
                    className={`${tap} border-input bg-background rounded-lg border px-2`}
                    value={x.unavailable ? "blackout" : "open"}
                    onChange={(e) =>
                      setException(i, { unavailable: e.target.value === "blackout" })
                    }
                  >
                    <option value="blackout">Unavailable (blackout)</option>
                    <option value="open">Extra open days</option>
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  Reason (optional)
                  <Input
                    className={tap}
                    maxLength={200}
                    value={x.reason}
                    onChange={(e) => setException(i, { reason: e.target.value })}
                  />
                </label>
                {err ? (
                  <p id={`x${i}-err`} className="text-destructive text-sm sm:col-span-2">
                    {err}
                  </p>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  className={`${tap} justify-self-start`}
                  onClick={() =>
                    onChange({ ...value, exceptions: value.exceptions.filter((_, k) => k !== i) })
                  }
                >
                  <Trash2 aria-hidden="true" /> Remove exception {i + 1}
                </Button>
              </li>
            );
          })}
        </ul>
        <Button
          type="button"
          variant="outline"
          className={`${tap} mt-3`}
          onClick={() =>
            onChange({
              ...value,
              exceptions: [
                ...value.exceptions,
                { start: "", end: "", unavailable: true, reason: "" },
              ],
            })
          }
        >
          <Plus aria-hidden="true" /> Add exception
        </Button>
      </fieldset>
    </div>
  );
}
