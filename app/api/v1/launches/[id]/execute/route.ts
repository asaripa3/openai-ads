import type { NextRequest } from "next/server";
import { store, newId, type Job } from "@/store";
import { execute } from "@/execute/saga";
import { adsClient } from "@/http/context";
import { fail, missingApiKey, ok } from "@/http/respond";
import { hasBlockers } from "@/domain/diagnostics";
import { publicLaunch } from "@/http/present";

/**
 * POST /v1/launches/{id}/execute — the only endpoint that creates anything.
 *
 * Three gates: blocking diagnostics refuse execution, since a known-invalid
 * payload may still create the campaign before failing on the ad; an optional
 * `expectedPlanHash` refuses a plan that changed since a human reviewed it; and
 * re-executing a finished launch is a no-op rather than a duplicate.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const launch = store.getLaunch(id);
  if (!launch) return fail(404, "launch_not_found", `No launch with id "${id}".`);

  const client = adsClient();
  if (!client) return missingApiKey();

  const body = await request.json().catch(() => ({}));
  const expectedPlanHash = (body as { expectedPlanHash?: string }).expectedPlanHash;
  if (expectedPlanHash && expectedPlanHash !== launch.plan.planHash) {
    return fail(409, "plan_changed", "The plan changed since it was read. Re-read the launch and confirm the new plan before executing.", {
      expectedPlanHash,
      actualPlanHash: launch.plan.planHash,
    });
  }

  if (hasBlockers(launch.diagnostics)) {
    return fail(422, "blocked_by_diagnostics", "This launch has blocking diagnostics and will not be executed.", {
      blockers: launch.diagnostics.filter((d) => d.severity === "blocker"),
    });
  }

  if (launch.state === "created" || launch.state === "live" || launch.state === "activating") {
    return ok({ launch: publicLaunch(launch), noop: true, reason: `Launch is already in state "${launch.state}".` });
  }

  const job: Job = {
    id: newId("job"),
    launchId: launch.id,
    kind: "execute",
    state: "queued",
    startedAt: new Date().toISOString(),
    progress: [],
  };
  store.putJob(job);

  // Awaited, not backgrounded: a function that returns early can be frozen
  // mid-saga. A launch too large for the request window belongs in a durable
  // queue with this saga as the worker; the step records are already checkpoints.
  const updated = await execute(launch, client, job);

  return ok(
    {
      launch: publicLaunch(updated),
      job: store.getJob(job.id),
      resumable: updated.state === "partially_created",
      ...(updated.state === "partially_created"
        ? { hint: "Some resources were created and are paused, so nothing is spending. POST this endpoint again to resume; completed steps are skipped and retried steps reuse their idempotency keys." }
        : {}),
    },
    updated.state === "created" ? 200 : 207,
  );
}
