import { store } from "@/store";
import { fail, ok } from "@/http/respond";

/** GET /v1/jobs/{id} — step-by-step progress for one execute or activate run. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = store.getJob(id);
  if (!job) return fail(404, "job_not_found", `No job with id "${id}".`);
  return ok({ job });
}
