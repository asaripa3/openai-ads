import type { Diagnostic } from "@/domain/diagnostics";
import type { LaunchPlan } from "@/compile/plan";
import type { Brief } from "@/domain/brief";

/**
 * One row per launch, one per step. The step table is the recovery log: each step
 * records the id it produced, so a crashed executor replays only the steps without
 * one, reusing their idempotency keys.
 */

export type StepState = "pending" | "running" | "done" | "failed" | "skipped";

export type StepRecord = {
  stepId: string;
  state: StepState;
  /** The id (or file_id) this step produced. */
  output?: Record<string, unknown>;
  error?: { message: string; status?: number; retryable?: boolean };
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
};

export type LaunchState =
  | "compiled" // Plan exists, nothing created.
  | "executing"
  | "created" // All resources exist, everything paused.
  | "activating"
  | "live" // Activated; may still be in review.
  | "partially_created" // Execution stopped mid-way. Needs resume or rollback.
  | "failed";

export type Launch = {
  id: string;
  reference: string;
  state: LaunchState;
  brief: Brief;
  plan: LaunchPlan;
  diagnostics: Diagnostic[];
  steps: Record<string, StepRecord>;
  createdAt: string;
  updatedAt: string;
  /** Activation requested, but the review gates are not clear yet. */
  activationRequested: boolean;
  readinessPolls: number;
};

export type Job = {
  id: string;
  launchId: string;
  kind: "execute" | "activate";
  state: "queued" | "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Mirrors launch.steps for a progress view without a second round trip. */
  progress: Array<{ stepId: string; label: string; state: StepState; id?: string }>;
};

/**
 * Pinned to globalThis, not module scope: each route handler is bundled
 * separately, so a module-level Map is instantiated once per route and a launch
 * written by one route 404s from another.
 *
 * This survives neither a redeploy nor a second instance. It is the one file to
 * replace with Postgres, and the schema above is already relational.
 */
type StoreTables = {
  launches: Map<string, Launch>;
  launchesByReference: Map<string, string>;
  jobs: Map<string, Job>;
};

const globalStore = globalThis as typeof globalThis & { __campaignStore?: StoreTables };

const tables: StoreTables = (globalStore.__campaignStore ??= {
  launches: new Map<string, Launch>(),
  launchesByReference: new Map<string, string>(),
  jobs: new Map<string, Job>(),
});

const { launches, launchesByReference, jobs } = tables;

export const store = {
  putLaunch(launch: Launch): Launch {
    launch.updatedAt = new Date().toISOString();
    launches.set(launch.id, launch);
    launchesByReference.set(launch.reference, launch.id);
    return launch;
  },
  getLaunch(id: string): Launch | undefined {
    return launches.get(id);
  },
  /** Submitting one brief twice returns one launch, not a second campaign. */
  getLaunchByReference(reference: string): Launch | undefined {
    const id = launchesByReference.get(reference);
    return id ? launches.get(id) : undefined;
  },
  listLaunches(): Launch[] {
    return [...launches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  putJob(job: Job): Job {
    jobs.set(job.id, job);
    return job;
  },
  getJob(id: string): Job | undefined {
    return jobs.get(id);
  },
  listJobs(launchId: string): Job[] {
    return [...jobs.values()].filter((j) => j.launchId === launchId);
  },
  reset(): void {
    launches.clear();
    launchesByReference.clear();
    jobs.clear();
  },
};

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
