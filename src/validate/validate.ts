import type { Brief } from "@/domain/brief";
import { blocker, info, sortDiagnostics, warning, type Diagnostic } from "@/domain/diagnostics";
import { formatMicros, isZeroDecimal, toMicros } from "@/domain/money";
import { LIMITS, type AdAccountResource } from "@/ads/types";
import { planBidding, bidUnitMismatch } from "@/compile/bidding";
import type { CompileContext } from "@/compile/compile";

/**
 * Every check that can be made without creating anything. A problem caught here
 * costs nothing; the same problem after execution costs an orphaned campaign and,
 * once review has run, hours of waiting.
 */

const RESERVED_QUERY_PARAMS = new Set(["utm_source", "gclid", "openai_click_id", "oai_cid"]);

/** Claims that reliably fail creative review. */
const RISKY_CLAIMS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bguarantee(d|s)?\b/i, label: "an unconditional guarantee" },
  { pattern: /\b(cure|cures|heals?)\b/i, label: "a health cure claim" },
  { pattern: /\b100%\s*(free|safe|risk[- ]free|guaranteed)\b/i, label: "an absolute claim" },
  { pattern: /\bmiracle\b/i, label: "a miracle claim" },
  { pattern: /\bget rich\b/i, label: "an income claim" },
  { pattern: /\bno risk\b/i, label: "a no-risk claim" },
];

