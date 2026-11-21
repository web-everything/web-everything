---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/dep-trace.mjs", "we:scripts/lib/ci-selection-settings.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7123 (head 114c8f692)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7123 (reviewed head `114c8f692e50caaaa4c53103a059aa3d53b1c3db`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/dep-trace.mjs:71` — (failing-input, degraded) execSync with an explicit environment silently loses child dependency evidence
   - Scenario: Activate tracing, then call execSync to run Node reading we:scripts/settings/ci-selection.json with options {env:{},encoding:'utf8'}. execSync bypasses the patched functions, so the child receives neither trace identity nor preload. The probe read 374 bytes successfully, but the parent emitted truncated:false with empty edges; compareCoverage reported traced:false, traceKnown:true and unknown:0. Child tracing should propagate through this API, or the missing evidence should remain unknown.
   - Class: live-reproduced (basis: Reproduced on Node v22.1.0 through activateTrace and a real execSync child. Trace persistence was captured in memory without filesystem writes.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/ci-selection-settings.mjs:24` — (failing-input, degraded) The settings loader suppresses automatic platform preference resolution
   - Scenario: Configure platform preferences with 'ci.selection.trace':{enabled:false,maxEdgesPerTest:12}, omit tool trace overrides, and supply no environment override. loadCiSelection returns enabled:true and maxEdgesPerTest:5000 instead of inheriting the platform values. Normalizing an unspecified platform argument to an empty object prevents cascadePolicy from loading platform preferences. Preserve undefined so the configured platform layer can resolve.
   - Class: live-reproduced (basis: A read-only probe supplied platform JSON through an in-memory readFileSync replacement. platformPreference resolved false/12, while loadCiSelection with the same environment and tool:{} returned true/5000.)
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
