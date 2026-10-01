import { describe, expect, it } from "vitest";
import { BriefSchema } from "@/domain/brief";
import { compile } from "@/compile/compile";
import { deriveIdempotencyKey } from "@/compile/plan";
import { toMicros } from "@/domain/money";
import { resolveRefs } from "@/execute/saga";

const ctx = { currency: "USD", resolvedPlaces: {}, now: new Date("2026-10-01T00:00:00Z") };

const brief = (overrides: Record<string, unknown> = {}) =>
  BriefSchema.parse({
    reference: "ticket-4471",
    campaignName: "Spring launch",
    goal: "traffic",
    budget: { daily: { amount: 50 } },
    targeting: { countries: ["US"] },
    adGroups: [
      {
        name: "Trail running",
        contextHints: ["Trail running shoes for rocky terrain"],
        maxBid: { amount: 2 },
        creatives: [{ title: "Find your next trail shoe", body: "Explore shoes made for your next outdoor run.", targetUrl: "https://example.com/trail-shoes", fileId: "file_123" }],
      },
    ],
    ...overrides,
  });

describe("compile", () => {
  it("produces the campaign -> ad group -> ad sequence in dependency order", () => {
    const plan = compile(brief(), ctx);
    expect(plan.steps.map((s) => s.id)).toEqual(["campaign", "ad_group:0", "ad:0:0"]);
    expect(plan.steps.map((s) => s.path)).toEqual(["/campaigns", "/ad_groups", "/ads"]);
  });

  it("converts money to micros exactly once", () => {
    const plan = compile(brief({ budget: { daily: { amount: 19.99 } } }), ctx);
    const body = plan.steps[0]!.body as { budget: { daily_spend_limit_micros: number } };
    expect(body.budget.daily_spend_limit_micros).toBe(19_990_000);
    expect(toMicros(19.99)).toBe(19_990_000);
  });

  it("derives the five coupled bidding fields from the goal", () => {
    const traffic = compile(brief(), ctx).steps[0]!.body as Record<string, unknown>;
    expect(traffic.bidding_type).toBe("clicks");
    expect(traffic.objective).toBe("clicks");
    expect(traffic.billing_event_type).toBe("click");

    const awareness = compile(brief({ goal: "awareness" }), ctx).steps[0]!.body as Record<string, unknown>;
    expect(awareness.bidding_type).toBe("impressions");
    expect(awareness.objective).toBe("reach");
    expect(awareness.billing_event_type).toBe("impression");
  });

  it("omits strategy and max_bid together when no bid is given, per the spec's autobid rule", () => {
    const noBid = brief({ adGroups: [{ name: "Trail running", contextHints: [], creatives: [{ title: "Trail shoes", body: "Shop now." }] }] });
    const group = compile(noBid, ctx).steps[1]!.body as { bidding_config: Record<string, unknown> };
    expect(group.bidding_config).not.toHaveProperty("strategy");
    expect(group.bidding_config).not.toHaveProperty("max_bid_micros");
    expect(group.bidding_config.billing_event_type).toBe("click");
  });

  it("creates every resource paused regardless of the brief's activate flag", () => {
    const plan = compile(brief({ activate: true }), ctx);
    for (const step of plan.steps) {
      if (step.kind === "upload_image") continue;
      expect((step.body as { status: string }).status).toBe("paused");
    }
  });

  it("orders activation bottom-up: ads, then ad groups, then campaign", () => {
    const multi = brief({
      adGroups: [
        { name: "Group A", contextHints: [], creatives: [{ title: "Ad one", body: "One." }, { title: "Ad two", body: "Two." }] },
        { name: "Group B", contextHints: [], creatives: [{ title: "Ad three", body: "Three." }] },
      ],
    });
    expect(compile(multi, ctx).activationOrder.map((a) => a.stepId)).toEqual([
      "ad:0:0", "ad:0:1", "ad:1:0", "ad_group:0", "ad_group:1", "campaign",
    ]);
  });

  it("inserts an upload step and references its file_id when given an image URL", () => {
    const withImage = brief({
      adGroups: [{ name: "Trail running", contextHints: [], creatives: [{ title: "Trail shoes", body: "Shop now.", imageUrl: "https://cdn.example.com/shoe.png" }] }],
    });
    const plan = compile(withImage, ctx);
    expect(plan.steps.map((s) => s.id)).toEqual(["campaign", "ad_group:0", "upload:0:0", "ad:0:0"]);
    const ad = plan.steps[3]!;
    expect(ad.dependsOn).toEqual(["ad_group:0", "upload:0:0"]);
    expect((ad.body as { creative: { file_id: unknown } }).creative.file_id).toEqual({ $ref: "upload:0:0.file_id" });
  });

  it("is deterministic: the same brief compiles to the same hash", () => {
    expect(compile(brief(), ctx).planHash).toBe(compile(brief(), ctx).planHash);
  });

  it("changes the hash when the brief changes", () => {
    expect(compile(brief(), ctx).planHash).not.toBe(compile(brief({ budget: { daily: { amount: 51 } } }), ctx).planHash);
  });

  it("derives idempotency keys that survive a restart and differ per resource", () => {
    expect(deriveIdempotencyKey("ticket-4471", "campaign")).toBe(deriveIdempotencyKey("ticket-4471", "campaign"));
    expect(deriveIdempotencyKey("ticket-4471", "campaign")).not.toBe(deriveIdempotencyKey("ticket-4471", "ad_group:0"));
    expect(deriveIdempotencyKey("ticket-4471", "campaign")).not.toBe(deriveIdempotencyKey("ticket-4472", "campaign"));
  });

  it("substitutes refs from completed step outputs", () => {
    const resolved = resolveRefs({ campaign_id: { $ref: "campaign.id" }, name: "x" }, { campaign: { id: "cmpn_abc" } });
    expect(resolved).toEqual({ campaign_id: "cmpn_abc", name: "x" });
  });

  it("refuses to resolve a ref whose step has not produced a value", () => {
    expect(() => resolveRefs({ ad_group_id: { $ref: "ad_group:0.id" } }, {})).toThrow(/unresolved reference/);
  });
});
