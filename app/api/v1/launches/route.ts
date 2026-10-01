import type { NextRequest } from "next/server";
import { BriefSchema } from "@/domain/brief";
import { compile } from "@/compile/compile";
import { validate } from "@/validate/validate";
import { hasBlockers, summarize } from "@/domain/diagnostics";
import { adAccount, resolvePlaces } from "@/http/context";
import { fail, ok, zodToDiagnostics } from "@/http/respond";
import { newId, store, type Launch } from "@/store";
import { publicLaunch } from "@/http/present";

/**
 * POST /v1/launches — compile a brief into a plan. Creates nothing, costs nothing,
 * safe to call on every keystroke. `?dryRun=1` skips persistence too.
 *
 * Returns 201 with diagnostics rather than 400: a brief with three fixable
 * problems is a draft, and the useful answer is the list, not a rejection.
 */
export async function POST(request: NextRequest) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return fail(400, "invalid_json", "Request body is not valid JSON.");
  }

  const parsed = BriefSchema.safeParse(json);
  if (!parsed.success) {
    return fail(422, "invalid_brief", "The brief does not match the expected shape.", {
      diagnostics: zodToDiagnostics(parsed.error),
    });
  }
  const brief = parsed.data;
  const dryRun = request.nextUrl.searchParams.get("dryRun") === "1";

  // One reference, one launch — the anchor above the API's Idempotency-Key.
  const existing = store.getLaunchByReference(brief.reference);
  if (existing && !dryRun) {
    const recompiled = compile(brief, {
      currency: existing.plan.currency,
      resolvedPlaces: await resolvePlaces(brief.targeting.places),
      now: new Date(),
    });
    if (recompiled.planHash !== existing.plan.planHash && existing.state !== "compiled") {
      return fail(409, "reference_in_use", `Reference "${brief.reference}" already has a launch in state "${existing.state}", and this brief compiles to a different plan.`, {
        launchId: existing.id,
        existingPlanHash: existing.plan.planHash,
        incomingPlanHash: recompiled.planHash,
        hint: "Use a new reference for a new campaign, or submit the identical brief to resume this one.",
      });
    }
    return ok({ launch: publicLaunch(existing), reused: true }, 200);
  }

  // Best-effort: without a key, compile still works and the account-dependent
  // checks are simply omitted.
  const account = await adAccount().catch(() => null);
  const ctx = {
    currency: account?.currency_code?.toUpperCase() ?? "USD",
    resolvedPlaces: await resolvePlaces(brief.targeting.places),
    now: new Date(),
  };

  const plan = compile(brief, ctx);
  const diagnostics = validate(brief, ctx, account ?? undefined);

  if (dryRun) {
    return ok({
      dryRun: true,
      plan,
      diagnostics,
      summary: summarize(diagnostics),
      executable: !hasBlockers(diagnostics),
      currencyResolvedFrom: account ? "ad_account" : "default (no API key configured)",
    });
  }

  const now = new Date().toISOString();
  const launch: Launch = {
    id: newId("lnch"),
    reference: brief.reference,
    state: "compiled",
    brief,
    plan,
    diagnostics,
    steps: Object.fromEntries(plan.steps.map((s) => [s.id, { stepId: s.id, state: "pending" as const, attempts: 0 }])),
    createdAt: now,
    updatedAt: now,
    activationRequested: brief.activate,
    readinessPolls: 0,
  };
  store.putLaunch(launch);

  return ok({ launch: publicLaunch(launch), executable: !hasBlockers(diagnostics), summary: summarize(diagnostics) }, 201);
}

/** GET /v1/launches — list. */
export async function GET() {
  return ok({ data: store.listLaunches().map(publicLaunch) });
}
