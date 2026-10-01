import type { AdsClient } from "@/ads/client";
import { AdsApiError } from "@/ads/client";
import { isRef, type LaunchPlan, type PlanStep, type StepKind } from "@/compile/plan";
import { store, type Job, type Launch, type StepRecord } from "@/store";

/**
 * Four creates, no transaction, no rollback — so this is a saga. A failure on the
 * third call leaves the first two real and visible in Ads Manager.
 *
 * Three things make that survivable: everything is created paused, so a half-built
 * launch cannot spend; idempotency keys are derived, so a retry reconciles onto
 * the existing resource; and progress is persisted per step, so a resume finishes
 * the launch rather than starting a second one.
 */

export type ExecuteResult = { launch: Launch; job: Job };

/** Fill `{ $ref: "step.field" }` placeholders from completed step outputs. */
export function resolveRefs(value: unknown, outputs: Record<string, Record<string, unknown>>): unknown {
  if (isRef(value)) {
    const [stepId, field] = value.$ref.split(".");
    const output = outputs[stepId!];
    if (!output || output[field!] === undefined) {
      throw new Error(`unresolved reference ${value.$ref} — step "${stepId}" has not produced "${field}"`);
    }
    return output[field!];
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, outputs));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveRefs(v, outputs)]));
  }
  return value;
}

async function runStep(client: AdsClient, step: PlanStep, body: unknown): Promise<Record<string, unknown>> {
  switch (step.kind) {
    case "create_campaign":
      return (await client.createCampaign(body, step.idempotencyKey)) as unknown as Record<string, unknown>;
    case "create_ad_group":
      return (await client.createAdGroup(body, step.idempotencyKey)) as unknown as Record<string, unknown>;
    case "create_ad":
      return (await client.createAd(body, step.idempotencyKey)) as unknown as Record<string, unknown>;
    case "upload_image": {
      const { image_url } = body as { image_url: string };
      return (await client.uploadImageFromUrl(image_url)) as unknown as Record<string, unknown>;
    }
  }
}

export async function execute(launch: Launch, client: AdsClient, job: Job): Promise<Launch> {
  const plan: LaunchPlan = launch.plan;
  job.state = "running";
  launch.state = "executing";
  store.putLaunch(launch);
  store.putJob(job);

  const outputs: Record<string, Record<string, unknown>> = {};
  for (const [stepId, record] of Object.entries(launch.steps)) {
    if (record.state === "done" && record.output) outputs[stepId] = record.output;
  }

  for (const step of plan.steps) {
    const record: StepRecord = launch.steps[step.id] ?? { stepId: step.id, state: "pending", attempts: 0 };
    launch.steps[step.id] = record;

    // Done on a previous attempt: the resume path.
    if (record.state === "done" && record.output) {
      outputs[step.id] = record.output;
      continue;
    }

    // Skipped rather than failed: a resume needs to tell "this broke" apart from
    // "this never got a chance".
    const missing = step.dependsOn.filter((dep) => !outputs[dep]);
    if (missing.length) {
      record.state = "skipped";
      record.error = { message: `blocked by incomplete step(s): ${missing.join(", ")}` };
      continue;
    }

    record.state = "running";
    record.attempts += 1;
    record.startedAt = new Date().toISOString();
    syncProgress(job, launch);
    store.putLaunch(launch);
    store.putJob(job);

    try {
      const body = resolveRefs(step.body, outputs);
      const output = await runStep(client, step, body);
      record.state = "done";
      record.output = output;
      record.finishedAt = new Date().toISOString();
      delete record.error;
      outputs[step.id] = output;
    } catch (cause) {
      record.state = "failed";
      record.finishedAt = new Date().toISOString();
      record.error =
        cause instanceof AdsApiError
          ? { message: cause.message, status: cause.status, retryable: cause.retryable }
          : { message: cause instanceof Error ? cause.message : String(cause), retryable: true };

      // Stop here. Pressing on would create children of a parent that does not
      // exist, which makes more orphans, not fewer.
      const anyCreated = Object.values(launch.steps).some((s) => s.state === "done");
      launch.state = anyCreated ? "partially_created" : "failed";
      job.state = "failed";
      job.error = record.error.message;
      job.finishedAt = new Date().toISOString();
      syncProgress(job, launch);
      store.putLaunch(launch);
      store.putJob(job);
      return launch;
    }
  }

  launch.state = "created";
  job.state = "succeeded";
  job.finishedAt = new Date().toISOString();
  syncProgress(job, launch);
  store.putLaunch(launch);
  store.putJob(job);
  return launch;
}

export function syncProgress(job: Job, launch: Launch): void {
  job.progress = launch.plan.steps.map((step) => {
    const record = launch.steps[step.id];
    return {
      stepId: step.id,
      label: step.label,
      state: record?.state ?? "pending",
      id: record?.output?.id as string | undefined,
    };
  });
}

/** Everything that actually exists, for the launch view and for cleanup. */
export function createdResources(launch: Launch): Array<{ stepId: string; kind: StepKind; id: string }> {
  return launch.plan.steps
    .map((step) => {
      const output = launch.steps[step.id]?.output;
      const id = (output?.id ?? output?.file_id) as string | undefined;
      return id ? { stepId: step.id, kind: step.kind, id } : null;
    })
    .filter((row): row is { stepId: string; kind: StepKind; id: string } => row !== null);
}
