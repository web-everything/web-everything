---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/pr-trace.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5961 (head e29192f23)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5961 (reviewed head `e29192f23a7d0b9719209e4b67e7da647cf5e563`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/pr-trace.mjs:25` — (failing-input, degraded) A reference to the target PR attributes another PR's blocker to it
   - Scenario: Trace PR 12 in web-everything/web-everything with fix evidence 'web-everything/web-everything PR #13 waiting behind landing holder #12'. The probe returned queue.landingHolder='12' and likelyBlocker='#12 waiting behind landing holder #12'. Matching any occurrence of #12 mistakes a dependency reference for the record's subject. This line should belong to PR 13 and must not establish a self-dependency for PR 12.
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/pr-trace.mjs:26` — (failing-input, degraded) Short repository keys bypass prose repository filtering
   - Scenario: Trace web-everything/web-everything PR 12 with fix evidence 'reconcile-fix-dispatch-daemon: reconcile-refused live-process frontierui PR #12 — pid 123 alive, session stalled'. The probe attributed the line to WE and reported 'live pid on stuck session'. The repository regex recognizes only slash-containing slugs, so the explicit frontierui key becomes an unscoped record. Short keys are supported daemon output: the existing formatRefusalLine test expects '... live-process we PR #3794 ...'. Recognized repository keys should be compared against the requested repository, excluding frontierui here.
   - Claude's re-check: demonstrated break
3. `we:scripts/operations/pr-trace.mjs:50` — (edge-case, degraded) An obsolete head finishing later overrides valid current-head red-team evidence
   - Scenario: Let the live head be B. Its red-team status finishes first; a still-running job for previous head A finishes afterward, giving A's status file a newer mtime. The reader sorts statuses by mtime, and buildPrTrace selects the last record regardless of head. A probe with current-head B followed by obsolete-head A reported 'stored red-team head != live head' as the likely blocker even with review:accepted and red-team:clear labels. Existing valid evidence for B should take precedence; A's late completion should remain historical evidence.
   - Claude's re-check: demonstrated break
4. `we:scripts/operations/pr-trace.mjs:41` — (failing-input, degraded) Daemon repeat compression prevents the loop counter from detecting repeated blockers
   - Scenario: Supply one timestamped 'review-daemon: web-everything/web-everything#12 held, no review dispatched — waiting for review' line followed by its real formatRepeatLine(reason, 10, since, now) output. This represents 11 occurrences under the daemon's default log compression. The probe returned looping=[] at the default threshold of 10. Passing the same evidence through the existing expandRepeatedLines helper produced count=11. The trace should account for compressed multiplicities and normalize the underlying reason instead of counting the marker as one different reason.
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
