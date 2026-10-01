import type { AdsClient } from "@/ads/client";
import { assessReadiness, type Readiness } from "@/reconcile/servingIssues";
import { store, type Job, type Launch } from "@/store";
import { syncProgress } from "./saga";

/**
 * Two rules, both taken from the serving-issue codes. Activate bottom-up, because
 * a campaign activated first reports campaign_has_no_serving_ready_ad_groups and
 * spends nothing. And activation is not the finish line: creating an ad submits it
 * for review, so an activated ad reports ad_in_review, which is not an error.
 */

type Level = "ad" | "ad_group" | "campaign";

const levelOf = (stepId: string): Level => (stepId.startsWith("ad:") ? "ad" : stepId.startsWith("ad_group:") ? "ad_group" : "campaign");
const pluralOf: Record<Level, "ads" | "ad_groups" | "campaigns"> = { ad: "ads", ad_group: "ad_groups", campaign: "campaigns" };

export async function activate(launch: Launch, client: AdsClient, job: Job): Promise<Launch> {
  job.state = "running";
  launch.state = "activating";
  launch.activationRequested = true;
  store.putLaunch(launch);
  store.putJob(job);

  for (const entry of launch.plan.activationOrder) {
    const id = launch.steps[entry.stepId]?.output?.id as string | undefined;
    if (!id) {
      // Refuse rather than activate a partial campaign: one missing half its ads
      // spends the full budget on the half that exists.
      job.state = "failed";
      job.error = `cannot activate: step "${entry.stepId}" has no created resource. Resume execution first.`;
      job.finishedAt = new Date().toISOString();
      launch.state = "partially_created";
      store.putLaunch(launch);
      store.putJob(job);
      return launch;
    }

    try {
      await client.activate(pluralOf[levelOf(entry.stepId)], id);
    } catch (cause) {
      job.state = "failed";
      job.error = `activating ${entry.stepId} (${id}) failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      job.finishedAt = new Date().toISOString();
      store.putLaunch(launch);
      store.putJob(job);
      return launch;
    }
  }

  launch.state = "live";
  job.state = "succeeded";
  job.finishedAt = new Date().toISOString();
  syncProgress(job, launch);
  store.putLaunch(launch);
  store.putJob(job);
  return launch;
}

/** Rolls every level up into one answer: delivering, waiting, or blocked. */
export async function readiness(launch: Launch, client: AdsClient): Promise<Readiness & { checked: number }> {
  const issues: Array<{ code: string; level: Level; id: string }> = [];
  let checked = 0;

  for (const step of launch.plan.steps) {
    const id = launch.steps[step.id]?.output?.id as string | undefined;
    if (!id) continue;

    let resource: { serving_issues?: Array<{ code: string }> } | null = null;
    if (step.kind === "create_ad") resource = await client.getAdWithServingIssues(id);
    else if (step.kind === "create_ad_group") resource = await client.getAdGroupWithServingIssues(id);
    else if (step.kind === "create_campaign") resource = await client.getCampaignWithServingIssues(id);
    else continue;

    checked += 1;
    for (const issue of resource?.serving_issues ?? []) {
      issues.push({ code: issue.code, level: levelOf(step.id), id });
    }
  }

  // An account-level problem is reported identically on every ad; showing it
  // fifteen times is noise.
  const seen = new Set<string>();
  const deduped = issues.filter((issue) => {
    const key = `${issue.code}|${issue.level}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  launch.readinessPolls += 1;
  store.putLaunch(launch);
  return { ...assessReadiness(deduped, launch.readinessPolls - 1), checked };
}
