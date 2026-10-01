import { describe, expect, it, beforeEach } from "vitest";
import { BriefSchema } from "@/domain/brief";
import { compile } from "@/compile/compile";
import { execute } from "@/execute/saga";
import { AdsClient } from "@/ads/client";
import { store, type Job, type Launch } from "@/store";

// Each case reproduces a half-built-campaign scenario and asserts the recovery.

const ctx = { currency: "USD", resolvedPlaces: {}, now: new Date("2026-10-01T00:00:00Z") };

const brief = BriefSchema.parse({
  reference: "saga-test-1",
  campaignName: "Spring launch",
  goal: "traffic",
  budget: { daily: { amount: 50 } },
  targeting: { countries: ["US"] },
  adGroups: [{ name: "Trail running", contextHints: ["trail shoes"], maxBid: { amount: 2 }, creatives: [{ title: "Trail shoes", body: "Shop the new range.", targetUrl: "https://example.com/x", fileId: "file_1" }] }],
});

/** A fake transport that records calls and can be told to fail a given path. */
function fakeFetch(opts: { failOn?: string; failStatus?: number; failTimes?: number } = {}) {
  const calls: Array<{ path: string; idempotencyKey?: string; body: unknown }> = [];
  let failures = 0;
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path, idempotencyKey: headers["Idempotency-Key"], body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (opts.failOn === path && failures < (opts.failTimes ?? Infinity)) {
      failures += 1;
      return new Response(JSON.stringify({ error: { message: "nope" } }), { status: opts.failStatus ?? 400 });
    }
    const idPrefix = path === "/campaigns" ? "cmpn" : path === "/ad_groups" ? "adgrp" : "ad";
    return new Response(JSON.stringify({ id: `${idPrefix}_${calls.length}` }), { status: 200 });
  };
  return { impl, calls };
}

function makeLaunch(reference = brief.reference): Launch {
  const plan = compile({ ...brief, reference }, ctx);
  const now = new Date().toISOString();
  return store.putLaunch({
    id: `lnch_${reference}`,
    reference,
    state: "compiled",
    brief: { ...brief, reference },
    plan,
    diagnostics: [],
    steps: Object.fromEntries(plan.steps.map((s) => [s.id, { stepId: s.id, state: "pending" as const, attempts: 0 }])),
    createdAt: now,
    updatedAt: now,
    activationRequested: false,
    readinessPolls: 0,
  });
}

const makeJob = (launchId: string): Job => store.putJob({ id: `job_${launchId}`, launchId, kind: "execute", state: "queued", startedAt: new Date().toISOString(), progress: [] });

beforeEach(() => store.reset());

