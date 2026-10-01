import { store } from "@/store";
import { fail, ok } from "@/http/respond";
import { publicLaunch } from "@/http/present";
import { createdResources } from "@/execute/saga";

/** GET /v1/launches/{id} — the plan, step states, and every real resource id. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const launch = store.getLaunch(id);
  if (!launch) return fail(404, "launch_not_found", `No launch with id "${id}".`);
  return ok({
    launch: publicLaunch(launch),
    resources: createdResources(launch),
    jobs: store.listJobs(launch.id).map((j) => ({ id: j.id, kind: j.kind, state: j.state, error: j.error })),
  });
}
