---
bornAs: xnc1xyl
kind: story
size: 3
parent: "3007"
status: open
scope: ["we:scripts/lib/ledger-readiness-daily.mjs", "we:scripts/lib/drain-ledger-shadow.mjs", "we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs", "we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Ledger shadow comparison counts the drain's own facts

TOP PRIORITY (operator 2026-10-17): land this first. Plan slice 1: the shadow comparison scores the label view WITH the drain's own facts (hold:drain:*, red CI, conflict, CodeQL, red-main), plus #6155 (replay must not hide unruled referrals; key the daily run by slot) and #6162 (latest-head exemption dedupe). Excludes we:scripts/lib/drain-ledger-facts.mjs, which open PR #5492 holds. WARNING: a scoring change resets the 7-day shadow clock, so land this first and once. The A1 test plan maps each fact and safeguard to a named case and assertion.

## Acceptance

- [A1] **Executable** — npx vitest run we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs fails before and passes after. Every named case and observable assertion in the test plan below belongs to A1; the cases are planned implementation tests, not tests delivered by this backlog-only PR.

### Test plan (A1)

| Planned test file | Named case | Observable assertion |
| --- | --- | --- |
| `we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs` | 'label view includes hold:drain facts' | Each supported hold:drain:* family independently produces a label-view hold and disagreement against a clear ledger. |
| `we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs` | 'label view includes red CI' | Red CI alone holds the label view and disagrees with a clear ledger. |
| `we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs` | 'label view includes conflict' | Conflict alone holds the label view and disagrees with a clear ledger. |
| `we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs` | 'label view includes CodeQL' | A blocking CodeQL result alone holds the label view and disagrees with a clear ledger. |
| `we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs` | 'label view includes red-main' | Red-main alone holds the label view and disagrees with a clear ledger. |
| `we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs` | 'unruled referral stays a disagreement under replay' | Replay cannot replace an unruled referral's disagreement with agreement. |
| `we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs` | 'daily run keyed by slot' | Repeating a slot is idempotent, while distinct slots on the same date remain separate runs. |
| `we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs` | 'latest-head exemption deduped' | Duplicate exemptions for the latest head count once; old-head exemptions cannot exempt the current head. |
| `we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs` | 'partial read scores unknown never agreement' | Parameterize ledger and label input with page-limit hits, buffer-limit hits and partial last rows; each yields unknown and zero agreement credit. |
| `we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs` | 'missing or errored evidence cannot satisfy readiness' | Missing file/row, empty-on-error and thrown reads on either input cannot produce agreement or satisfy the seven-day readiness bar. |
| `we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs` | 'other PR or head rows cannot affect comparison' | Foreign-PR or stale-head rows, clear and hold/disagree, leave current-head comparison unchanged: they cannot clear a hold, supply missing evidence or turn complete agreement into disagreement. |
| `we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs` | 'shadow scoring uses existing append-only ledger files' | Repeated runs preserve existing bytes, create no shared writer/file and confine any writes to appends on existing ledger paths. |
| `we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs` | 'scoring change resets clock and appears in digest' | New scoring version invalidates the previous seven-day window, begins a fresh window and names the reset in the digest; retries with that version do not reset it again. |
| `we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs` | 'unchanged scoring preserves clock' | The same scoring version in a later slot continues the current window without a reset notice. |
| `we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs` | 'shadow settings resolve via cascade with source logged' | Overrides select the expected value/source; missing or invalid authority settings fall back to labels and log that default source. |
| `we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs` | 'shadow comparison does not alter merge outcome' | Through the live merge-gate caller, enabling/disabling shadow scoring and injecting disagreement, unknown or a shadow exception preserves the existing live clear/hold result. |

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change live merge behaviour. A1: 'shadow comparison does not alter merge outcome'. Does not touch we:scripts/lib/drain-ledger-facts.mjs (held by #5492): n/a: this is a delivery scope fence, verified by inspecting the implementation diff rather than a runtime assertion.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads internal ledger rows and settings only.
2. **Truncated reads** — unknown, never agreement or readiness credit. A1: 'partial read scores unknown never agreement'.
3. **Shared state files** — existing-file appends only, no new shared writer. A1: 'shadow scoring uses existing append-only ledger files'.
4. **Fail closed** — missing/errored evidence cannot qualify readiness; invalid/missing authority settings retain labels. A1: 'missing or errored evidence cannot satisfy readiness', 'shadow settings resolve via cascade with source logged'.
5. **Identity scoping** — rows keyed by PR and head. A1: 'other PR or head rows cannot affect comparison', 'latest-head exemption deduped'.
6. **State over time** — scoring changes reset the seven-day clock and appear in the digest. A1: 'scoring change resets clock and appears in digest', 'unchanged scoring preserves clock', 'daily run keyed by slot'.
7. **Who wrote it** — setting values carry their cascade source in the log. A1: 'shadow settings resolve via cascade with source logged'.
