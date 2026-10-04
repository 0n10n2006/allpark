import { TZDate, tz } from "@date-fns/tz";
import { format } from "date-fns";

export const APP_TIMEZONE = "Asia/Kolkata";

/** Formats an instant for display in ParkShare's operating time zone. */
export function formatIST(date: Date, pattern: string): string {
  return format(date, pattern, { in: tz(APP_TIMEZONE) });
}

/** Converts an HTML `datetime-local` value entered in IST into a UTC instant. */
export function parseISTLocal(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);

  if (!match) {
    throw new RangeError("Expected a local date and time in YYYY-MM-DDTHH:mm format");
  }

  const [, year, month, day, hour, minute] = match;
  const localDate = new TZDate(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    APP_TIMEZONE,
  );

  if (
    localDate.getFullYear() !== Number(year) ||
    localDate.getMonth() !== Number(month) - 1 ||
    localDate.getDate() !== Number(day) ||
    localDate.getHours() !== Number(hour) ||
    localDate.getMinutes() !== Number(minute)
  ) {
    throw new RangeError("Invalid local date and time");
  }

  return new Date(localDate.getTime());
}

/** Returns the UTC instant at the beginning of the supplied calendar day in IST. */
export function startOfDayIST(date: Date): Date {
  const localDate = new TZDate(date, APP_TIMEZONE);
  return new Date(
    new TZDate(
      localDate.getFullYear(),
      localDate.getMonth(),
      localDate.getDate(),
      APP_TIMEZONE,
    ).getTime(),
  );
}