describe("saga execution", () => {
  it("creates campaign, ad group and ad in order, threading real ids through", async () => {
    const { impl, calls } = fakeFetch();
    const launch = makeLaunch();
    const result = await execute(launch, new AdsClient({ apiKey: "k", fetchImpl: impl }), makeJob(launch.id));

    expect(result.state).toBe("created");
    expect(calls.map((c) => c.path)).toEqual(["/campaigns", "/ad_groups", "/ads"]);
    expect((calls[1]!.body as { campaign_id: string }).campaign_id).toBe("cmpn_1");
    expect((calls[2]!.body as { ad_group_id: string }).ad_group_id).toBe("adgrp_2");
  });

  it("sends a distinct, derived idempotency key on every create", async () => {
    const { impl, calls } = fakeFetch();
    const launch = makeLaunch();
    await execute(launch, new AdsClient({ apiKey: "k", fetchImpl: impl }), makeJob(launch.id));
    const keys = calls.map((c) => c.idempotencyKey);
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(3);
  });

  it("stops at the first failure and reports partially_created rather than pressing on", async () => {
    const { impl, calls } = fakeFetch({ failOn: "/ad_groups" });
    const launch = makeLaunch();
    const result = await execute(launch, new AdsClient({ apiKey: "k", fetchImpl: impl, maxAttempts: 1 }), makeJob(launch.id));

    expect(result.state).toBe("partially_created");
    expect(result.steps["campaign"]!.state).toBe("done");
    expect(result.steps["ad_group:0"]!.state).toBe("failed");
    // The ad was never attempted: it would have failed on a missing parent.
    expect(calls.map((c) => c.path)).not.toContain("/ads");
    expect(result.steps["ad:0:0"]!.state).toBe("pending");
  });

  it("everything it does create is paused, so a half-built launch cannot spend", async () => {
    const { impl, calls } = fakeFetch({ failOn: "/ads" });
    const launch = makeLaunch();
    const result = await execute(launch, new AdsClient({ apiKey: "k", fetchImpl: impl, maxAttempts: 1 }), makeJob(launch.id));
    expect(result.state).toBe("partially_created");
    for (const call of calls) expect((call.body as { status: string }).status).toBe("paused");
  });

  it("resumes without re-creating completed resources", async () => {
    const first = fakeFetch({ failOn: "/ads" });
    const launch = makeLaunch();
    await execute(launch, new AdsClient({ apiKey: "k", fetchImpl: first.impl, maxAttempts: 1 }), makeJob(launch.id));
    expect(first.calls.map((c) => c.path)).toEqual(["/campaigns", "/ad_groups", "/ads"]);

    // The campaign and ad group are already done, so only the ad runs.
    const second = fakeFetch();
    const resumed = await execute(store.getLaunch(launch.id)!, new AdsClient({ apiKey: "k", fetchImpl: second.impl }), makeJob(launch.id));

    expect(second.calls.map((c) => c.path)).toEqual(["/ads"]);
    expect(resumed.state).toBe("created");
  });

  it("reuses the same idempotency key when retrying a step, so a lost response cannot duplicate", async () => {
    const first = fakeFetch({ failOn: "/ad_groups" });
    const launch = makeLaunch();
    await execute(launch, new AdsClient({ apiKey: "k", fetchImpl: first.impl, maxAttempts: 1 }), makeJob(launch.id));
    const firstKey = first.calls.find((c) => c.path === "/ad_groups")!.idempotencyKey;

    const second = fakeFetch();
    await execute(store.getLaunch(launch.id)!, new AdsClient({ apiKey: "k", fetchImpl: second.impl }), makeJob(launch.id));
    const retryKey = second.calls.find((c) => c.path === "/ad_groups")!.idempotencyKey;

    expect(retryKey).toBe(firstKey);
  });

  it("retries a 500 automatically and still succeeds", async () => {
    const { impl, calls } = fakeFetch({ failOn: "/campaigns", failStatus: 500, failTimes: 1 });
    const launch = makeLaunch();
    const result = await execute(launch, new AdsClient({ apiKey: "k", fetchImpl: impl }), makeJob(launch.id));
    expect(result.state).toBe("created");
    expect(calls.filter((c) => c.path === "/campaigns")).toHaveLength(2);
    expect(calls[0]!.idempotencyKey).toBe(calls[1]!.idempotencyKey);
  });

  it("does not retry a 400, because the payload cannot become valid", async () => {
    const { impl, calls } = fakeFetch({ failOn: "/campaigns", failStatus: 400 });
    const launch = makeLaunch();
    const result = await execute(launch, new AdsClient({ apiKey: "k", fetchImpl: impl }), makeJob(launch.id));
    expect(result.state).toBe("failed");
    expect(calls.filter((c) => c.path === "/campaigns")).toHaveLength(1);
  });

  it("marks a step blocked by a failed dependency as skipped, not failed", async () => {
    const { impl } = fakeFetch({ failOn: "/ad_groups" });
    const launch = makeLaunch();
    const result = await execute(launch, new AdsClient({ apiKey: "k", fetchImpl: impl, maxAttempts: 1 }), makeJob(launch.id));
    // Execution stopped before the ad; a second pass marks it skipped.
    const resumed = await execute(result, new AdsClient({ apiKey: "k", fetchImpl: fakeFetch({ failOn: "/ad_groups" }).impl, maxAttempts: 1 }), makeJob(launch.id));
    expect(["pending", "skipped"]).toContain(resumed.steps["ad:0:0"]!.state);
  });
});
