---
bornAs: xlzespy
kind: story
size: 2
status: open
scope: ["we:scripts/operations/needs-you-feed.mjs", "we:scripts/operations/operator-session-bootstrap-io.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5374 (head 080940bf6)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5374 (reviewed head `080940bf6d55457228c3b0547ab3bb24da05062d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/needs-you-feed.mjs:185` — (edge-case, degraded) A transient head lookup failure falsely clears and republishes an unchanged item
   - Scenario: Poll the same ready PR three times, with head lookup returning SHA A, throwing a timeout, then returning SHA A again. Probing runOnce with filesystem operations redirected entirely into memory produced: first an opening for A; then an opening with head='' plus a CLEARED event for A; then another opening for A plus a CLEARED event for head=''. The PR never left the queue or changed head. Lookup failure should preserve the known open item as unknown, without claiming clearance or manufacturing duplicate transitions.
   - Claude's re-check: A failed lookup leaves item.head=''. The key then changes from 'r#1(at)A:needs-you' to 'r#1(at):needs-you'. diffFeed isn't incomplete, so it emits an opening for the empty head and a CLEARED for A. The next poll reverses this, producing the duplicate transitions described.
2. `we:scripts/operations/operator-session-bootstrap-io.mjs:13` — (failing-input, degraded) Quiet-hours extraction drops the actual hours and exception policy
   - Scenario: Use handoff rules containing '# Quiet hours\n- Between 22:00 and 07:00 America/Toronto.\n- Only critical incidents may interrupt.\n'. A bootstrapPlan probe with in-memory file reads retained only '# Quiet hours' in the appended rules. Filtering individual lines for 'quiet' discards both the schedule and its exception, leaving the generated cron prompt without the promised policy. Preserve the relevant section, including its continuation lines.
   - Claude's re-check: The filter '/quiet/i.test(line)' keeps only lines containing 'quiet'. In the example, '# Quiet hours' survives but '- Between 22:00 ...' and '- Only critical incidents...' are dropped, so the schedule and exception never reach the prompt.

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
