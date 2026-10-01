import type { BiddingStrategy, BillingEventType, CampaignBiddingType, CampaignObjective } from "@/ads/types";
import type { Brief } from "@/domain/brief";

/**
 * The five bidding fields must agree, but the API validates them independently,
 * so an illegal combination 400s on whichever create runs first — often after the
 * campaign exists. Keeping the legal combinations in one table means a new goal
 * is one new row.
 */

export type BiddingPlan = {
  biddingType: CampaignBiddingType;
  objective: CampaignObjective;
  campaignBillingEvent: BillingEventType;
  adGroupBillingEvent: BillingEventType;
  /**
   * Omitted when there is no max bid: the spec says omitting both `strategy` and
   * `max_bid_micros` selects the compatible AutoBid, which beats guessing a name.
   */
  strategy?: BiddingStrategy;
  expectedAutoBidStrategy: BiddingStrategy;
  /** Conversion event settings the platform requires for this goal. */
  requiresConversionEvents: boolean;
};

const MATRIX: Record<Brief["goal"], Omit<BiddingPlan, "strategy">> = {
  awareness: {
    biddingType: "impressions",
    objective: "reach",
    campaignBillingEvent: "impression",
    adGroupBillingEvent: "impression",
    // No "maximize_impressions" exists; this falls back to the reach autobid.
    expectedAutoBidStrategy: "fixed_bid",
    requiresConversionEvents: false,
  },
  traffic: {
    biddingType: "clicks",
    objective: "clicks",
    campaignBillingEvent: "click",
    adGroupBillingEvent: "click",
    expectedAutoBidStrategy: "maximize_clicks",
    requiresConversionEvents: false,
  },
  conversions: {
    biddingType: "conversions",
    objective: "conversions",
    campaignBillingEvent: "click",
    adGroupBillingEvent: "click",
    expectedAutoBidStrategy: "maximize_conversions",
    requiresConversionEvents: true,
  },
};

export function planBidding(goal: Brief["goal"], hasMaxBid: boolean): BiddingPlan {
  const row = MATRIX[goal];
  // Only fixed_bid accepts a max bid; the maximize_* strategies do not.
  return hasMaxBid ? { ...row, strategy: "fixed_bid" } : { ...row };
}

/**
 * Reports a bid denominated in the wrong event. Coercing CPM to CPC silently would
 * change spend by orders of magnitude, so this is surfaced instead.
 */
export function bidUnitMismatch(plan: BiddingPlan, billingEvent: BillingEventType | undefined): boolean {
  return billingEvent !== undefined && billingEvent !== plan.adGroupBillingEvent;
}
