import type { Brief } from "@/domain/brief";
import { toMicros } from "@/domain/money";
import { deriveIdempotencyKey, hashPlan, ref, type LaunchPlan, type PlanStep } from "./plan";
import { planBidding } from "./bidding";
import type { CreateAdBody, CreateAdGroupBody, CreateCampaignBody, GeoLocationRef, TargetingParams } from "@/ads/types";

/**
 * brief -> LaunchPlan. Pure: no clock, no network, no randomness, all of which are
 * passed in. That is what makes the plan hashable and lets tests assert on exact
 * payloads, and it means a compile can never spend money.
 */

export type CompileContext = {
  /** From GET /ad_account; budgets are denominated in it. */
  currency: string;
  /** Pre-resolved through /geo_lookup/search, which is a read. */
  resolvedPlaces: Record<string, GeoLocationRef | null>;
  /** Injected so two compiles of one brief produce one hash. */
  now: Date;
};

const unixSeconds = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

function buildTargeting(brief: Brief, ctx: CompileContext): TargetingParams | undefined {
  const t = brief.targeting;
  const include: GeoLocationRef[] = [];
  for (const place of t.places) {
    const resolved = ctx.resolvedPlaces[place];
    if (resolved) include.push(resolved);
  }

  const targeting: TargetingParams = {};
  if (t.countries.length || include.length) {
    targeting.locations = {
      ...(t.countries.length ? { countries: t.countries.map((c) => c.toUpperCase()) } : {}),
      ...(include.length ? { include } : {}),
    };
  }
  if (t.excludeCountries.length) {
    targeting.excluded_locations = { countries: t.excludeCountries.map((c) => c.toUpperCase()) };
  }
  if (t.platforms.length) targeting.platforms = { included: t.platforms };
  if (t.customAudienceIds.length) targeting.custom_audiences = { ids: t.customAudienceIds };
  if (t.excludeCustomAudienceIds.length) targeting.excluded_custom_audiences = { ids: t.excludeCustomAudienceIds };

  return Object.keys(targeting).length ? targeting : undefined;
}

