---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/scheduled-sweep.mjs", "we:scripts/operations/agy-usage-reader.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use, coverage-or-style] from web-everything/web-everything#7331 (head 791120edc)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7331 (reviewed head `791120edcac2d97d0717437031ed4c178ad11ea6`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/scheduled-sweep.mjs:183` — (edge-case, degraded) The 30-minute throttle skips alternate scheduled collections.
   - Scenario: Start collection at 12:00:00 and produce its snapshot at 12:00:03.300. The scheduled 12:30:00 invocation sees an age of 1,796.7 seconds, below the configured 1,800-second minimum, and returns skipped. Collection resumes at 13:00. Evenly spaced scheduled invocations therefore collect hourly; the advertised half-hour schedule should collect at each tick.
   - Class: live-reproduced (basis: Reproduced through runAgyUsageReader with injected in-memory I/O, a controlled clock, and a 3.3-second collection duration. The 30-minute invocation skipped; the 60-minute invocation collected.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/agy-usage-reader.mjs:99` — (edge-case, degraded) Partial signed-out evidence does not prevent the initial Escape write.
   - Scenario: Before the startup timer fires, emit a horizontal rule and '? for shortcuts', then emit '\^[\[8;2HYou are currently not signed in.\n'. Fire the startup timer, then deliver 'Select login method'. The collector writes Escape before resolving signed-out because startIfSignedIn ignores the already-visible negative login marker. It should withhold keys whenever either login marker is present, as the later /usage guard already does.
   - Class: live-reproduced (basis: A deterministic injected-PTY replay produced an Escape stdin write after the 'not signed in' marker arrived, then resolved signed-out when the second marker arrived. No real OAuth flow was launched; the triggering case assumes a partial cursor-positioned repaint retains earlier prompt text.)
   - Also class: coverage-or-style
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
