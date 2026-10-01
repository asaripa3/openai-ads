import { describe, expect, it } from "vitest";
import { assessReadiness, triage } from "@/reconcile/servingIssues";

describe("serving issue triage", () => {
  it("treats a creative still in review as a wait, not an error", () => {
    const meta = triage("ad_in_review");
    expect(meta.verdict).toBe("wait");
    expect(meta.owner).toBe("platform");
  });

  it("routes a failed threshold payment to billing as a blocker", () => {
    expect(triage("ad_account_threshold_payment_failed")).toMatchObject({ owner: "billing", verdict: "escalate", severity: "blocker" });
  });

  it("blames this service, not the advertiser, when a resource was left paused", () => {
    expect(triage("campaign_not_active").owner).toBe("us");
    expect(triage("ad_group_has_no_ads").owner).toBe("us");
  });

  it("escalates unknown codes instead of swallowing them", () => {
    expect(triage("some_code_shipped_last_tuesday")).toMatchObject({ owner: "us", verdict: "escalate" });
  });

  it("reports waiting-on-platform when review is the only thing outstanding", () => {
    const r = assessReadiness([{ code: "ad_in_review", level: "ad", id: "ad_1" }]);
    expect(r.serving).toBe(false);
    expect(r.waitingOnPlatform).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it("reports serving when there are no issues at all", () => {
    const r = assessReadiness([]);
    expect(r.serving).toBe(true);
    expect(r.retryAfterSec).toBeNull();
  });

  it("stops suggesting a poll once only hard blockers remain", () => {
    const r = assessReadiness([{ code: "ad_account_suspended", level: "campaign", id: "cmpn_1" }]);
    expect(r.blockers).toHaveLength(1);
    expect(r.retryAfterSec).toBeNull();
  });

  it("backs off exponentially across polls and caps at fifteen minutes", () => {
    const issues = [{ code: "ad_in_review" as const, level: "ad" as const, id: "ad_1" }];
    expect(assessReadiness(issues, 0).retryAfterSec).toBe(30);
    expect(assessReadiness(issues, 2).retryAfterSec).toBe(120);
    expect(assessReadiness(issues, 99).retryAfterSec).toBe(900);
  });
});
