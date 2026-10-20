---
bornAs: xr0lbjw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Either restrict grouping to we-locus leads in groupEligible / planBuildGroups and add a test, or… (from web-everything/web-everything#5187 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/deliver-item-wrapper.mjs:567` — Either restrict grouping to `we`-locus leads in `groupEligible` / `planBuildGroups` and add a test, or read the marker from `implLanePath ?? claimLanePath`. Add a grouped-delivery test parameterised on locus.
2. `we:scripts/operations/probation-build-run.mjs` — Export a single group-reason sanitizer (sanitizeGroupDropReason) and use it at every PR-body or commit sink. Add a lint or standards check that any template writing a `Dropped|Not prepared` reason must go through it.
3. `we:scripts/operations/deliver-item-wrapper.mjs` — Add a small `readAgentMarker` helper that lstat-checks for a regular file, caps its size, and never echoes raw content. Add a check:standards rule flagging readFileSync on `${lane}/.*` marker paths outside it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5187@886a077ab8167f12878e95c8951fcf11c21ea00b

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
