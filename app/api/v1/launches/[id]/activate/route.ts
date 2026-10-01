import type { NextRequest } from "next/server";
import { store, newId, type Job } from "@/store";
import { activate, readiness } from "@/execute/activate";
import { adsClient } from "@/http/context";
import { fail, missingApiKey, ok } from "@/http/respond";
import { publicLaunch } from "@/http/present";

/**
 * POST /v1/launches/{id}/activate — bottom-up activation.
 *
 * Refuses while anything is blocked: activating into a blocked state produces a
 * campaign that reads "live" everywhere and delivers nothing. `force: true` is
 * for when the blocker is known and accepted.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const launch = store.getLaunch(id);
  if (!launch) return fail(404, "launch_not_found", `No launch with id "${id}".`);

  const client = adsClient();
  if (!client) return missingApiKey();

  if (launch.state === "compiled" || launch.state === "failed") {
    return fail(409, "nothing_to_activate", `Launch is in state "${launch.state}". Execute it first.`);
  }
  if (launch.state === "partially_created") {
    return fail(409, "launch_incomplete", "Some resources were never created. Resume execution before activating, or the campaign goes live missing part of its structure.", {
      hint: `POST /v1/launches/${launch.id}/execute`,
    });
  }

  const body = (await request.json().catch(() => ({}))) as { force?: boolean };
  const current = await readiness(launch, client);

  // ad_in_review is expected: review starts at creation and finishes much later.
  if (current.blockers.length && !body.force) {
    return fail(409, "not_ready_to_activate", "Serving issues would prevent delivery, so activation was refused.", {
      readiness: current,
      hint: "Resolve the blockers, or pass { \"force\": true } to activate anyway.",
    });
  }

  const job: Job = { id: newId("job"), launchId: launch.id, kind: "activate", state: "queued", startedAt: new Date().toISOString(), progress: [] };
  store.putJob(job);

  const updated = await activate(launch, client, job);
  const after = await readiness(updated, client);

  return ok({
    launch: publicLaunch(updated),
    job: store.getJob(job.id),
    readiness: after,
    message: after.serving
      ? "Delivering."
      : after.waitingOnPlatform
        ? "Activated. Everything is waiting on platform-side review; nothing to do."
        : "Activated, but delivery is blocked. See readiness.blockers.",
  });
}
