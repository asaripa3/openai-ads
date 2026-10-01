#!/usr/bin/env bash
# End-to-end exercise of the compile path against a running dev server.
# No API key needed: compile and validate are pure, so this proves the whole
# input -> output pipeline without creating anything or spending anything.
set -uo pipefail
BASE="${BASE:-http://localhost:3000}"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
post() { curl -sS -X POST "$BASE$1" -H 'Content-Type: application/json' -d "$2"; }

say "1. A clean brief compiles to a plan of exact API calls"
post '/api/v1/launches?dryRun=1' '{
  "reference": "smoke-clean-1",
  "campaignName": "Spring trail launch",
  "goal": "traffic",
  "budget": { "daily": { "amount": 50 } },
  "targeting": { "countries": ["US"], "platforms": ["web", "ios_app"] },
  "adGroups": [{
    "name": "Trail running",
    "contextHints": ["Trail running shoes for rocky terrain"],
    "maxBid": { "amount": 2 },
    "creatives": [{
      "title": "Find your next trail shoe",
      "body": "Explore shoes made for your next outdoor run.",
      "targetUrl": "https://example.com/trail-shoes",
      "imageUrl": "https://example.com/shoe.png"
    }]
  }]
}' | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log("  executable:", r.executable, "| plan hash:", r.plan?.planHash);
console.log("  derived:", JSON.stringify(r.plan?.derived));
for (const s of r.plan?.steps ?? []) console.log(`  ${s.method} ${s.path}  ${s.label}`);
for (const d of r.diagnostics ?? []) console.log(`  [${d.severity}] ${d.code} ${d.path}`);
'

say "2. A broken brief returns actionable diagnostics, not a 500"
post '/api/v1/launches?dryRun=1' '{
  "reference": "smoke-broken-1",
  "campaignName": "x",
  "goal": "conversions",
  "budget": { "daily": { "amount": 0.5 } },
  "targeting": { "countries": ["United States"], "excludeCountries": ["US"] },
  "adGroups": [{
    "name": "Group one",
    "contextHints": [],
    "billingEvent": "impression",
    "maxBid": { "amount": 2 },
    "creatives": [{
      "title": "Guaranteed results for your next trail running adventure today",
      "body": "This body copy is deliberately far too long for the hundred character limit the Advertiser API enforces on creative bodies.",
      "targetUrl": "http://localhost:3000/x?gclid=abc"
    }]
  }]
}' | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log("  executable:", r.executable);
for (const d of r.diagnostics ?? []) {
  console.log(`  [${d.severity}] ${d.code} ${d.path}`);
  console.log(`      ${d.message}`);
  if (d.fix) console.log(`      fix: ${d.fix.summary}`);
}
'

say "3. Saving a launch twice with one reference yields one launch, not two campaigns"
BRIEF='{
  "reference": "smoke-idem-1",
  "campaignName": "Idempotency check",
  "goal": "awareness",
  "budget": { "daily": { "amount": 25 } },
  "targeting": { "countries": ["US"] },
  "adGroups": [{ "name": "Broad reach", "contextHints": ["outdoor running"], "creatives": [{ "title": "Trail season is here", "body": "Gear up.", "targetUrl": "https://example.com" }] }]
}'
A=$(post '/api/v1/launches' "$BRIEF" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(r.launch?.id ?? r.error?.code)')
B=$(post '/api/v1/launches' "$BRIEF" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(r.launch?.id ?? r.error?.code)')
echo "  first:  $A"
echo "  second: $B"
[ "$A" = "$B" ] && echo "  -> same launch reused" || echo "  -> MISMATCH"

say "4. Execution without a configured API key fails closed"
post "/api/v1/launches/$A/execute" '{}' | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log("  ", r.error?.code ?? "unexpected success", "-", (r.error?.message ?? "").slice(0, 90));
'

say "Done."
