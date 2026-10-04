import { describe, expect, it } from "vitest";
import { formatIST, parseISTLocal, startOfDayIST } from "@/lib/time";

describe("ParkShare time helpers", () => {
  it("formats UTC instants in IST", () => {
    expect(formatIST(new Date("2026-10-16T18:30:00.000Z"), "yyyy-MM-dd HH:mm")).toBe(
      "2026-10-17 00:00",
    );
  });

  it("parses a datetime-local value as IST", () => {
    expect(parseISTLocal("2026-10-16T09:30").toISOString()).toBe("2026-10-16T04:00:00.000Z");
  });

  it("uses the IST day boundary", () => {
    expect(startOfDayIST(new Date("2026-10-16T18:30:00.000Z")).toISOString()).toBe(
      "2026-10-16T18:30:00.000Z",
    );
  });
});
