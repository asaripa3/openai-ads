/** Enums and bounds from the Advertiser API spec (v2.3.0, see openapi.snapshot.json). */

export const ADS_BASE_URL = "https://api.ads.openai.com/v1";

export const ACTIVE_PAUSED = ["active", "paused"] as const;
export type ActivePausedStatus = (typeof ACTIVE_PAUSED)[number];

export const CAMPAIGN_BIDDING_TYPES = ["impressions", "clicks", "conversions"] as const;
export type CampaignBiddingType = (typeof CAMPAIGN_BIDDING_TYPES)[number];

export const CAMPAIGN_OBJECTIVES = ["reach", "clicks", "conversions"] as const;
export type CampaignObjective = (typeof CAMPAIGN_OBJECTIVES)[number];

/** Both campaign-level and ad-group-level billing events use this pair. */
export const BILLING_EVENT_TYPES = ["impression", "click"] as const;
export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];

export const BIDDING_STRATEGIES = ["fixed_bid", "maximize_clicks", "maximize_conversions"] as const;
export type BiddingStrategy = (typeof BIDDING_STRATEGIES)[number];

export const CAMPAIGN_MODES = ["product_feed", "business_agent"] as const;
export type CampaignMode = (typeof CAMPAIGN_MODES)[number];

export const AD_CREATIVE_TYPES = ["chat_card", "product_ad_template"] as const;
export type AdCreativeType = (typeof AD_CREATIVE_TYPES)[number];

export const PLATFORMS = ["ios_app", "android_app", "web", "desktop_web", "ios_web", "android_web"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Violating any of these is a 400 from the platform, so each gets a diagnostic instead. */
export const LIMITS = {
  /** name: minLength 3, maxLength 1000 at every level. */
  nameMin: 3,
  nameMax: 1000,
  /** creative.title: 3..50 */
  titleMin: 3,
  titleMax: 50,
  /** creative.body: <= 100. */
  bodyMax: 100,
  /** creative.price: <= 100. */
  priceMax: 100,
  /** creative.target_url: <= 2048. */
  targetUrlMax: 2048,
  /** budget.{daily,lifetime}_spend_limit_micros: min 1_000_000 (one currency unit). */
  budgetMinMicros: 1_000_000,
  /** bidding_config.max_bid_micros: 1 .. 30_400_000_000_000. */
  maxBidMinMicros: 1,
  maxBidMaxMicros: 30_400_000_000_000,
  /** custom_audience_bid_multipliers[].bid_multiplier_micros: 100_000 .. 10_000_000. */
  bidMultiplierMinMicros: 100_000,
  bidMultiplierMaxMicros: 10_000_000,
  /** context_hints: maxItems 2000. */
  contextHintsMax: 2000,
  /** targeting.locations.include: maxItems 2500. */
  geoIncludeMax: 2500,
  /** start_time / end_time are unix seconds in this window. */
  timeMin: 946_684_800,
  timeMax: 4_102_444_800,
  /** Images should be at least 640x640. */
  imageMinEdge: 640,
} as const;

/** Enforced per ad account and per IP. */
export const RATE_LIMITS = {
  perEndpointPerMinute: 600,
  overallPerMinute: 1_200,
} as const;

// Request bodies, limited to the subset this service composes.

export type BudgetParams = {
  daily_spend_limit_micros?: number;
  lifetime_spend_limit_micros?: number;
};

export type GeoLocationRef = {
  id: string;
  name?: string;
  type?: string;
  country_code?: string;
  region_code?: string;
};

export type TargetingParams = {
  locations?: { countries?: string[]; include?: GeoLocationRef[] };
  excluded_locations?: { countries?: string[]; include?: GeoLocationRef[] };
  custom_audiences?: { ids?: string[] };
  excluded_custom_audiences?: { ids?: string[] };
  platforms?: { included?: Platform[] } | null;
};

export type CreateCampaignBody = {
  name: string;
  status: ActivePausedStatus;
  budget: BudgetParams;
  description?: string;
  start_time?: number;
  end_time?: number;
  bidding_type?: CampaignBiddingType;
  objective?: CampaignObjective;
  billing_event_type?: BillingEventType;
  mode?: CampaignMode;
  product_feed_id?: string;
  business_agent_id?: string;
  targeting?: TargetingParams | null;
  landing_page_configuration?: { query_string_template?: string };
  conversion_event_setting_ids?: string[];
};

export type CreateAdGroupBody = {
  campaign_id: string;
  name: string;
  status: ActivePausedStatus;
  bidding_config: {
    billing_event_type: BillingEventType;
    strategy?: BiddingStrategy;
    max_bid_micros?: number;
    custom_audience_bid_multipliers?: Array<{ custom_audience_id: string; bid_multiplier_micros: number }>;
  };
  description?: string;
  context_hints?: string[];
  landing_page_configuration?: { query_string_template?: string };
};

export type CreateAdBody = {
  ad_group_id: string;
  name: string;
  status: ActivePausedStatus;
  creative: {
    type: AdCreativeType;
    title: string;
    body: string;
    price?: string;
    target_url?: string;
    file_id?: string;
    image_crop?: { x: number; y: number; width: number; height: number };
  };
  landing_page_configuration?: { query_string_template?: string };
};

export type AdAccountResource = {
  id: string;
  name: string;
  url: string;
  preview_url: string | null;
  timezone: string;
  currency_code: string;
  status?: string;
  legal_name?: string;
  account_name?: string;
  brand_name?: string;
  review: { status?: string; [k: string]: unknown };
  account_integrity_review?: { status?: string; [k: string]: unknown };
};
