import { RATE_LIMITS } from "./types";

/**
 * Token buckets for the documented limits: 600 per minute per endpoint, 1,200
 * overall. Both must admit a request, because the platform enforces both.
 *
 * This is not politeness. A 429 mid-launch leaves a campaign and an ad group
 * created and the ad missing, which is the state the whole design avoids.
 */

class Bucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private readonly capacity: number, private readonly perMinute: number) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMin = (now - this.lastRefill) / 60_000;
    if (elapsedMin <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMin * this.perMinute);
    this.lastRefill = now;
  }

  /** Milliseconds until a token frees up; 0 when one is available. */
  waitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.perMinute) * 60_000);
  }

  take(): void {
    this.refill();
    this.tokens -= 1;
  }
}

export class RateLimiter {
  private readonly overall = new Bucket(RATE_LIMITS.overallPerMinute, RATE_LIMITS.overallPerMinute);
  private readonly perEndpoint = new Map<string, Bucket>();
  /** Set by a 429; overrides local accounting. */
  private cooldownUntil = 0;

  /** Keyed by template, so every /ads/{id}/activate shares one bucket. */
  static endpointKey(method: string, path: string): string {
    const template = path
      .replace(/\/(cmpn|adgrp|ad|file|audnc)_[A-Za-z0-9]+/g, "/{id}")
      .replace(/\/\d+/g, "/{id}")
      .split("?")[0];
    return `${method} ${template}`;
  }

  async acquire(method: string, path: string): Promise<void> {
    const key = RateLimiter.endpointKey(method, path);
    let bucket = this.perEndpoint.get(key);
    if (!bucket) {
      bucket = new Bucket(RATE_LIMITS.perEndpointPerMinute, RATE_LIMITS.perEndpointPerMinute);
      this.perEndpoint.set(key, bucket);
    }

    for (;;) {
      const cooldown = Math.max(0, this.cooldownUntil - Date.now());
      const wait = Math.max(cooldown, bucket.waitMs(), this.overall.waitMs());
      if (wait === 0) {
        bucket.take();
        this.overall.take();
        return;
      }
      await sleep(Math.min(wait, 5_000));
    }
  }

  /** Honour Retry-After rather than guessing. */
  penalize(retryAfterSec: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + retryAfterSec * 1000);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
