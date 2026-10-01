"use client";

import { useEffect, useMemo, useState } from "react";
import type { Diagnostic } from "@/domain/diagnostics";
import { CharCount, ChipGroup, Field, Problems, TagInput } from "./_components/fields";
import { AdPreview } from "./_components/preview";

type Goal = "awareness" | "traffic" | "conversions";

type Ad = { title: string; body: string; targetUrl: string; imageUrl: string };

type Form = {
  reference: string;
  campaignName: string;
  goal: Goal;
  dailyBudget: string;
  endAt: string;
  countries: string[];
  platforms: string[];
  adGroupName: string;
  contextHints: string[];
  maxBid: string;
  ads: Ad[];
};

type PlanStep = { id: string; method: string; path: string; label: string; body: unknown };
type Compiled = {
  executable?: boolean;
  plan?: { planHash: string; currency: string; derived: Record<string, unknown>; steps: PlanStep[] };
  diagnostics?: Diagnostic[];
  error?: { code: string; message: string };
};

const GOALS: Array<{ value: Goal; title: string; desc: string }> = [
  { value: "awareness", title: "Get seen", desc: "Show the ad to as many relevant people as possible." },
  { value: "traffic", title: "Get visits", desc: "Send people to your website. Pay per click." },
  { value: "conversions", title: "Get sales", desc: "Optimise for purchases or sign-ups. Needs tracking set up." },
];

const COUNTRIES = [
  { value: "US", label: "United States" },
  { value: "CA", label: "Canada" },
  { value: "GB", label: "United Kingdom" },
  { value: "DE", label: "Germany" },
  { value: "FR", label: "France" },
  { value: "AU", label: "Australia" },
  { value: "IN", label: "India" },
  { value: "JP", label: "Japan" },
];

const PLATFORMS = [
  { value: "web", label: "Web" },
  { value: "ios_app", label: "iPhone app" },
  { value: "android_app", label: "Android app" },
];

const EMPTY_AD: Ad = { title: "", body: "", targetUrl: "", imageUrl: "" };

function buildBrief(form: Form) {
  return {
    reference: form.reference,
    campaignName: form.campaignName,
    goal: form.goal,
    budget: { daily: { amount: Number(form.dailyBudget) || 0 } },
    ...(form.endAt ? { schedule: { endAt: new Date(form.endAt).toISOString() } } : {}),
    targeting: { countries: form.countries, platforms: form.platforms },
    adGroups: [
      {
        name: form.adGroupName,
        contextHints: form.contextHints,
        ...(form.maxBid ? { maxBid: { amount: Number(form.maxBid) } } : {}),
        creatives: form.ads.map((ad) => ({
          title: ad.title,
          body: ad.body,
          ...(ad.targetUrl ? { targetUrl: ad.targetUrl } : {}),
          ...(ad.imageUrl ? { imageUrl: ad.imageUrl } : {}),
        })),
      },
    ],
  };
}

