import { z } from "zod";
import { BILLING_EVENT_TYPES, PLATFORMS } from "@/ads/types";

/**
 * The advertiser-facing input. The API wants `bidding_type`, `objective`,
 * `billing_event_type`, `strategy` and `max_bid_micros` — five coupled fields.
 * The brief asks for a goal and a budget instead; the compiler derives the rest.
 */

const Goal = z.enum(["awareness", "traffic", "conversions"]);

const MoneyAmount = z
  .object({
    /** Major units, e.g. 50 for $50. */
    amount: z.number().positive(),
    /** Defaults to the ad account currency. */
    currency: z.string().length(3).toUpperCase().optional(),
  })
  .strict();

const Creative = z
  .object({
    title: z.string().min(1),
    body: z.string().min(1),
    targetUrl: z.string().url().optional(),
    price: z.string().optional(),
    /** An already-uploaded file_id, or a URL to upload on the caller's behalf. */
    fileId: z.string().optional(),
    imageUrl: z.string().url().optional(),
    imageCrop: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) })
      .strict()
      .optional(),
  })
  .strict();

const AdGroupBrief = z
  .object({
    name: z.string().min(1),
    /** Matched against conversations by the platform. */
    contextHints: z.array(z.string().min(1)).default([]),
    /** Max bid in major units. Omit for autobid. */
    maxBid: MoneyAmount.optional(),
    billingEvent: z.enum(BILLING_EVENT_TYPES).optional(),
    creatives: z.array(Creative).min(1),
  })
  .strict();

export const BriefSchema = z
  .object({
    /** Caller-chosen key. Two submits of the same reference are one launch. */
    reference: z.string().min(3).max(200),
    campaignName: z.string().min(1),
    goal: Goal,
    budget: z
      .object({
        daily: MoneyAmount.optional(),
        lifetime: MoneyAmount.optional(),
      })
      .strict()
      .refine((b) => Boolean(b.daily || b.lifetime), { message: "Set a daily or lifetime budget." }),
    schedule: z
      .object({
        startAt: z.string().datetime().optional(),
        endAt: z.string().datetime().optional(),
      })
      .strict()
      .default({}),
    targeting: z
      .object({
        /** ISO-3166 alpha-2. */
        countries: z.array(z.string()).default([]),
        /** Free text, resolved to geo ids through /geo_lookup/search. */
        places: z.array(z.string()).default([]),
        excludeCountries: z.array(z.string()).default([]),
        platforms: z.array(z.enum(PLATFORMS)).default([]),
        customAudienceIds: z.array(z.string()).default([]),
        excludeCustomAudienceIds: z.array(z.string()).default([]),
      })
      .strict()
      .default({ countries: [], places: [], excludeCountries: [], platforms: [], customAudienceIds: [], excludeCustomAudienceIds: [] }),
    /** Required by the platform when goal is "conversions". */
    conversionEventSettingIds: z.array(z.string()).default([]),
    adGroups: z.array(AdGroupBrief).min(1),
    /** Activate after the review gates clear, rather than staying paused. */
    activate: z.boolean().default(false),
  })
  .strict();

export type Brief = z.infer<typeof BriefSchema>;
export type CreativeBrief = z.infer<typeof Creative>;
export type AdGroupBriefInput = z.infer<typeof AdGroupBrief>;
