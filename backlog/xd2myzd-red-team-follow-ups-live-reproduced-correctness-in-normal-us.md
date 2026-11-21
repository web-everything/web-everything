---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/dep-trace.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7123 (head 46d676478)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7123 (reviewed head `46d676478047926934392317e39da937cbdbbc3e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/dep-trace.mjs:106` — (failing-input, degraded) Non-Node subprocess reads are incorrectly reported as complete evidence.
   - Scenario: With all required tracing variables and the valid hook in NODE_OPTIONS, call execSync('cat we:package.json', {env, encoding:'utf8'}). The shell successfully reads we:package.json, but it never executes the Node hook. The parent snapshot contains no edges and incomplete:false; replay reports traced:false, traceKnown:true for we:package.json. An unobservable subprocess should make evidence incomplete, yielding unknown for its missing dependencies.
   - Class: live-reproduced (basis: Reproduced with real execSync and filesystem stat calls. The command returned the repository package data, while mergeTraces and compareCoverage reported complete evidence with no we:package.json dependency.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/ci/dep-trace.mjs:58` — (failing-input, degraded) Callback-based directory reads silently escape tracing.
   - Scenario: After activateTrace, call fs.readdir('scripts/settings', callback). The callback successfully receives the directory entries, but the snapshot contains no list edge for scripts/settings and remains incomplete:false. Only readdirSync and promises.readdir are wrapped. The callback API should record the same directory dependency or mark the evidence incomplete.
   - Class: live-reproduced (basis: Reproduced with the real filesystem and loader on Node 22.1.0: the callback returned 123 entries while the directory edge was absent. Trace persistence was intercepted in memory to keep the review read-only.)
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
