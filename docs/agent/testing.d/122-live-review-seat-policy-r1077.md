## Live review seat policy (R1077)

`review-seat-caps.test.mjs` covers live `review.seatDailyCaps` reads through the shared
policy cascade, injected settings IO, invalid layers and legacy environment precedence.
`review-red-team.test.mjs` exercises the launcher with both builder companies, unknown
builder evidence, `review.redTeam.routeByBuilder=false`, daily-cap fallback and a raced
reservation. Keep the pinned-head co-author read ahead of routing; the scratch checkout
is created only after provider selection. Standard daily caps are Codex 80 (the tool
settings explicitly raise it to 600), agy-gemini 0
(off; operator opt-in through `review.seatDailyCaps.agy-gemini` or `enabledProviders`), agy-claude 10 (red-team emergency only). Codex builders prefer agy-gemini;
if disabled or capped, use Codex and log same-vendor acceptance. Claude builders prefer
Codex, then agy-gemini at cap. Unknown builders and `routeByBuilder=false` retain policy
routing among the ordinary providers. Log each cap fallback, including reservation races.
Never choose agy-claude by default: only exhaustion of both ordinary providers' budgets
permits the logged emergency route. Exhausting even the emergency budget retains the
existing cap hold. Tests cover emergency selection, all budgets exhausted, and missing
CLIs with ordinary budget left (no emergency).

Pin historical cap-warning fixtures to their original cap. Provider-unavailable fixtures
need explicit positive provider budgets: cap checks precede CLI probes, and a zero cap
marks the result retryable rather than a completed unavailable-CLI result.
Red-team routing fakes inject `readSeatSettings` with empty tool/platform layers when
asserting standard caps, so live settings cannot change their budgets. Keep cap source
labels aligned with the settings cascade and assert the final skipped log contains the
returned budget refusal, while retaining reservation-count and no-launch assertions.

R1077 audit: builder preference stays within the resolved policy chain or inherited
red-team roster; operator routing overrides win, and policy model/effort validation
still runs. Exhausting an explicit chain refuses dispatch rather than inventing a
route. `ai-routing-red-team-sites.test.mjs` retains the cap/quota refusal cases and
covers builder policy models, efforts, operator precedence and disabled fallbacks.
Explicit settings zero defeats `enabledProviders`; unreadable or malformed seat
settings warn and use repo defaults, including Gemini's disabled default.

Red-team admission checks the resolved model against the same Carbon promotion guard
as execution before reserving budget. A positive Gemini cap alone does not promote
Carbon: builder, policy and AI-overlay routes retry the remaining allowed providers.
Keep fixtures for unpromoted fallback, promoted Carbon, non-Carbon Gemini aliases and
an operator chain with no permitted fallback. Historical budget-race fixtures must
explicitly promote Carbon so they continue exercising reservation denial.
