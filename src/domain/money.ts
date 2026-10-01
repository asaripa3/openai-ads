/**
 * The Advertiser API takes money as integer micros: 1 unit = 1_000_000, so $50 is
 * 50_000_000. Amounts arrive in major units and convert exactly once, here, so a
 * factor-of-1000 error can only come from one place.
 */

export type Micros = number & { readonly __brand: "micros" };

export const MICROS_PER_UNIT = 1_000_000;

export function toMicros(majorUnits: number): Micros {
  if (!Number.isFinite(majorUnits)) throw new RangeError(`not a finite amount: ${majorUnits}`);
  // Round through a string: 19.99 * 1e6 is 19989999.999999996.
  const micros = Math.round(Number((majorUnits * MICROS_PER_UNIT).toFixed(0)));
  if (!Number.isSafeInteger(micros)) throw new RangeError(`amount overflows safe integer: ${majorUnits}`);
  return micros as Micros;
}

export function fromMicros(micros: number): number {
  return micros / MICROS_PER_UNIT;
}

/** For diagnostic messages. */
export function formatMicros(micros: number, currency: string): string {
  const value = fromMicros(micros);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: value < 1 ? 4 : 2,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

/** Currencies with no minor unit. */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);

export function isZeroDecimal(currency: string): boolean {
  return ZERO_DECIMAL.has(currency.toUpperCase());
}
