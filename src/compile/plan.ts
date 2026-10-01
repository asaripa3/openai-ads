import { createHash } from "node:crypto";

/**
 * The compiled artifact: the exact sequence of API calls, as data rather than
 * code. Being plain JSON means a plan can be returned from a dry run, diffed
 * against the last one, and hashed so execution can refuse a stale plan.
 *
 * Ids are unknown at compile time, so bodies carry `{ $ref: "<stepId>.<field>" }`
 * placeholders that the executor fills from completed steps.
 */

export type StepKind = "upload_image" | "create_campaign" | "create_ad_group" | "create_ad";

export type Ref = { $ref: string };

export function ref(stepId: string, field: string): Ref {
  return { $ref: `${stepId}.${field}` };
}

export function isRef(value: unknown): value is Ref {
  return typeof value === "object" && value !== null && typeof (value as Ref).$ref === "string";
}

export type PlanStep = {
  /** Derived from position, which is what makes the idempotency key stable. */
  id: string;
  kind: StepKind;
  method: "POST";
  path: string;
  /** Human label for progress UI. */
  label: string;
  /** JSON body with $ref placeholders, or a multipart descriptor for uploads. */
  body: unknown;
  dependsOn: string[];
  /** Derived, never random, so a retried create cannot become two campaigns. */
  idempotencyKey: string;
};

export type LaunchPlan = {
  reference: string;
  currency: string;
  goal: string;
  /** The five derived platform fields, surfaced so the UI can explain itself. */
  derived: Record<string, unknown>;
  steps: PlanStep[];
  /**
   * Bottom-up: ad, ad group, campaign. An active parent with no serving-ready
   * child reports campaign_has_no_serving_ready_ad_groups and spends nothing.
   */
  activationOrder: Array<{ stepId: string; path: (id: string) => string }>;
  planHash: string;
};

/** Sorted keys, so the hash ignores property order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function hashPlan(steps: PlanStep[], extra: unknown = null): string {
  return createHash("sha256").update(canonicalize({ steps, extra })).digest("hex").slice(0, 32);
}

/**
 * Stable per (reference, resource) and distinct across resources. Hashing those
 * two inputs also survives a process restart, which a random UUID in memory does
 * not — and a restart mid-launch is exactly when duplicates appear.
 */
export function deriveIdempotencyKey(reference: string, stepId: string): string {
  return createHash("sha256").update(`${reference}\u0000${stepId}`).digest("hex").slice(0, 40);
}
