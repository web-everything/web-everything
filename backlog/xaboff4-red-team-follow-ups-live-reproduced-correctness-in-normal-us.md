---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/dep-trace.mjs", "we:scripts/lib/ci-selection-settings.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7123 (head 4d80cc26c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7123 (reviewed head `4d80cc26c7cef36e38d8d201231b9155b5d2af38`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/dep-trace.mjs:59` — (edge-case, degraded) Stream reads disappear from evidence reported as known
   - Scenario: Install createTracer against real node:fs and consume fs.createReadStream('we:scripts/settings/ci-selection.json') through its end event. The read succeeds, but snapshot() returns edges:[] and truncated:false. Merging that snapshot and comparing the file reports traced:false, traceKnown:true, unknown:0. Record the stream dependency or classify the evidence as incomplete instead of treating an observed read as absent.
   - Class: live-reproduced (basis: A read-only probe consumed all 374 bytes of the existing settings file and reproduced the empty snapshot and known-negative coverage result.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/ci-selection-settings.mjs:24` — (failing-input, degraded) The settings loader suppresses platform policy lookup
   - Scenario: Supply a platform preferences file containing {"ci.selection.trace":{"enabled":false,"maxEdgesPerTest":7}} and call loadCiSelection with tool:{} and WE_PLATFORM_PREFERENCES_FILE pointing to it. The result is enabled:true and maxEdgesPerTest:5000. Converting an omitted platform argument to an empty object prevents cascadePolicy from reading platform preferences. With tool leaves absent, the platform values should apply.
   - Class: live-reproduced (basis: Using an injected filesystem response, platformPreference read the configured false/7 values while loadCiSelection returned true/5000 for the same environment.)
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
