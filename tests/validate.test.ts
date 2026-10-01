import { describe, expect, it } from "vitest";
import { BriefSchema } from "@/domain/brief";
import { validate, truncateOnWord } from "@/validate/validate";
import type { AdAccountResource } from "@/ads/types";

const ctx = { currency: "USD", resolvedPlaces: {}, now: new Date("2026-10-01T00:00:00Z") };
const codes = (ds: ReturnType<typeof validate>) => ds.map((d) => d.code);

const brief = (overrides: Record<string, unknown> = {}) =>
  BriefSchema.parse({
    reference: "ticket-1",
    campaignName: "Spring launch",
    goal: "traffic",
    budget: { daily: { amount: 50 } },
    targeting: { countries: ["US"] },
    adGroups: [{ name: "Trail running", contextHints: ["trail shoes"], creatives: [{ title: "Find your next trail shoe", body: "Explore shoes for your next run.", targetUrl: "https://example.com/x", fileId: "file_1" }] }],
    ...overrides,
  });

describe("validate", () => {
  it("passes a well-formed brief with no blockers", () => {
    const ds = validate(brief(), ctx);
    expect(ds.filter((d) => d.severity === "blocker")).toEqual([]);
  });

  it("catches the 50-character title limit and offers a word-boundary fix", () => {
    const long = "A".repeat(40) + " and then some more words beyond the limit";
    const ds = validate(brief({ adGroups: [{ name: "G", contextHints: [], creatives: [{ title: long, body: "ok" }] }] }), ctx);
    const found = ds.find((d) => d.code === "title_too_long");
    expect(found?.severity).toBe("blocker");
    expect(String(found?.fix?.value).length).toBeLessThanOrEqual(50);
  });

  it("catches the 100-character body limit", () => {
    const ds = validate(brief({ adGroups: [{ name: "Group", contextHints: [], creatives: [{ title: "Title here", body: "x".repeat(101) }] }] }), ctx);
    expect(codes(ds)).toContain("body_too_long");
  });

  it("rejects a budget below the 1,000,000-micro minimum", () => {
    expect(codes(validate(brief({ budget: { daily: { amount: 0.5 } } }), ctx))).toContain("budget_below_minimum");
  });

  it("rejects a lifetime budget below the daily budget", () => {
    expect(codes(validate(brief({ budget: { daily: { amount: 50 }, lifetime: { amount: 20 } } }), ctx))).toContain("lifetime_below_daily");
  });

  it("requires a conversion event setting for a conversions goal", () => {
    expect(codes(validate(brief({ goal: "conversions" }), ctx))).toContain("conversion_events_required");
    expect(codes(validate(brief({ goal: "conversions", conversionEventSettingIds: ["ces_1"] }), ctx))).not.toContain("conversion_events_required");
  });

  it("blocks a per-click bid on an impression-billed awareness goal", () => {
    const ds = validate(brief({ goal: "awareness", adGroups: [{ name: "Group", contextHints: [], billingEvent: "click", maxBid: { amount: 2 }, creatives: [{ title: "Title", body: "Body" }] }] }), ctx);
    expect(codes(ds)).toContain("billing_event_conflicts_with_goal");
  });

  it("blocks reserved query parameters that would fail at serving time", () => {
    const ds = validate(brief({ adGroups: [{ name: "Group", contextHints: [], creatives: [{ title: "Title", body: "Body", targetUrl: "https://example.com/x?gclid=abc" }] }] }), ctx);
    expect(codes(ds)).toContain("reserved_query_params");
  });

  it("blocks a non-https or non-public destination", () => {
    expect(codes(validate(brief({ adGroups: [{ name: "Group", contextHints: [], creatives: [{ title: "Title", body: "Body", targetUrl: "http://example.com" }] }] }), ctx))).toContain("target_url_not_https");
    expect(codes(validate(brief({ adGroups: [{ name: "Group", contextHints: [], creatives: [{ title: "Title", body: "Body", targetUrl: "https://localhost:3000/x" }] }] }), ctx))).toContain("target_url_not_public");
  });

  it("blocks a currency that disagrees with the ad account", () => {
    const account = { currency_code: "EUR", timezone: "Europe/Berlin", status: "active", review: { status: "approved" } } as AdAccountResource;
    expect(codes(validate(brief({ budget: { daily: { amount: 50, currency: "USD" } } }), ctx, account))).toContain("currency_mismatch");
  });

  it("warns, rather than blocks, when the account is still in review", () => {
    const account = { currency_code: "USD", timezone: "UTC", status: "active", review: { status: "in_progress" } } as AdAccountResource;
    const found = validate(brief(), ctx, account).find((d) => d.code === "account_review_pending");
    expect(found?.severity).toBe("warning");
  });

  it("flags review-risk copy as a warning, never a blocker", () => {
    const ds = validate(brief({ adGroups: [{ name: "Group", contextHints: [], creatives: [{ title: "Guaranteed results", body: "100% risk-free." }] }] }), ctx);
    expect(ds.filter((d) => d.code === "review_risk_claim").every((d) => d.severity === "warning")).toBe(true);
  });

  it("blocks geography that is both included and excluded", () => {
    expect(codes(validate(brief({ targeting: { countries: ["US"], excludeCountries: ["us"] } }), ctx))).toContain("geo_include_exclude_conflict");
  });

  it("blocks free-text countries and points at the geo lookup", () => {
    expect(codes(validate(brief({ targeting: { countries: ["United States"] } }), ctx))).toContain("country_not_alpha2");
  });

  it("reports an unresolved place rather than silently dropping it", () => {
    const withPlace = brief({ targeting: { countries: ["US"], places: ["Atlantis"] } });
    expect(codes(validate(withPlace, { ...ctx, resolvedPlaces: { Atlantis: null } }))).toContain("place_unresolved");
  });

  it("sorts blockers before warnings before info", () => {
    const severities = validate(brief({ budget: { daily: { amount: 0.5 } }, targeting: {} }), ctx).map((d) => d.severity);
    expect(severities).toEqual([...severities].sort((a, b) => ({ blocker: 0, warning: 1, info: 2 })[a] - ({ blocker: 0, warning: 1, info: 2 })[b]));
  });
});

describe("truncateOnWord", () => {
  it("cuts on a word boundary when one is close enough", () => {
    expect(truncateOnWord("the quick brown fox jumps", 20)).toBe("the quick brown fox");
  });
  it("leaves short strings alone", () => {
    expect(truncateOnWord("short", 20)).toBe("short");
  });
});
