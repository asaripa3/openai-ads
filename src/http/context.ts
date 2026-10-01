import { AdsClient } from "@/ads/client";
import { RateLimiter } from "@/ads/ratelimit";
import type { AdAccountResource } from "@/ads/types";

/**
 * The limiter has to be shared: the 600/1200 per minute is counted per ad account
 * and per IP, so concurrent launches draw on one allowance and a per-request
 * limiter would enforce nothing. It is still per-instance; exact limiting across
 * instances means moving the buckets in ratelimit.ts into Redis.
 */

const limiter = new RateLimiter();
let client: AdsClient | null = null;

export function adsClient(): AdsClient | null {
  const apiKey = process.env.OPENAI_ADS_API_KEY;
  if (!apiKey) return null;
  if (!client) client = new AdsClient({ apiKey, limiter });
  return client;
}

/**
 * Cached: every compile needs the currency and timezone, and spending a rate-limit
 * token to re-read an almost-static record is what causes a 429 mid-launch.
 */
let accountCache: { value: AdAccountResource; at: number } | null = null;
const ACCOUNT_TTL_MS = 60_000;

export async function adAccount(): Promise<AdAccountResource | null> {
  const client = adsClient();
  if (!client) return null;
  if (accountCache && Date.now() - accountCache.at < ACCOUNT_TTL_MS) return accountCache.value;
  const value = await client.getAdAccount();
  accountCache = { value, at: Date.now() };
  return value;
}

/** Read-only, so it is safe inside a dry run. */
export async function resolvePlaces(places: string[]): Promise<Record<string, import("@/ads/types").GeoLocationRef | null>> {
  const client = adsClient();
  const out: Record<string, import("@/ads/types").GeoLocationRef | null> = {};
  if (!places.length) return out;
  if (!client) {
    for (const place of places) out[place] = null;
    return out;
  }
  for (const place of places) {
    try {
      const response = await client.geoLookup(place);
      const rows = Array.isArray(response) ? response : (response?.data ?? []);
      out[place] = rows[0] ?? null;
    } catch {
      out[place] = null;
    }
  }
  return out;
}
