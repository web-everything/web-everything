# Model routing strategy — preserve frontier capacity for hard work

2026-09-30. Recommendation: **script deterministic work, qualify Flash-class workers for bounded execution, and compare open-weight candidates on total accepted-task cost before promoting them.** Keep design, critical work and difficult checking on frontier models. The largest observed opportunity is reducing orchestration context, not merely changing the model that writes a patch.

This is research and a proposal, not a routing change. Prepared decision: “Validate cheaper model routes by total frontier cost and escaped defects” (the card links this report through its relatedReport field).

## Evidence and limits

The operator reports that Google has announced Gemini 4, that it beats Astra 6 and Opus 5.5 on many benchmarks, and that it is not available to us yet. This report does not independently endorse those claims. Gemini 4 is a future frontier candidate, not an available cheap worker.

Repository observations below refer to checkout `687731ec899232739f800c482543c1224a53b581`. External model prices, availability, speed, quality, licences and privacy terms not established here are **to verify**. Model strings in code and logs establish local configuration or recorded use, not vendor-wide product facts.

Read-only sources: the shared scorecard store resolved by `we:scripts/conveyor/run-scorecard-store.mjs:74` to the home-directory Claude daemon state (daemon-self-sync-state → conveyor-state → .conveyor → run-scorecards JSON); the local run-rating report; and `~/workspace/.operations` telemetry and trial notes. No subscriptions, models or runners were changed.

## Where frontier tokens go

The read-only command `node we:scripts/conveyor/run-rating.mjs report --since=2026-09-27T00:00:00Z --json`, run September 30, returned this coverage view:

| Observed bucket | Tokens, including cache traffic | Share |
|---|---:|---:|
| Orchestrator plus its spawned subagents | 15,130,666,337 | 85.61% |
| Delivery and review attributed to a demand | 1,529,901,821 | 8.66% |
| Other interactive sessions | 946,234,277 | 5.35% |
| Non-Claude judges | 67,559,882 | 0.38% |
| Total observed | 17,674,362,317 | 100% |

The report scanned 291 dispatched-daemon, 201 orchestration and 117 interactive files, 2,073 review run records and 583 non-Claude judge transcripts; it reported zero unreadable/unattributed files. **That is not complete fleet accounting:** direct-task logs can be overwritten, non-Claude usage can be missing, and orchestration subagents cannot currently be reliably attributed to individual cards. See `we:scripts/conveyor/run-rating.mjs:1385` and `:1634`. These are the tool's categories, not a measured split of simple versus complex work. The report's dollar estimates are usage equivalents, not invoices or remaining subscription allowance.

A separate frozen scorecard snapshot contains **4,346 rows**, dated September 15 through September 30 21:50:55 UTC. SHA-256: `643681fb68f7f45c146714bb24c0a6001f2f86745f0230778b94b33aa5518069`. Of 1,213 rows carrying a tokens field, only **691 contain a token object**. Across those objects:

| Recorded kind | Rows | Uncached input | Output | Cache read + write | Recorded cost estimate |
|---|---:|---:|---:|---:|---:|
| Review | 436 | 44,182,300 | 17,272,545 | 491,049,341 | $338.63, all partial |
| Fix | 100 | 9,648 | 2,957,904 | 452,475,604 | $436.31 |
| CI heal | 151 | 8,956 | 1,748,749 | 320,805,722 | $317.42 |
| Conveyor | 4 | 152 | 51,568 | 5,706,012 | $8.66 |

Method: select rows whose `tokens` is an object; group by `dispatchKind`; sum `in`, `out`, `cacheRead`, `cacheWrite` separately. Null tokens/costs are unknown, never zero-cost runs. These are **row sums across rating versions and rounds**, not a second fleet total to add to coverage. They span 421 handles; 691 `(handle, scoredAt, rubricVersion)` tuples are distinct, but cumulative rerating overlap is not ruled out. Use them to identify investigative targets, not claim dollar savings. Cache reads dominate; raw tokens are not equivalent to new generation or quota consumption.

The explicit model tag is `claude-opus-5-5` on 247 token-bearing rows; 444 say `unknown`. **687 of 691 lack an item ID**, so there is no defensible ranking by story size. Four size-1 conveyor rows account for the remaining $8.66 estimate; they cannot establish that small cards are cheap. The current-rubric report returned 388 rows and no prepared sample versus 154 unprepared records; it cannot establish a causal preparation benefit. Repair item/step attribution before reporting tokens per story point.