export function validate(brief: Brief, ctx: CompileContext, account?: AdAccountResource): Diagnostic[] {
  const out: Diagnostic[] = [];
  const currency = (brief.budget.daily?.currency ?? brief.budget.lifetime?.currency ?? ctx.currency).toUpperCase();

  // An account can report `active` and still be mid-review: resources create
  // fine, nothing serves, and the silence reads as a bug in this service.
  if (account) {
    const review = String(account.review?.status ?? "").toLowerCase();
    if (review && !["approved", "active", "cleared"].includes(review)) {
      out.push(
        warning("account_review_pending", "", `The ad account review is "${review}". Resources can be created now, but delivery will not begin until it clears.`, {
          source: "GET /ad_account.review.status",
        }),
      );
    }
    if (account.status && account.status.toLowerCase() !== "active") {
      out.push(blocker("account_not_active", "", `The ad account status is "${account.status}". Nothing will serve.`, { source: "GET /ad_account.status" }));
    }
    const accountCurrency = account.currency_code?.toUpperCase();
    if (accountCurrency && currency !== accountCurrency) {
      out.push(
        blocker("currency_mismatch", "/budget", `Budget is denominated in ${currency} but the ad account bills in ${accountCurrency}. The API has no conversion; the number would be spent as ${accountCurrency}.`, {
          fix: { summary: `Restate the budget in ${accountCurrency}` },
          source: "GET /ad_account.currency_code",
        }),
      );
    }
  }

  for (const [kind, money] of [["daily", brief.budget.daily], ["lifetime", brief.budget.lifetime]] as const) {
    if (!money) continue;
    const micros = toMicros(money.amount);
    if (micros < LIMITS.budgetMinMicros) {
      out.push(
        blocker("budget_below_minimum", `/budget/${kind}/amount`, `A ${kind} budget of ${formatMicros(micros, currency)} is below the API minimum of ${formatMicros(LIMITS.budgetMinMicros, currency)} (${LIMITS.budgetMinMicros} micros).`, {
          fix: { summary: `Raise to at least ${formatMicros(LIMITS.budgetMinMicros, currency)}`, value: 1 },
          source: "BudgetParams.minimum",
        }),
      );
    }
    if (isZeroDecimal(currency) && !Number.isInteger(money.amount)) {
      out.push(warning("fractional_zero_decimal_currency", `/budget/${kind}/amount`, `${currency} has no minor units, so ${money.amount} will be rounded.`));
    }
  }
  if (brief.budget.daily && brief.budget.lifetime) {
    const daily = toMicros(brief.budget.daily.amount);
    const lifetime = toMicros(brief.budget.lifetime.amount);
    if (lifetime < daily) {
      out.push(blocker("lifetime_below_daily", "/budget/lifetime/amount", `The lifetime budget (${formatMicros(lifetime, currency)}) is below the daily budget (${formatMicros(daily, currency)}), so the campaign would stop part-way through its first day.`));
    }
  }

  const start = brief.schedule.startAt ? new Date(brief.schedule.startAt) : null;
  const end = brief.schedule.endAt ? new Date(brief.schedule.endAt) : null;
  for (const [field, date] of [["startAt", start], ["endAt", end]] as const) {
    if (!date) continue;
    const secs = Math.floor(date.getTime() / 1000);
    if (secs < LIMITS.timeMin || secs > LIMITS.timeMax) {
      out.push(blocker("time_out_of_range", `/schedule/${field}`, `${field} must fall between 2000-01-01 and 2100-01-01 as a unix timestamp.`, { source: "CreateCampaignBody.start_time bounds" }));
    }
  }
  if (start && end && end <= start) {
    out.push(blocker("end_before_start", "/schedule/endAt", "endAt must be after startAt."));
  }
  if (end && end <= ctx.now) {
    out.push(blocker("end_in_past", "/schedule/endAt", "endAt is in the past, so the campaign would report campaign_ended immediately."));
  }
  if (account?.timezone && (start || end)) {
    out.push(info("schedule_timezone", "/schedule", `Schedule times are interpreted against the ad account timezone, ${account.timezone}.`, { source: "GET /ad_account.timezone" }));
  }

  const hasAnyMaxBid = brief.adGroups.some((g) => g.maxBid !== undefined);
  const bidding = planBidding(brief.goal, hasAnyMaxBid);
  if (bidding.requiresConversionEvents && brief.conversionEventSettingIds.length === 0) {
    out.push(
      blocker("conversion_events_required", "/conversionEventSettingIds", "A conversions goal needs a conversion event setting. Create one with POST /conversions/event_settings and pass its id.", {
        source: "Changelog 2026-06-16: conversion bidding requires one standard conversion event setting",
      }),
    );
  }
  if (!bidding.requiresConversionEvents && brief.conversionEventSettingIds.length > 0) {
    out.push(warning("conversion_events_ignored", "/conversionEventSettingIds", `A "${brief.goal}" goal does not optimise for conversions, so these event settings only affect reporting.`));
  }
  if (bidding.requiresConversionEvents && brief.conversionEventSettingIds.length > 1) {
    out.push(warning("multiple_conversion_events", "/conversionEventSettingIds", "Conversion bidding expects a single standard conversion event setting."));
  }
  if (!hasAnyMaxBid) {
    out.push(info("autobid_selected", "", `No max bid given, so strategy and max_bid_micros are omitted and the platform selects its ${bidding.expectedAutoBidStrategy} equivalent.`, { source: "BiddingConfigParams.strategy description" }));
  }

  const t = brief.targeting;
  if (!t.countries.length && !t.places.length) {
    out.push(warning("no_geo_targeting", "/targeting", "No locations targeted, so the campaign runs everywhere the account is eligible."));
  }
  for (const [i, code] of t.countries.entries()) {
    if (!/^[A-Za-z]{2}$/.test(code)) {
      out.push(blocker("country_not_alpha2", `/targeting/countries/${i}`, `"${code}" is not an ISO-3166 alpha-2 country code. Resolve free-text places through /geo_lookup/search and pass them in "places" instead.`, { source: "GET /geo_lookup/search" }));
    }
  }
  for (const place of t.places) {
    if (ctx.resolvedPlaces[place] === null) {
      out.push(blocker("place_unresolved", "/targeting/places", `"${place}" did not match any location in /geo_lookup/search and has been dropped from targeting.`, { source: "GET /geo_lookup/search" }));
    }
  }
  const geoIncludeCount = t.places.filter((p) => ctx.resolvedPlaces[p]).length;
  if (geoIncludeCount > LIMITS.geoIncludeMax) {
    out.push(blocker("too_many_geo_includes", "/targeting/places", `${geoIncludeCount} resolved locations exceeds the limit of ${LIMITS.geoIncludeMax}.`, { source: "TargetingGeoLocationsParams.include.maxItems" }));
  }
  const overlap = t.countries.map((c) => c.toUpperCase()).filter((c) => t.excludeCountries.map((e) => e.toUpperCase()).includes(c));
  if (overlap.length) {
    out.push(blocker("geo_include_exclude_conflict", "/targeting/excludeCountries", `${overlap.join(", ")} appear in both included and excluded locations, which excludes all delivery there.`));
  }
  const audienceOverlap = t.customAudienceIds.filter((id) => t.excludeCustomAudienceIds.includes(id));
  if (audienceOverlap.length) {
    out.push(blocker("audience_include_exclude_conflict", "/targeting/excludeCustomAudienceIds", `${audienceOverlap.join(", ")} are both included and excluded.`));
  }

  checkName(out, brief.campaignName, "/campaignName");

  brief.adGroups.forEach((group, gi) => {
    checkName(out, group.name, `/adGroups/${gi}/name`);

    if (group.maxBid) {
      const bid = toMicros(group.maxBid.amount);
      if (bid < LIMITS.maxBidMinMicros || bid > LIMITS.maxBidMaxMicros) {
        out.push(blocker("max_bid_out_of_range", `/adGroups/${gi}/maxBid/amount`, `max_bid_micros must be between ${LIMITS.maxBidMinMicros} and ${LIMITS.maxBidMaxMicros}; ${bid} is outside it.`, { source: "BiddingConfigParams.max_bid_micros bounds" }));
      }
      const dailyMicros = brief.budget.daily ? toMicros(brief.budget.daily.amount) : null;
      if (dailyMicros && bid > dailyMicros) {
        out.push(warning("bid_exceeds_daily_budget", `/adGroups/${gi}/maxBid/amount`, `A max bid of ${formatMicros(bid, currency)} exceeds the whole daily budget of ${formatMicros(dailyMicros, currency)}, so the campaign can win at most one event per day.`));
      }
      if (bidUnitMismatch(bidding, group.billingEvent)) {
        out.push(blocker("billing_event_conflicts_with_goal", `/adGroups/${gi}/billingEvent`, `A "${brief.goal}" goal bills on ${bidding.adGroupBillingEvent}, but this ad group asks to bill on ${group.billingEvent}. A per-${group.billingEvent} bid is not comparable to a per-${bidding.adGroupBillingEvent} bid.`, { fix: { summary: `Bill on ${bidding.adGroupBillingEvent}`, value: bidding.adGroupBillingEvent } }));
      }
    }

    if (group.contextHints.length > LIMITS.contextHintsMax) {
      out.push(blocker("too_many_context_hints", `/adGroups/${gi}/contextHints`, `${group.contextHints.length} context hints exceeds the limit of ${LIMITS.contextHintsMax}.`, { source: "CreateAdGroupBody.context_hints.maxItems" }));
    }
    if (group.contextHints.length === 0) {
      out.push(warning("no_context_hints", `/adGroups/${gi}/contextHints`, "No context hints, so the ad group relies entirely on targeting to find relevant conversations."));
    }

    group.creatives.forEach((creative, ci) => {
      const base = `/adGroups/${gi}/creatives/${ci}`;

      // title: 3..50, roughly half what other ad platforms allow.
      if (creative.title.length < LIMITS.titleMin) {
        out.push(blocker("title_too_short", `${base}/title`, `Titles must be at least ${LIMITS.titleMin} characters.`, { source: "CreateAdCreativeParams.title.minLength" }));
      }
      if (creative.title.length > LIMITS.titleMax) {
        out.push(
          blocker("title_too_long", `${base}/title`, `The title is ${creative.title.length} characters; the limit is ${LIMITS.titleMax}.`, {
            fix: { summary: `Trim to ${LIMITS.titleMax} characters`, value: truncateOnWord(creative.title, LIMITS.titleMax) },
            source: "CreateAdCreativeParams.title.maxLength",
          }),
        );
      }
      if (creative.body.length > LIMITS.bodyMax) {
        out.push(
          blocker("body_too_long", `${base}/body`, `The body is ${creative.body.length} characters; the limit is ${LIMITS.bodyMax}.`, {
            fix: { summary: `Trim to ${LIMITS.bodyMax} characters`, value: truncateOnWord(creative.body, LIMITS.bodyMax) },
            source: "CreateAdCreativeParams.body.maxLength",
          }),
        );
      }
      if (creative.price && creative.price.length > LIMITS.priceMax) {
        out.push(blocker("price_too_long", `${base}/price`, `price exceeds ${LIMITS.priceMax} characters.`));
      }

      // target_url is optional in the schema, but an ad without one reports
      // target_url_invalid at serving time.
      if (!creative.targetUrl) {
        out.push(warning("no_target_url", `${base}/targetUrl`, "No destination URL. Expect a target_url_invalid serving issue unless the campaign uses a product feed."));
      } else {
        if (creative.targetUrl.length > LIMITS.targetUrlMax) {
          out.push(blocker("target_url_too_long", `${base}/targetUrl`, `target_url exceeds ${LIMITS.targetUrlMax} characters.`));
        }
        let parsed: URL | null = null;
        try {
          parsed = new URL(creative.targetUrl);
        } catch {
          out.push(blocker("target_url_unparseable", `${base}/targetUrl`, "The destination URL could not be parsed."));
        }
        if (parsed) {
          if (parsed.protocol !== "https:") {
            out.push(blocker("target_url_not_https", `${base}/targetUrl`, `The destination must be https; got ${parsed.protocol.replace(":", "")}.`, { fix: { summary: "Use https", value: creative.targetUrl.replace(/^http:/, "https:") } }));
          }
          const reserved = [...parsed.searchParams.keys()].filter((k) => RESERVED_QUERY_PARAMS.has(k.toLowerCase()));
          if (reserved.length) {
            out.push(
              blocker("reserved_query_params", `${base}/targetUrl`, `${reserved.join(", ")} are reserved by the platform and cause a reserved_query_params_present serving issue. Move them into landing_page_configuration.query_string_template.`, {
                source: "AdServingIssueCode.reserved_query_params_present",
              }),
            );
          }
          if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(parsed.hostname)) {
            out.push(blocker("target_url_not_public", `${base}/targetUrl`, "The destination is not publicly reachable, so the landing page crawler will fail it."));
          }
        }
      }

      // A chat_card with no image falls back to the account favicon, and reports
      // image_or_favicon_missing when there is no favicon either.
      if (!creative.fileId && !creative.imageUrl) {
        out.push(warning("no_creative_image", `${base}`, `No image. The card will fall back to the account favicon, and report image_or_favicon_missing if the account has none. Images should be at least ${LIMITS.imageMinEdge}x${LIMITS.imageMinEdge}.`, { source: "AdServingIssueCode.image_or_favicon_missing" }));
      }
      if (creative.fileId && creative.imageUrl) {
        out.push(warning("ambiguous_image_source", `${base}`, "Both fileId and imageUrl were given; fileId wins and no upload is performed."));
      }
      if (creative.imageCrop && !creative.fileId && !creative.imageUrl) {
        out.push(blocker("crop_without_image", `${base}/imageCrop`, "image_crop requires a file_id.", { source: "AdImageCropParams description" }));
      }
      if (creative.imageCrop) {
        const { x, y, width, height } = creative.imageCrop;
        if (x + width > 1.0001 || y + height > 1.0001) {
          out.push(blocker("crop_out_of_bounds", `${base}/imageCrop`, "The crop extends past the edge of the source image; x+width and y+height must each be <= 1."));
        }
        if (Math.abs(width - height) > 0.001) {
          out.push(warning("crop_not_square", `${base}/imageCrop`, "chat_card crops are square; a non-square crop will be adjusted by the platform."));
        }
      }

      // Always a warning: this service is not the policy authority, and blocking
      // an advertiser on a guess is worse than flagging it.
      for (const { pattern, label } of RISKY_CLAIMS) {
        if (pattern.test(creative.title) || pattern.test(creative.body)) {
          out.push(warning("review_risk_claim", base, `The copy contains ${label}, which commonly fails creative review and would surface as review_not_approved hours later.`));
        }
      }
      if (/[A-Z]{6,}/.test(creative.title)) {
        out.push(info("shouty_title", `${base}/title`, "Long runs of capitals read as spam to reviewers."));
      }
    });
  });

  const adCount = brief.adGroups.reduce((n, g) => n + g.creatives.length, 0);
  const callCount = 1 + brief.adGroups.length + adCount + brief.adGroups.flatMap((g) => g.creatives).filter((c) => !c.fileId && c.imageUrl).length;
  if (callCount > 100) {
    out.push(info("large_launch", "", `This launch is ${callCount} API calls. At 600 requests per minute per endpoint it is fine, but it is worth running through the Bulk API instead.`, { source: "Rate limits" }));
  }

  return sortDiagnostics(out);
}

function checkName(out: Diagnostic[], name: string, path: string): void {
  if (name.trim().length < LIMITS.nameMin) {
    out.push(blocker("name_too_short", path, `Names must be at least ${LIMITS.nameMin} non-whitespace characters.`, { source: "name.minLength / pattern ^.*\\S.*$" }));
  }
  if (name.length > LIMITS.nameMax) {
    out.push(blocker("name_too_long", path, `Names must be at most ${LIMITS.nameMax} characters.`, { fix: { summary: "Trim", value: name.slice(0, LIMITS.nameMax) } }));
  }
}

/** Trim on a word boundary so a one-click fix does not cut mid-word. */
export function truncateOnWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd();
}
