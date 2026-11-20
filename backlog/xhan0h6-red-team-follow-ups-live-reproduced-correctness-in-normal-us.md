---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/pr-merge-gate.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7222 (head 62adc1910)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7222 (reviewed head `62adc191021be240e3abfff03b262785875ba830`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/pr-merge-gate.mjs:296` — (failing-input, degraded) Live tests mentioning it.todo in a title are counted as removed
   - Scenario: In we:parser.test.mjs, replace it("old title", () =&gt; expect(true).toBe(true)); with it("it.todo is parsed", () =&gt; expect(true).toBe(true));. Supply the valid one-line replacement diff with scored:true and rev equal to pinnedHeadSha. The scanner returns tampered:true with tests-removed because the new exclusion regex matches it.todo inside the title and discards the live added case. Without human clearance, this unnecessarily holds the PR. The unchanged live case should offset its removed version; the exclusion should inspect the test callee rather than arbitrary text on the line.
   - Class: live-reproduced (basis: A direct Node probe reproduced tests-removed with evidenceIncomplete:false for this title-only change. An otherwise identical replacement using "new title" returned tampered:false.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break

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