### What already runs elsewhere

The same snapshot separates execution from review:

- **Codex/Astra session delegations:** bugfix 8 landed, 2 reworked; doc-fix 3 landed; conflict-resolution 2 landed; self-fix 1 landed; `other` 9 landed, 1 reworked. The broad `other` bucket cannot qualify a new task class.
- **Antigravity session delegations:** Flash-low conflict-resolution 10 landed; Gemini `3.8` and `3.1-pro` in `other` total 3 landed; Sonnet 4.6 in `other` 2 rejected. Those records do not prove Flash-high can fix arbitrary tests.
- **21 probation launches:** Codex prepare 11, Codex bugfix 5, agy-Claude bugfix 3, Flash-high test-fix 2. All lack a final `outcome`. The test-fix launches record one opened PR and one gate-red with an unreadable Codex checker. The opened-PR row records 210 LOC, exceeding the current 150-LOC envelope: investigate the launcher/accounting seam before treating that as a qualified success.
- **Review-seat rows:** Codex 569/570 `ok`; agy-Gemini 392/411; direct Gemini 60/61; agy-Claude 48/194 (139 errors, 2 quota-exhausted, 5 unparseable). These are seat-row transport/parsing outcomes, **not correctness rates**. Multiple lenses share a call: unique call counts are respectively 360, 309, 42 and 157. Confirmed-finding rows are 109, 33, 7 and 10; neither this nor verdict agreement measures escaped defects.

No open-weight delivery trials were found in these records. The September 19 trial audit in the workspace operations job note named “log-delegation-trials.result” (Markdown) refused to log unsupported Gemini claims and corrected author attribution. Follow that standard: a claimed run is not a trial. The local usage-ledger command failed with `Maximum call stack size exceeded`; no live allowance or invoice conclusion is drawn from it.

## Today's routing map

| Layer | Observed behavior | Implication |
|---|---|---|
| Mechanical worker tier | `workerTierFor` defaults Sonnet; decision preparation, statute, security and explicit high risk raise to Opus; no Haiku output | File count alone does not make judgment cheap |
| Provider fitness | Gemini/agy, then Codex, then conditional dual route, then Claude; each fitness result is audited | This is eligibility order, not a price optimizer |
| Critical boundary | Unknown scope, policy/gate/security/irreversible work fail closed; critical-miss records veto exact identities | A small gate edit remains critical |
| Noncritical probation | Prepare, bugfix, doc-fix, CI heal, test-fix and Codex-only build-new-feature open; conflict-resolution remains closed in gated dispatch | Historical successes do not override today's admission switch |
| Simple Flash work | `gemini-3.8-flash-high`; simple-only except test-fix; Codex checker; full review | Checker failure is failure to accept, not permission to skip it |
| Review seats | Risk-tiered mandatory agy seats proposed in #4374, low-care Sonnet MVP; elevated Opus later, high native Claude | Keep authority separate from advisory trial success |

Concrete sources: `we:scripts/lib/provider-routing.mjs:268`, `:356`, `:395`, `:450`, `:760`; `we:scripts/lib/critical-work.mjs`; `we:scripts/lib/dispatch-contracts.mjs:451`. `routeDispatch` derives criticality, preserves `gemini-fitness` and `codex-fitness`, recovers a model that reproduces the recommendation, and applies supervision separately. A probation worker can sit beside a Claude fallback recommendation; reading only `recommendation` would misdescribe execution.

Aliases are not immutable identities: `we:scripts/lib/dispatch-contracts.mjs:528` currently maps Sonnet to `claude-sonnet-5-5` and Opus to `claude-opus-5`; `we:scripts/lib/codex-model-routing.mjs:82` pins `gpt-6-astra`. Agy's configured Claude identities are Sonnet/Opus 4.6, with a catalog-check note dated September 27. Record the actual resolved model, backend and effort on each run. Current external alias resolution is **to verify**.

