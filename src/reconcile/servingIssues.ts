import type { Severity } from "@/domain/diagnostics";

/**
 * `GET /ads/{id}?include[]=serving_issues` answers "it is live but not spending",
 * but the codes arrive through one field and mean opposite things:
 * ad_account_brand_review_in_progress is "wait", title_missing is "you have a bug".
 *
 * Each code gets an owner, which decides who is notified, and a verdict, which
 * decides whether to keep polling, escalate, or fix the plan and republish.
 */

/** Who has to act. This drives routing, not just wording. */
export type Owner =
  | "platform" // Review or crawl in flight. Nobody can do anything but wait.
  | "billing" // Payment method, threshold, spend caps. Finance team.
  | "account" // Brand/identity verification on the ad account. Admin.
  | "advertiser" // A real configuration mistake. Surface inline, blocking.
  | "us"; // Something was left paused or incomplete: a bug in this service.

export type Verdict =
  | "wait" // Transient by design; keep polling on a backoff.
  | "escalate" // Needs a human; stop polling and notify the owner.
  | "fix_and_republish"; // Deterministically fixable from the plan.

export type IssueMeta = {
  owner: Owner;
  verdict: Verdict;
  severity: Severity;
  /** Written for a non-engineer. */
  explain: string;
};

const WAIT = (explain: string): IssueMeta => ({ owner: "platform", verdict: "wait", severity: "warning", explain });
const BILLING = (explain: string): IssueMeta => ({ owner: "billing", verdict: "escalate", severity: "blocker", explain });
const ACCOUNT = (explain: string): IssueMeta => ({ owner: "account", verdict: "escalate", severity: "blocker", explain });
const ADVERTISER = (explain: string): IssueMeta => ({ owner: "advertiser", verdict: "fix_and_republish", severity: "blocker", explain });
const OURS = (explain: string): IssueMeta => ({ owner: "us", verdict: "fix_and_republish", severity: "blocker", explain });

/** Union of the campaign, ad group and ad issue codes in the spec. */
export const SERVING_ISSUES: Record<string, IssueMeta> = {
  // Account standing
  ad_account_suspended: ACCOUNT("The ad account is suspended. Nothing will serve until it is reinstated."),
  ad_account_brand_review_missing_favicon: ACCOUNT("Brand review needs a favicon on the ad account. Upload one via /upload with purpose=account_favicon."),
  ad_account_brand_review_escalated_review: WAIT("Brand review was escalated to a manual reviewer. No action available."),
  ad_account_brand_review_rejected: ACCOUNT("Brand review was rejected. The account's branding must be corrected and resubmitted."),
  ad_account_brand_review_in_progress: WAIT("Brand review is still running. Ads stay eligible and begin serving when it clears."),
  ad_account_persona_verification_not_approved: ACCOUNT("Advertiser identity verification is not approved yet."),
  ad_account_persona_verification_step_up_required: ACCOUNT("Advertiser identity verification needs additional documents."),

  // Money
  ad_account_payment_method_missing_or_unauthorized: BILLING("No usable payment method on the ad account."),
  ad_account_threshold_payment_failed: BILLING("A threshold payment failed. Delivery stops until the balance clears."),
  campaign_budget_exhausted: {
    owner: "advertiser",
    verdict: "escalate",
    severity: "warning",
    explain: "The campaign hit its budget for the period. Raise the budget or wait for the next window.",
  },
  ad_account_budget_exhausted: {
    owner: "billing",
    verdict: "escalate",
    severity: "warning",
    explain: "The account-level spend limit is exhausted, so every campaign is capped.",
  },

  // Review and crawl
  review_not_approved: ADVERTISER("The creative was not approved in review. Check the rejection reason and revise the creative."),
  ad_in_review: WAIT("The creative is still in review. This is the normal state immediately after creating an ad."),
  landing_page_crawl_issue: ADVERTISER("The landing page could not be crawled. Confirm it is publicly reachable and returns 200. See GET /ads/{id}/landing_page_crawl."),
  partial_serving_review_not_approved: {
    owner: "advertiser",
    verdict: "fix_and_republish",
    severity: "warning",
    explain: "Some ads in this group were not approved; the rest are serving.",
  },
  partial_serving_landing_page_crawl_issue: {
    owner: "advertiser",
    verdict: "fix_and_republish",
    severity: "warning",
    explain: "Some ads have an uncrawlable landing page; the rest are serving.",
  },
  partial_serving_ad_in_review: WAIT("Some ads are still in review; the rest are serving."),

  // Lifecycle: almost always this service, not the advertiser
  campaign_not_active: OURS("The campaign is still paused. Activation ladder did not reach the campaign."),
  ad_group_not_active: OURS("The ad group is still paused. Activation ladder did not reach the ad group."),
  ad_not_active: OURS("The ad is still paused. Activation ladder did not reach the ad."),
  campaign_has_no_ad_groups: OURS("The campaign has no ad groups — a launch was left half-built."),
  campaign_has_no_serving_ready_ad_groups: OURS("No ad group in the campaign is serving-ready."),
  ad_group_has_no_ads: OURS("The ad group has no ads — a launch was left half-built."),
  ad_group_has_no_serving_ready_ads: OURS("No ad in the ad group is serving-ready."),
  campaign_not_started: {
    owner: "advertiser",
    verdict: "wait",
    severity: "info",
    explain: "The campaign's start_time is in the future. Delivery begins then.",
  },
  campaign_ended: {
    owner: "advertiser",
    verdict: "escalate",
    severity: "warning",
    explain: "The campaign's end_time has passed. Extend it to resume delivery.",
  },

  // Creative and targeting defects
  title_missing: ADVERTISER("The creative has no title. A chat_card needs a title of 3-50 characters."),
  advertiser_name_missing: ACCOUNT("The ad account has no advertiser name set, which every creative renders."),
  image_or_favicon_missing: ADVERTISER("The creative has neither an image nor an account favicon to fall back on."),
  target_url_invalid: ADVERTISER("The destination URL is malformed or unreachable."),
  reserved_query_params_present: ADVERTISER("The destination URL uses query parameters reserved by the platform. Remove them or move them into landing_page_configuration.query_string_template."),
  product_feed_id_missing: OURS("A product_feed campaign was created without a product feed id."),
  ad_over_18_only: {
    owner: "advertiser",
    verdict: "escalate",
    severity: "warning",
    explain: "The ad is restricted to adults, which materially narrows delivery.",
  },
  policy_country_targeting_blocked: ADVERTISER("Policy blocks this ad in a targeted country. Remove that country from targeting."),
  policy_country_targeting_limited: {
    owner: "advertiser",
    verdict: "escalate",
    severity: "warning",
    explain: "Policy limits this ad in a targeted country, so delivery there will be partial.",
  },
};

