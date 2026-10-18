---
bornAs: xnc1xyl
kind: story
size: 3
parent: "3007"
status: open
scope: ["we:scripts/lib/ledger-readiness-daily.mjs", "we:scripts/lib/drain-ledger-shadow.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Ledger shadow comparison counts the drain's own facts

TOP PRIORITY (operator 2026-10-17): land this first. Plan slice 1: the shadow comparison scores the label view WITH the drain's own facts (hold:drain:*, red CI, conflict, CodeQL, red-main), plus #6155 (replay must not hide unruled referrals; key the daily run by slot) and #6162 (latest-head exemption dedupe). Excludes we:scripts/lib/drain-ledger-facts.mjs, which open PR #5492 holds. WARNING: a scoring change resets the 7-day shadow clock, so land this first and once. Tests per guarantee: drain-fact holds appear in label view; unruled referral stays a disagreement under replay; daily run keyed by slot; latest-head exemption deduped.

## Acceptance

- [A1] **Executable** — npx vitest run we:scripts/lib/__tests__/ledger-readiness-daily.test.mjs we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs (tests: 'label view includes hold:drain facts', 'unruled referral stays a disagreement under replay', 'daily run keyed by slot', 'latest-head exemption deduped') fails before and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the live merge behaviour, or touch we:scripts/lib/drain-ledger-facts.mjs (held by #5492).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads internal ledger rows and settings only.
2. **Truncated reads** — a partial read is scored as unknown and fails closed (ledger holds), never as agree.
3. **Shared state files** — appends only to existing ledger files, no new shared writer.
4. **Fail closed** — any missing or invalid input resolves to labels authority or a ledger hold.
5. **Identity scoping** — rows keyed by PR and head.
6. **State over time** — n/a: a change to scoring resets the 7-day shadow clock, noted in the digest.
7. **Who wrote it** — setting values carry their cascade source in the log.
