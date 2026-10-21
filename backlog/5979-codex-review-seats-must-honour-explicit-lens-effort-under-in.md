---
bornAs: x3mdu9q
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/__tests__/review-extra-seats.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Codex review seats must honour explicit lens effort under inherited provider routing

An inherited provider route can select Codex while losing the lens effort. Resolve the explicit lens effort against the selected Codex model before dispatch, and expose the effective effort in route logging. Preserve the review default when no lens effort is configured.

## Acceptance

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/review-extra-seats.test.mjs` — add `inherited Codex routing honours explicit lens effort`: select Codex with an inherited route and a supported non-default lens effort; assert the route and dispatched judge arguments retain that effort. This must fail on the current default-only branch.
- [A2] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/review-extra-seats.test.mjs` — add cases for absent effort (review default), explicit provider routing (unchanged), and unsupported model/effort pairs (no judge spawned, visible diagnostic). Capture the dispatch log and assert the effective lens, model and effort are reported.

## Non-goals

- [N1] No provider-selection, budget, model-default or non-Codex effort-policy changes.

## Edge cases this change must handle

1. **Untrusted text** — Policy effort is validated data, never executable text; an unknown effort must not reach a judge command.
2. **Truncated reads** — n/a: this change consumes an already parsed routing policy, not a stream or transcript.
3. **Shared state files** — Do not mutate the shared policy or model defaults while resolving a seat.
4. **Fail closed** — An unsupported model/effort pair refuses dispatch with a diagnostic; never silently substitute the default.
5. **Identity scoping** — Apply the effort to the specific seat key and selected provider, without leaking it to other lenses.
6. **State over time** — Resolve each call; removing an explicit effort restores the current review default.
7. **Who wrote it** — Log the effective seat route; this change does not interpret model-authored verdicts. No receive endpoint is added, so HTTP body caps, rate limits and CSRF checks are inapplicable.

## Grounding

- we:scripts/operations/review-dispatch.mjs:257 passes only configured-route effort to Codex; line 260 uses lens effort resolution only for non-Codex fallback.
- we:scripts/lib/dispatch-routing-policy.mjs:71 accepts inherited entries with effort; line 102 can return null for inherited provider routing.
- we:scripts/lib/codex-task-route.mjs:69 validates explicit effort against the model; we:scripts/operations/__tests__/review-extra-seats.test.mjs:93 exercises reviewSeatRoutes.
