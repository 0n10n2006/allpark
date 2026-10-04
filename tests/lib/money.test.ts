import { describe, expect, it } from "vitest";
import { formatINR, rupeesToPaise } from "@/lib/money";

describe("ParkShare money helpers", () => {
  it("formats paise with Indian grouping and preserves zero", () => {
    expect(formatINR(0)).toBe("₹0");
    expect(formatINR(123456789)).toBe("₹12,34,567.89");
    expect(formatINR(123400)).toBe("₹1,234");
  });

  it("formats negative paise", () => {
    expect(formatINR(-5050)).toBe("-₹50.50");
  });

  it("rounds rupees to integer paise safely", () => {
    expect(rupeesToPaise(12.345)).toBe(1235);
    expect(rupeesToPaise(-0.005)).toBe(0);
    expect(() => rupeesToPaise(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
