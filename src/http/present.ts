import { summarize } from "@/domain/diagnostics";
import type { Launch } from "@/store";

/**
 * The launch projection every route returns. Route modules may only export HTTP
 * handlers, so it lives here.
 *
 * Each step's request body and idempotency key are exposed on purpose: that is
 * what lets a reviewer see what will be sent, and reconcile a resource in Ads
 * Manager against the key that created it.
 */
export function publicLaunch(launch: Launch) {
  return {
    id: launch.id,
    reference: launch.reference,
    state: launch.state,
    planHash: launch.plan.planHash,
    goal: launch.plan.goal,
    currency: launch.plan.currency,
    derived: launch.plan.derived,
    diagnostics: launch.diagnostics,
    summary: summarize(launch.diagnostics),
    steps: launch.plan.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      label: step.label,
      method: step.method,
      path: step.path,
      idempotencyKey: step.idempotencyKey,
      dependsOn: step.dependsOn,
      body: step.body,
      state: launch.steps[step.id]?.state ?? "pending",
      resourceId: launch.steps[step.id]?.output?.id ?? launch.steps[step.id]?.output?.file_id,
      attempts: launch.steps[step.id]?.attempts ?? 0,
      error: launch.steps[step.id]?.error,
    })),
    createdAt: launch.createdAt,
    updatedAt: launch.updatedAt,
  };
}
