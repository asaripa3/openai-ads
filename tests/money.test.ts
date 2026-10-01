import { describe, expect, it } from "vitest";
import { formatMicros, fromMicros, toMicros } from "@/domain/money";

describe("micros", () => {
  it("converts whole units", () => {
    expect(toMicros(50)).toBe(50_000_000);
    expect(toMicros(2)).toBe(2_000_000);
  });

  it("survives the floating-point cases that produce off-by-one micros", () => {
    expect(toMicros(19.99)).toBe(19_990_000);
    expect(toMicros(0.07)).toBe(70_000);
    expect(toMicros(1.005)).toBe(1_005_000);
    expect(toMicros(1234.56)).toBe(1_234_560_000);
  });

  it("round-trips", () => {
    expect(fromMicros(toMicros(19.99))).toBeCloseTo(19.99, 6);
  });

  it("rejects values that would silently lose precision", () => {
    expect(() => toMicros(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => toMicros(1e12)).toThrow(RangeError);
  });

  it("formats for humans, with extra precision on sub-unit bids", () => {
    expect(formatMicros(50_000_000, "USD")).toBe("$50.00");
    expect(formatMicros(1_000_000, "USD")).toBe("$1.00");
    expect(formatMicros(250_000, "USD")).toBe("$0.25");
  });
});