export default function Page() {
  const [form, setForm] = useState<Form>(() => ({
    reference: `launch-${Date.now().toString(36)}`,
    campaignName: "Spring trail launch",
    goal: "traffic",
    dailyBudget: "50",
    endAt: "",
    countries: ["US"],
    platforms: ["web"],
    adGroupName: "Trail running",
    contextHints: ["Trail running shoes for rocky terrain"],
    maxBid: "2",
    ads: [
      {
        title: "Find your next trail shoe",
        body: "Explore shoes made for your next outdoor run.",
        targetUrl: "https://example.com/trail-shoes",
        imageUrl: "",
      },
    ],
  }));

  const [result, setResult] = useState<Compiled | null>(null);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState<{ id: string; state: string } | null>(null);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setAd = (index: number, patch: Partial<Ad>) =>
    setForm((f) => ({ ...f, ads: f.ads.map((ad, i) => (i === index ? { ...ad, ...patch } : ad)) }));

  // Re-check on every edit, debounced. Compile is pure and creates nothing, so
  // there is no cost to running it continuously.
  useEffect(() => {
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/v1/launches?dryRun=1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildBrief(form)),
        });
        setResult(await response.json());
      } catch (cause) {
        setResult({ error: { code: "network", message: cause instanceof Error ? cause.message : String(cause) } });
      } finally {
        setChecking(false);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [form]);

  const diagnostics = useMemo(() => result?.diagnostics ?? [], [result]);
  const at = (path: string) => diagnostics.filter((d) => d.path === path);
  const startsWith = (prefix: string) => diagnostics.filter((d) => d.path.startsWith(prefix));
  const unplaced = diagnostics.filter((d) => d.path === "" || d.path === "/targeting" || d.path === "/schedule");

  const blockers = diagnostics.filter((d) => d.severity === "blocker");
  const warnings = diagnostics.filter((d) => d.severity === "warning");
  const ready = Boolean(result?.executable);

  function applyFix(d: Diagnostic) {
    const value = d.fix?.value;
    if (value === undefined) return;
    const adMatch = d.path.match(/^\/adGroups\/0\/creatives\/(\d+)\/(title|body|targetUrl)$/);
    if (adMatch) {
      setAd(Number(adMatch[1]), { [adMatch[2] as "title"]: String(value) });
      return;
    }
    if (d.path === "/budget/daily/amount") set("dailyBudget", String(value));
    if (d.path === "/campaignName") set("campaignName", String(value));
  }

  async function save() {
    const response = await fetch("/api/v1/launches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBrief(form)),
    });
    const json = await response.json();
    if (json.launch) setSaved({ id: json.launch.id, state: json.launch.state });
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            Campaign Builder<span>OpenAI Advertiser API</span>
          </div>
          <div className="spacer" />
          <span className="status" data-tone={checking ? "idle" : blockers.length ? "bad" : warnings.length ? "warn" : "ok"}>
            <span className="dot" />
            {checking ? "Checking…" : blockers.length ? `${blockers.length} to fix` : warnings.length ? `${warnings.length} to review` : "Ready to launch"}
          </span>
        </div>
      </header>

      <div className="shell">
        <main>
          <section className="card">
            <div className="card-head">
              <span className="num">1</span>
              <div>
                <h2>Campaign</h2>
                <p>What you are running, and how much you will spend.</p>
              </div>
            </div>
            <div className="card-body">
              <Field label="Campaign name" hint="Only you see this. Use something you will recognise later." problems={at("/campaignName")} onFix={applyFix}>
                <input className="control" data-invalid={at("/campaignName").some((d) => d.severity === "blocker")} value={form.campaignName} onChange={(e) => set("campaignName", e.target.value)} placeholder="Spring trail launch" />
              </Field>

              <Field label="What do you want from this campaign?">
                <div className="goals">
                  {GOALS.map((goal) => (
                    <button type="button" key={goal.value} className="goal" aria-pressed={form.goal === goal.value} onClick={() => set("goal", goal.value)}>
                      <span className="g-title">{goal.title}</span>
                      <span className="g-desc">{goal.desc}</span>
                    </button>
                  ))}
                </div>
              </Field>

              <div className="row-2">
                <Field label="Daily budget" hint="The most you will spend per day." problems={at("/budget/daily/amount")} onFix={applyFix}>
                  <div className="affix">
                    <span className="prefix">$</span>
                    <input className="control" data-invalid={at("/budget/daily/amount").some((d) => d.severity === "blocker")} inputMode="decimal" value={form.dailyBudget} onChange={(e) => set("dailyBudget", e.target.value)} placeholder="50" />
                  </div>
                </Field>
                <Field label="End date" hint="Optional. Runs until you pause it otherwise." problems={at("/schedule/endAt")}>
                  <input className="control" type="date" value={form.endAt} onChange={(e) => set("endAt", e.target.value)} />
                </Field>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <span className="num">2</span>
              <div>
                <h2>Audience</h2>
                <p>Where your ad can appear, and on what.</p>
              </div>
            </div>
            <div className="card-body">
              <Field label="Countries" problems={startsWith("/targeting/countries")}>
                <ChipGroup options={COUNTRIES} selected={form.countries} onToggle={(value) => set("countries", form.countries.includes(value) ? form.countries.filter((c) => c !== value) : [...form.countries, value])} />
              </Field>
              <Field label="Devices">
                <ChipGroup options={PLATFORMS} selected={form.platforms} onToggle={(value) => set("platforms", form.platforms.includes(value) ? form.platforms.filter((p) => p !== value) : [...form.platforms, value])} />
              </Field>
              <Field
                label="When should your ad show up?"
                hint="Describe the conversations where your ad belongs. Press Enter after each one."
                problems={at("/adGroups/0/contextHints")}
              >
                <TagInput values={form.contextHints} onChange={(next) => set("contextHints", next)} placeholder="e.g. Trail running shoes for rocky terrain" />
              </Field>
              <div className="row-2">
                <Field label="Ad group name" hint="A label for this set of ads." problems={at("/adGroups/0/name")}>
                  <input className="control" value={form.adGroupName} onChange={(e) => set("adGroupName", e.target.value)} placeholder="Trail running" />
                </Field>
                <Field label="Most you will pay per click" hint="Leave empty to let OpenAI bid for you." problems={at("/adGroups/0/maxBid/amount")}>
                  <div className="affix">
                    <span className="prefix">$</span>
                    <input className="control" inputMode="decimal" value={form.maxBid} onChange={(e) => set("maxBid", e.target.value)} placeholder="Automatic" />
                  </div>
                </Field>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <span className="num">3</span>
              <div>
                <h2>Your ad</h2>
                <p>The headline and text people will see.</p>
              </div>
            </div>
            <div className="card-body">
              {form.ads.map((ad, i) => (
                <div key={i} style={i > 0 ? { marginTop: 22, paddingTop: 22, borderTop: "1px solid var(--line)" } : undefined}>
                  {form.ads.length > 1 ? (
                    <div className="label-row" style={{ marginBottom: 12 }}>
                      <strong style={{ fontSize: 13 }}>Ad {i + 1}</strong>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => set("ads", form.ads.filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    </div>
                  ) : null}

                  <Field label="Headline" problems={at(`/adGroups/0/creatives/${i}/title`)} counter={<CharCount value={ad.title} max={50} />} onFix={applyFix}>
                    <input className="control" data-invalid={at(`/adGroups/0/creatives/${i}/title`).some((d) => d.severity === "blocker")} value={ad.title} onChange={(e) => setAd(i, { title: e.target.value })} placeholder="Find your next trail shoe" />
                  </Field>

                  <Field label="Description" problems={at(`/adGroups/0/creatives/${i}/body`)} counter={<CharCount value={ad.body} max={100} />} onFix={applyFix}>
                    <textarea className="control" data-invalid={at(`/adGroups/0/creatives/${i}/body`).some((d) => d.severity === "blocker")} value={ad.body} onChange={(e) => setAd(i, { body: e.target.value })} placeholder="Explore shoes made for your next outdoor run." />
                  </Field>

                  <div className="row-2">
                    <Field label="Where it links to" problems={at(`/adGroups/0/creatives/${i}/targetUrl`)} onFix={applyFix}>
                      <input className="control" data-invalid={at(`/adGroups/0/creatives/${i}/targetUrl`).some((d) => d.severity === "blocker")} value={ad.targetUrl} onChange={(e) => setAd(i, { targetUrl: e.target.value })} placeholder="https://example.com/trail-shoes" />
                    </Field>
                    <Field label="Image URL" hint="Optional. At least 640×640." problems={at(`/adGroups/0/creatives/${i}`)}>
                      <input className="control" value={ad.imageUrl} onChange={(e) => setAd(i, { imageUrl: e.target.value })} placeholder="https://…/photo.png" />
                    </Field>
                  </div>
                </div>
              ))}

              <button type="button" className="btn btn-sm" style={{ marginTop: 16 }} onClick={() => set("ads", [...form.ads, { ...EMPTY_AD }])}>
                + Add another ad
              </button>
            </div>
          </section>
        </main>

        <aside className="rail">
          <section className="card">
            <div className="card-head">
              <h2>Preview</h2>
            </div>
            <div className="card-body">
              <AdPreview title={form.ads[0]?.title ?? ""} body={form.ads[0]?.body ?? ""} targetUrl={form.ads[0]?.targetUrl ?? ""} imageUrl={form.ads[0]?.imageUrl ?? ""} advertiser="" />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Checks</h2>
            </div>
            <div className="card-body">
              {unplaced.length ? <Problems items={unplaced} /> : null}
              {diagnostics.length === 0 && !checking ? (
                <p className="empty">Everything looks good.</p>
              ) : (
                <div className="checklist">
                  {diagnostics.map((d, i) => (
                    <div className="check" data-sev={d.severity} key={`${d.code}-${i}`}>
                      <span className="ico">{d.severity === "blocker" ? "✕" : d.severity === "warning" ? "!" : "i"}</span>
                      <span>
                        {d.message}
                        {d.path ? <span className="where">{d.path.replace("/adGroups/0/creatives/", "ad ").replace(/^\//, "")}</span> : null}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Summary</h2>
            </div>
            <div className="card-body">
              <dl className="kv">
                <dt>Daily spend</dt>
                <dd>${Number(form.dailyBudget || 0).toFixed(2)}</dd>
                <dt>Countries</dt>
                <dd>{form.countries.length || "—"}</dd>
                <dt>Ads</dt>
                <dd>{form.ads.length}</dd>
                <dt>API calls</dt>
                <dd>{result?.plan?.steps.length ?? "—"}</dd>
              </dl>
              <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
                <button className="btn btn-primary" disabled={!ready} onClick={save} title={ready ? "Saves the launch, still creating nothing" : "Fix the blocking problems first"}>
                  Save launch
                </button>
              </div>
              {saved ? (
                <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
                  Saved as <code>{saved.id}</code> ({saved.state}). Nothing has been created in your ad account.
                </p>
              ) : null}
            </div>

            <details className="disclose">
              <summary>What gets sent to OpenAI</summary>
              <div className="disclose-body">
                {result?.plan?.steps.length ? (
                  result.plan.steps.map((step) => (
                    <div className="callblock" key={step.id}>
                      <header>
                        <span className="lbl">{step.label}</span>
                        <span className="verb">
                          {step.method} {step.path}
                        </span>
                      </header>
                      <pre>{JSON.stringify(step.body, null, 2)}</pre>
                    </div>
                  ))
                ) : (
                  <p className="empty">Nothing to show yet.</p>
                )}
              </div>
            </details>
          </section>
        </aside>
      </div>
    </>
  );
}
