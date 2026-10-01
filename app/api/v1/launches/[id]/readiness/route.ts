import { store } from "@/store";
import { readiness } from "@/execute/activate";
import { adsClient } from "@/http/context";
import { fail, missingApiKey, ok } from "@/http/respond";

/**
 * GET /v1/launches/{id}/readiness — is it delivering, and if not, who fixes it?
 *
 * Each issue carries an owner and a verdict so the caller can route it rather than
 * render a wall of codes. `retryAfterSec` is a real backoff: review takes hours.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const launch = store.getLaunch(id);
  if (!launch) return fail(404, "launch_not_found", `No launch with id "${id}".`);

  const client = adsClient();
  if (!client) return missingApiKey();

  const result = await readiness(launch, client);
  return ok({
    launchId: launch.id,
    state: launch.state,
    ...result,
    byOwner: Object.fromEntries(
      result.owners.map((owner) => [owner, [...result.blockers, ...result.waits].filter((r) => r.owner === owner).map((r) => ({ code: r.code, level: r.level, explain: r.explain, verdict: r.verdict }))]),
    ),
  });
}
