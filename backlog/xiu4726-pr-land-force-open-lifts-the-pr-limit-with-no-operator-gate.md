---
kind: story
size: 2
status: active
scaffoldedBy: "fix-4791"
dateScaffolded: "2026-10-10"
scope: ["we:scripts/pr-land.mjs", "we:scripts/conveyor/health-smells/open-prs-over-limit.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# pr-land --force-open lifts the PR limit with no operator gate

PR 4791 gated the `allow` and `off` verbs of `we:scripts/operations/pr-limit.mjs` behind `authoriseOverride` in `we:scripts/lib/pr-limit.mjs`: a worker, unknown-role or lane session is refused, and a verbatim `--operator-quote` is required. `pr-land --force-open` still lifts the limit for one PR with only a free-text reason, so a worker refused by the limit can open its PR anyway. Route `--force-open` through the same gate. The `open-prs-over-limit` health smell still tells the operator to run `off` without `--operator-quote`; update the hint.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/pr-limit.test.mjs`: `decideOpenPr` (or the `pr-land` caller) with `forceOpen` from a worker env (`WE_CONVEYOR_WORKER=1`) stays refused over the limit; from the operator channel with a quote it is allowed. Red before, green after.
- [A2] `OVERRIDE_VERBS` (or a sibling list) names `--force-open`, so the enumeration test covers every limit-lifting entry point.
- [A3] The health-smell hint names `--operator-quote`.

## Non-goals

- [N1] The land-time session check for allow-list grants — that is `x964z5g`.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the quote is bounded by `OPERATOR_QUOTE_MAX` and stored verbatim, as for `allow`/`off`.
2. **Truncated reads** — n/a: no new reads.
3. **Shared state files** — n/a: `--force-open` writes no store entry; the refusal is logged through the existing history writer.
4. **Fail closed** — an unknown session role refuses `--force-open`.
5. **Identity scoping** — the role is read from the `pr-land` process env, the same marker every dispatch spawn site sets.
6. **State over time** — n/a: a one-shot flag.
7. **Who wrote it** — the operator channel and quote are recorded in the PR-limit history.