/** Unknown codes fail toward "a human should look", never toward silence. */
export function triage(code: string): IssueMeta {
  return (
    SERVING_ISSUES[code] ?? {
      owner: "us",
      verdict: "escalate",
      severity: "warning",
      explain: `Unrecognised serving issue "${code}". The platform has added a code this service does not know yet.`,
    }
  );
}

export type Readiness = {
  /** True when nothing is blocking and nothing is pending. */
  serving: boolean;
  /** True when the only thing left is platform-side waiting. */
  waitingOnPlatform: boolean;
  blockers: Array<{ code: string; level: "campaign" | "ad_group" | "ad"; id: string } & IssueMeta>;
  waits: Array<{ code: string; level: "campaign" | "ad_group" | "ad"; id: string } & IssueMeta>;
  /** Grouped for routing: who needs to be told. */
  owners: Owner[];
  /** Suggested seconds until the next poll, or null when polling is pointless. */
  retryAfterSec: number | null;
};

export function assessReadiness(
  issues: Array<{ code: string; level: "campaign" | "ad_group" | "ad"; id: string }>,
  attempt = 0,
): Readiness {
  const blockers: Readiness["blockers"] = [];
  const waits: Readiness["waits"] = [];

  for (const issue of issues) {
    const meta = triage(issue.code);
    const row = { ...issue, ...meta };
    if (meta.verdict === "wait") waits.push(row);
    else if (meta.severity === "blocker") blockers.push(row);
    else waits.push(row);
  }

  const owners = [...new Set([...blockers, ...waits].map((r) => r.owner))];
  const waitingOnPlatform = blockers.length === 0 && waits.some((w) => w.verdict === "wait");

  // Review takes hours, so polling every few seconds only burns rate limit.
  const retryAfterSec = waits.some((w) => w.verdict === "wait")
    ? Math.min(900, 30 * 2 ** Math.min(attempt, 5))
    : null;

  return {
    serving: blockers.length === 0 && waits.length === 0,
    waitingOnPlatform,
    blockers,
    waits,
    owners,
    retryAfterSec,
  };
}