Reference reconciliation: #2732 is the routing **PR** (`f7048a54c`, #4208/#3906); #3021 is the test-fix **PR** (`8e3096413`, card #4551); #2811 is the run-rating **PR** (`edcdf6e32`, epic #4075). Their same-number backlog files are unrelated. #3857 supplies the worker table. Local and remote-tracking refs contain no `lane/model-routing`; its in-flight contents are **to verify**, not assumed absent upstream. Do not create a competing policy file.

## Difficulty and risk are separate

The following are proposed cheapest safe **qualification targets**, not declarations of trust. Use the existing task types and care dial; derive type from cause and scope. Size is a bound, not evidence of simplicity.

| Task | Difficulty / risk | Cheapest target and acceptance bar |
|---|---|---|
| Formatting, inventories, known field migrations, counting | Deterministic / low unless policy data | Existing script, schema and diff check; no model |
| Reader-facing typo, supplied card metadata, extraction | Low / low | Script if exact; otherwise bounded Flash or open-weight draft, independent factual/diff check |
| Simple code edit from accepted design | Low / low–medium | Flash-class after exact-class trials; explicit tests and scope; frontier fallback |
| Test-only repair | Bounded / medium | Existing Flash + Codex route, 150 LOC/3 files; preserve assertions; production bug or mixed diff leaves this route |
| Test design, flaky concurrency diagnosis | Medium–high / medium–high | Capable frontier worker; cheap model may transcribe an already-decided case |
| Docs/cards stating new policy or acceptance rules | High judgment / elevated–high | Frontier; prose is not automatically low-risk |
| Prepare evidence gathering | Bounded retrieval / low | Scripts or cheap extraction; check citations and missing evidence |
| Prepare forks, architecture or critical code | High / high | Frontier reasoning and independent review; retain current native-Claude restrictions |
| Review, none/low care | Bounded / low | Qualified cheap advisory seat; mandatory-seat changes only through #4374 and own probation |
| Review, elevated care | Medium–high / elevated | Qualified Sonnet-class/agy-Opus target subject to #4374; do not substitute an unqualified cheap judge |
| Review, high/security/gate-self | High / high | Existing native frontier authority and independent seats |

Existing doc-fix envelope is 100 LOC/2 files; bugfix 250/4; build-new-feature 300/3; prepare 1,000/1. These are ceilings in `we:scripts/lib/provider-routing.mjs`, not promises of competence. A scope or requirement change triggers reclassification.

## Tiers and economics

| Tier | Cost and speed | Quality/tools | Setup, operations and data |
|---|---|---|---|
| Scripts | No inference tokens; execution cost remains | Exact for specified transforms; cannot resolve ambiguity | Maintain fixtures and idempotence; local execution avoids model disclosure |
| Frontier subscriptions: Claude, Codex/Astra, future Gemini 4 | Already-paid capacity has opportunity cost; model-specific quotas and throughput **to verify** | Existing Claude/Codex tools and trials; Gemini 4 capability here **to verify** | Existing runners; external processing terms **to verify** |
| Flash-class hosted | Marginal API price, or separate subscription allowance, **to verify**; do not equate agy with a cheap API | Narrow local successes and current test-fix route; broader competence **to verify** | Smaller initial change using existing runner; hosted retention and limits **to verify** |
| Open weights on hosted API | Price, latency and concurrency **to verify** against a fixed model/version | Tool parser, structured outputs, patch fidelity and agent loop **to verify** | New adapter/credentials/accounting; host controls retention; weights being open says nothing about API privacy |
| Open weights on this Mac | No per-token vendor invoice for fully local inference; electricity, hardware time and maintenance remain; speed **to verify** | Same qualification suite; quantization/context effects **to verify** | Runtime, downloads, licence, updates, memory and contention burden; privacy requires local tools/logging too |

