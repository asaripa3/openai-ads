import { adAccount } from "@/http/context";
import { missingApiKey, ok, fail } from "@/http/respond";

/**
 * GET /v1/account — the pre-flight read. An account marked `active` can still have
 * an outstanding review, and currency and timezone silently decide what a budget
 * number and a schedule actually mean.
 */
export async function GET() {
  try {
    const account = await adAccount();
    if (!account) return missingApiKey();
    return ok({
      account,
      preflight: {
        currency: account.currency_code,
        timezone: account.timezone,
        status: account.status ?? "unknown",
        reviewStatus: account.review?.status ?? "unknown",
        note: "Budgets are interpreted in this currency and schedules in this timezone. An `active` account can still be mid-review, in which case resources create fine but nothing serves.",
      },
    });
  } catch (cause) {
    return fail(502, "ad_account_unreachable", cause instanceof Error ? cause.message : String(cause));
  }
}