export function compile(brief: Brief, ctx: CompileContext): LaunchPlan {
  const currency = (brief.budget.daily?.currency ?? brief.budget.lifetime?.currency ?? ctx.currency).toUpperCase();
  const hasAnyMaxBid = brief.adGroups.some((g) => g.maxBid !== undefined);
  const bidding = planBidding(brief.goal, hasAnyMaxBid);
  const steps: PlanStep[] = [];
  const key = (stepId: string) => deriveIdempotencyKey(brief.reference, stepId);

  // Always paused, whatever brief.activate says. Activation is its own phase, so a
  // launch that fails half way cannot spend against an unreviewed ad.
  const campaignBody: CreateCampaignBody = {
    name: brief.campaignName,
    status: "paused",
    budget: {
      ...(brief.budget.daily ? { daily_spend_limit_micros: toMicros(brief.budget.daily.amount) } : {}),
      ...(brief.budget.lifetime ? { lifetime_spend_limit_micros: toMicros(brief.budget.lifetime.amount) } : {}),
    },
    bidding_type: bidding.biddingType,
    objective: bidding.objective,
    billing_event_type: bidding.campaignBillingEvent,
    ...(brief.schedule.startAt ? { start_time: unixSeconds(brief.schedule.startAt) } : {}),
    ...(brief.schedule.endAt ? { end_time: unixSeconds(brief.schedule.endAt) } : {}),
    ...(brief.conversionEventSettingIds.length ? { conversion_event_setting_ids: brief.conversionEventSettingIds } : {}),
  };
  const targeting = buildTargeting(brief, ctx);
  if (targeting) campaignBody.targeting = targeting;

  steps.push({
    id: "campaign",
    kind: "create_campaign",
    method: "POST",
    path: "/campaigns",
    label: `Create campaign "${brief.campaignName}"`,
    body: campaignBody,
    dependsOn: [],
    idempotencyKey: key("campaign"),
  });

  brief.adGroups.forEach((group, gi) => {
    const groupStepId = `ad_group:${gi}`;
    const groupBody: CreateAdGroupBody = {
      campaign_id: ref("campaign", "id") as unknown as string,
      name: group.name,
      status: "paused",
      bidding_config: {
        billing_event_type: group.billingEvent ?? bidding.adGroupBillingEvent,
        ...(bidding.strategy && group.maxBid ? { strategy: bidding.strategy } : {}),
        ...(group.maxBid ? { max_bid_micros: toMicros(group.maxBid.amount) } : {}),
      },
      ...(group.contextHints.length ? { context_hints: group.contextHints } : {}),
    };

    steps.push({
      id: groupStepId,
      kind: "create_ad_group",
      method: "POST",
      path: "/ad_groups",
      label: `Create ad group "${group.name}"`,
      body: groupBody,
      dependsOn: ["campaign"],
      idempotencyKey: key(groupStepId),
    });

    group.creatives.forEach((creative, ci) => {
      const adStepId = `ad:${gi}:${ci}`;
      const dependsOn = [groupStepId];
      let fileRef: unknown = creative.fileId;

      // /upload takes no Idempotency-Key, so a retry yields a new file_id. That is
      // harmless but wasteful, hence its own step whose output is persisted.
      if (!creative.fileId && creative.imageUrl) {
        const uploadStepId = `upload:${gi}:${ci}`;
        steps.push({
          id: uploadStepId,
          kind: "upload_image",
          method: "POST",
          path: "/upload",
          label: `Upload image for "${creative.title}"`,
          body: { image_url: creative.imageUrl },
          dependsOn: [],
          idempotencyKey: key(uploadStepId),
        });
        dependsOn.push(uploadStepId);
        fileRef = ref(uploadStepId, "file_id");
      }

      const adBody: CreateAdBody = {
        ad_group_id: ref(groupStepId, "id") as unknown as string,
        // The ad name has a 3-char minimum that a short title can violate.
        name: creative.title.length >= 3 ? creative.title : `${group.name} ad ${ci + 1}`,
        status: "paused",
        creative: {
          type: "chat_card",
          title: creative.title,
          body: creative.body,
          ...(creative.price ? { price: creative.price } : {}),
          ...(creative.targetUrl ? { target_url: creative.targetUrl } : {}),
          ...(fileRef ? { file_id: fileRef as string } : {}),
          ...(creative.imageCrop && fileRef ? { image_crop: creative.imageCrop } : {}),
        },
      };

      steps.push({
        id: adStepId,
        kind: "create_ad",
        method: "POST",
        path: "/ads",
        label: `Create ad "${creative.title}"`,
        body: adBody,
        dependsOn,
        idempotencyKey: key(adStepId),
      });
    });
  });

  const activationOrder: LaunchPlan["activationOrder"] = [
    ...steps.filter((s) => s.kind === "create_ad").map((s) => ({ stepId: s.id, path: (id: string) => `/ads/${id}/activate` })),
    ...steps.filter((s) => s.kind === "create_ad_group").map((s) => ({ stepId: s.id, path: (id: string) => `/ad_groups/${id}/activate` })),
    { stepId: "campaign", path: (id: string) => `/campaigns/${id}/activate` },
  ];

  const derived = {
    bidding_type: bidding.biddingType,
    objective: bidding.objective,
    campaign_billing_event_type: bidding.campaignBillingEvent,
    ad_group_billing_event_type: bidding.adGroupBillingEvent,
    strategy: bidding.strategy ?? `(omitted — platform selects ${bidding.expectedAutoBidStrategy})`,
    requires_conversion_events: bidding.requiresConversionEvents,
    created_status: "paused",
    activate_after_review: brief.activate,
  };

  return {
    reference: brief.reference,
    currency,
    goal: brief.goal,
    derived,
    steps,
    activationOrder,
    planHash: hashPlan(steps, { derived, currency }),
  };
}