A concrete **to verify** candidate is Qwen3-Coder-30B-A3B-Instruct, first as a hosted replay candidate and then a local quantized trial if memory permits. The [publisher's model card](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct) and [official repository](https://github.com/QwenLM/Qwen3-Coder) are external leads, not repo-verified claims; the latter documents a model-specific tool parser. Test that parser end to end rather than assuming an API-compatible URL makes an agent compatible. Avoid a speculative price leaderboard.

For local inference, MLX is an external **to verify** runtime lead; [its documentation](https://ml-explore.github.io/mlx/build/html/usage/unified_memory.html) describes Apple unified memory. A 30-billion-parameter model at four bits needs roughly **15 GB for raw weights alone** (arithmetic, excluding metadata, cache and runtime), regardless of how many parameters activate per token. This is not a measured fit claim. This session observed `arm64`; the memory/model `sysctl` probe was denied, so RAM, chip and free headroom remain **to verify**. No download or benchmark was run.

Host contention is real evidence: the September 29 rollup at the workspace operations telemetry file named “2026-09-29.rollup” (JSON) reports the host core count, 4,677 samples, load p50 16.28 and p90 31.28. Load is not GPU utilization or proof inference will be slow. It is reason to measure build/test latency while running one local worker before increasing concurrency.

The on-device economics memory points to `we:docs/agent/platform-decisions.md#monetization`: flat-priced product features must not acquire uncapped external per-call costs. Its scope is product margin, not a blanket prohibition on development APIs. Use a capped hosted development bridge; keep provider swaps, the evaluation corpus and recipes portable. See `we:agent-memory-src/index-monetization.md` and `we:agent-memory-src/4-project_linear_cost_revenue_on_device.md`.

## Recommended routing and fallbacks

1. **Remove model work first.** Run existing declared operations directly for counting, validation, known transforms and status transitions. Give workers scoped excerpts, an accepted target and an executable acceptance check. Avoid re-sending whole histories and using a frontier agent to narrate deterministic orchestration.
2. **Admit by evidence.** Require known scope, bounded size, testable acceptance, no critical proxy, and permitted data handling. Derive task type; never let a worker self-label its task simple. Candidate identity includes provider, actual model/version, backend, role/subject and task class. A model upgrade starts fresh evidence; a changed quantization or tool harness gets a separately identifiable trial cohort.
3. **Keep checking costs visible.** In probation, independently inspect every diff and run its real acceptance checks. Preserve review authority, scopes and permissions. For test repairs, inspect assertion strength, skipped cases and coverage, not just green status. A checker with no answer cannot accept. Advisory findings need confirmation before counting as misses.
4. **Reuse graduation, do not invent another trust system.** `we:scripts/lib/model-probation.mjs:257` requires 20 verified trials, one informative trial, zero critical misses and rating no worse than Claude to become eligible for explicit human promotion. That is distinct from supervision thresholds: low/medium/high currently 2/5/8 clean trials, with positive-control rules and placeholder sampling of 50%/25%/100% in `we:scripts/lib/dispatch-thresholds.mjs`. Meeting a numeric streak alone grants neither authority nor promotion.
5. **Preserve the statute's miss handling.** `we:docs/agent/platform-decisions.md#delegation-trial-record-graduation` governs attribution, tooling fixes, critical/unfixable misses and explicit restoration. Do not flatten its amended rule into “every miss permanently bans a model.” Current `critical-work` and fitness vetoes still apply; reconcile any statute/code mismatch before changing a route. The independent look never disappears.
6. **Availability is not qualification.** A declared chain tries only candidates qualified for that same scope, role, data policy and checker requirement: script → qualified cheap candidate → another eligible backend → permitted frontier fallback → queue/hold. An unavailable checker may require holding even when the worker is available. Bound attempts to one cheap attempt before escalation during the pilot; timeout/tool/schema/scope failures are logged, not silently retried forever. Zero allowance must not lower the care bar.

Allowance checking and chains belong with #4377; risk-tiered review belongs with #4374. Consolidate values into the in-flight one-policy effort after reading its actual diff, preserving routing audit reasons and policy version. #4305 and #4376 (`bornAs: xv0h3mp`) already treat model routing, probation, testing and delivery rigor as composable configuration dimensions. This proposal selects no universal vendor and creates no new WE standard or runtime.

Gemini 4 joins the **frontier candidate pool when actually available**: verify identity, entitlement, tool/sandbox behavior and scoped trials; start at full checking. Benchmarks can justify a trial, not transfer Flash trust or remove the current critical-work restrictions. A healthier Gemini subscription can relieve complex-work pressure without making simple work consume another frontier budget.

## Staged qualification

- **Stage 0 — attribution and baseline.** Join worker, planner, checker and reviewer calls to one demand/step/attempt. Preserve missing values. Confirm actual allowance, alias resolution and policy branch. Sample simple cases from the large orchestration bucket as well as fixes/reviews.
- **Stage 1 — deterministic and text work.** Use existing scripts; collect a small paired corpus of reader-facing corrections and supplied-data card drafts. Replay one Flash-class and one hosted open-weight candidate under a capped budget, with no autonomous land or gate changes. No frontier planner call for a scriptable one-step job.
- **Stage 2 — existing simple execution.** Extend measurement of the current test-fix route; investigate the 210-LOC launch and unreadable checker first. Then trial accepted-design edits within their envelopes. Cheap evidence extraction may assist preparation; it does not prepare or ratify forks itself.
- **Stage 3 — compare local and hosted.** Once host capacity is measured, replay the same cases locally, one worker at a time, alongside a build-latency control. Include cold load, prompt processing, tool latency, peak memory, swap and setup time. Keep the hosted bridge if local fails the benchmark; re-benchmark monthly.
- **Stage 4 — qualified expansion.** Present exact-class promotion evidence to the operator. Review-seat changes follow their own authority gate. Use #3922's planner/checker separation and step routing as it becomes exercised; do not wait for all G2 work to collect bounded trials.

The planner is settled in `we:docs/agent/platform-decisions.md#planner-build-plan-and-execute`: code runs typed steps; scripts or cheapest capable models execute; the checker is separate; heavy checks are not multiplied. Related #3575 explores splitting and coordination. #3996/#3997 cover derived inputs and capped exploration; #4001/#4003/#4004/#4008 cover lanes, roles, shadow and execution; #4006/#4007 expose steps; #4009 pairs baselines; #4010/#4011 cover general probation and its metrics. Those cards are open in this checkout: a ratified design is not evidence the full runner is live. #3998–#4000, #4002 and #4005 are adjacent daemon/lane/test work, not additional model choices.

## What would prove savings

Pre-register all assigned tasks, stratified by task class, care, actual diff size and preparation state. Freeze matched inputs and acceptance checks before either arm runs. Include failed, held, timed-out and abandoned attempts plus frontier fallback in cohort costs; show completion rate as well as accepted-task cost. Never drop failed cheap attempts from the denominator. Preserve provider-specific input/output/cache tokens; do not combine them into a fictional common quota. Track allowance change separately where an actual gauge exists.

**Net frontier saving = baseline frontier usage − (planner + worker + checker + review + retries + fallback + later repair frontier usage).** Show each lab separately, plus dollar API spend, amortized local setup/energy, human minutes and p50/p95 time to acceptance. Already-paid subscription capacity saved is not a cash refund. A cheap worker that forces a full frontier rewrite loses this comparison.

A proposed promotion dossier adds a paired comparison to the existing 20-trial eligibility bar: at least 20 matched, independently judged tasks per candidate/class, including a positive control; **at least 25% median net frontier reduction and lower total cohort frontier use**, no worse accepted-task p95 than 1.25× baseline, and no critical escape. These are proposed pilot budget/latency settings, not new graduation law. The dossier supplements the delivery bar: paired runs and a seeded defect do not automatically count as its independently verified trials or its explicitly recorded `informative: true` event. Require the existing comparative Claude rating and verify record eligibility separately. Report distributions, sample sizes and uncertainty; 0/20 escapes still has an approximate 95% upper bound of 15%, so it is a review trigger, not a safety guarantee.

Define escape rate as confirmed defects found **after the worker's acceptance check** divided by independently followed-up accepted tasks, with severity and observation window (proposed seven days). Apply the same follow-up window to both arms; immature observations remain pending, not clean. Track pre-accept rework separately, plus false-positive judge findings, missing checker answers, tool/schema failures, scope violations and quota outages. No existing `escape rate` series was found by the repository search; do not substitute landed rate or mechanical A grades.

Reuse #4075 and slices #4298 (weekly report), #4299 (cross-model judgment), #4300 (rating sample), #4301 (preventable causes), #4304 (prepared state). #4302/#4303 concern no-draft defaults and trusted scratch directories, not additional rating dimensions. Include all checker and sampling costs; add no parallel dashboard or trust database. Mechanical routing governs mechanical dispatch only; interactive orchestration retains its inline routing judgment. Context reduction there is a separate measured intervention, not an automatic extension of dispatch authority.

The next decision is whether the cheaper-route candidate is safe and beneficial enough for a bounded qualification pilot—not whether local and hosted models are allowed to coexist.
