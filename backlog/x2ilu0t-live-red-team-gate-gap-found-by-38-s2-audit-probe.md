---
kind: story
size: 2
status: open
scope: ["we:red-team-gate-apply.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# LIVE red-team gate gap (found by #38 s2 audit probe)

HIGH priority hint. - (HIGH, 11-02 11:28 ET) LIVE red-team gate gap (found by #38 s2 audit probe): a clearance recorded for a red-team result survives findings added/changed later on the same result, because the result id does not change with its content. Also the producer never writes a positive `no-send-back`/clear outcome, so no reader can know "clear" from the store. Fix: bind clearance to a content digest of the findings (result id + findings hash); any change invalidates it; write an explicit clear outcome. Verify against main before filing (worker probe, not yet reproduced by orchestrator).   - addendum 11:31 ET: the gate resultId digest also ignores indented/malformed confirmed findings, so appending one to a result with a sent-back record leaves the digest unchanged (found by #38 s2 audit). Same card: digest must cover every finding-shaped line.   - 11:48 ET #43 must also make we:red-team-gate-apply.mjs WRITE an explicit clear/no-send-back record for a clean result (today it returns advisory-only with zero records). #40 v2 (lane/needs-you-confirmed-break-v2) depends on it.

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
