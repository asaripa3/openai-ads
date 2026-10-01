import { ADS_BASE_URL, type AdAccountResource, type GeoLocationRef } from "./types";
import { RateLimiter, sleep } from "./ratelimit";

/**
 * Not a full SDK — it owns the four things every call needs and that are easy to
 * get wrong per call site: auth, the Idempotency-Key, rate limiting and retry.
 *
 * Retry matters most: a 5xx or timeout on a create may mean the request succeeded
 * and only the response was lost. Callers pass a derived key, so retrying is safe.
 */

export class AdsApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: unknown,
    readonly requestId?: string,
  ) {
    super(`${status} ${path}${requestId ? ` (request ${requestId})` : ""}: ${stringifyBody(body)}`);
    this.name = "AdsApiError";
  }

  /** A rejected payload cannot become valid, so only 429 and 5xx are retried. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

function stringifyBody(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 500);
  try {
    return JSON.stringify(body).slice(0, 500);
  } catch {
    return String(body);
  }
}

export type AdsClientOptions = {
  apiKey: string;
  baseUrl?: string;
  /** Shared, so every launch for one account draws on the same allowance. */
  limiter?: RateLimiter;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
};

export class AdsClient {
  private readonly baseUrl: string;
  private readonly limiter: RateLimiter;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AdsClientOptions) {
    this.baseUrl = options.baseUrl ?? ADS_BASE_URL;
    this.limiter = options.limiter ?? new RateLimiter();
    this.maxAttempts = options.maxAttempts ?? 4;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    init: { body?: unknown; idempotencyKey?: string; query?: Record<string, string | string[] | undefined>; form?: FormData } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value === undefined) continue;
      // The API documents array params as include[]=.
      if (Array.isArray(value)) for (const v of value) url.searchParams.append(`${key}[]`, v);
      else url.searchParams.set(key, value);
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.limiter.acquire(method, path);

      const headers: Record<string, string> = { Authorization: `Bearer ${this.options.apiKey}` };
      // Reused verbatim on every attempt, which is what makes retry safe.
      if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
      if (init.body !== undefined) headers["Content-Type"] = "application/json";

      try {
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
        });

        const requestId = response.headers.get("x-request-id") ?? undefined;
        const text = await response.text();
        const payload = text ? safeJson(text) : null;

        if (response.ok) return payload as T;

        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("retry-after") ?? 0) || 2 ** attempt;
          this.limiter.penalize(retryAfter);
        }

        const error = new AdsApiError(response.status, path, payload ?? text, requestId);
        if (!error.retryable || attempt === this.maxAttempts) throw error;
        lastError = error;
      } catch (cause) {
        if (cause instanceof AdsApiError) {
          if (!cause.retryable || attempt === this.maxAttempts) throw cause;
          lastError = cause;
        } else {
          // The request may have been applied, so this is only safe because the
          // idempotency key makes a duplicate impossible.
          if (attempt === this.maxAttempts) throw cause;
          lastError = cause;
        }
      }

      await sleep(Math.min(8_000, 250 * 2 ** attempt) + Math.random() * 250);
    }
    throw lastError;
  }


  getAdAccount(): Promise<AdAccountResource> {
    return this.request("GET", "/ad_account");
  }

  /** Read-only, so it is safe during compile. */
  geoLookup(query: string): Promise<{ data?: GeoLocationRef[] } | GeoLocationRef[]> {
    return this.request("GET", "/geo_lookup/search", { query: { query } });
  }

  uploadImageFromUrl(imageUrl: string): Promise<{ file_id: string }> {
    const form = new FormData();
    form.set("image_url", imageUrl);
    return this.request("POST", "/upload", { form });
  }

  createCampaign(body: unknown, idempotencyKey: string): Promise<{ id: string }> {
    return this.request("POST", "/campaigns", { body, idempotencyKey });
  }
  createAdGroup(body: unknown, idempotencyKey: string): Promise<{ id: string }> {
    return this.request("POST", "/ad_groups", { body, idempotencyKey });
  }
  createAd(body: unknown, idempotencyKey: string): Promise<{ id: string }> {
    return this.request("POST", "/ads", { body, idempotencyKey });
  }

  activate(kind: "campaigns" | "ad_groups" | "ads", id: string): Promise<unknown> {
    return this.request("POST", `/${kind}/${id}/activate`);
  }
  pause(kind: "campaigns" | "ad_groups" | "ads", id: string): Promise<unknown> {
    return this.request("POST", `/${kind}/${id}/pause`);
  }

  getAdWithServingIssues(adId: string): Promise<{ id: string; status?: string; serving_issues?: Array<{ code: string }> }> {
    return this.request("GET", `/ads/${adId}`, { query: { include: ["serving_issues"] } });
  }
  getCampaignWithServingIssues(campaignId: string): Promise<{ id: string; status?: string; serving_issues?: Array<{ code: string }> }> {
    return this.request("GET", `/campaigns/${campaignId}`, { query: { include: ["serving_issues"] } });
  }
  getAdGroupWithServingIssues(adGroupId: string): Promise<{ id: string; status?: string; serving_issues?: Array<{ code: string }> }> {
    return this.request("GET", `/ad_groups/${adGroupId}`, { query: { include: ["serving_issues"] } });
  }

  previewAd(adId: string): Promise<unknown> {
    return this.request("POST", `/ads/${adId}/preview`);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
