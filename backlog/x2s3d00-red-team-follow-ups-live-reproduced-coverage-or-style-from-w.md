---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/soak/breaks/deps-job-builtins-only-import-chain.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7421 (head 4e8ae086c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7421 (reviewed head `4e8ae086c8e7d1355b335a2a0a07fa84bfd2f694`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/soak/breaks/deps-job-builtins-only-import-chain.mjs:64` — (edge-case, degraded) Uninstantiated class fields produce false startup-load violations
   - Scenario: Input: class C { field = import('ext'); }. packageChains('we:e.mjs', () =&gt; source) returns ['we:e.mjs -&gt; ext'], although Node successfully evaluates this module without ext installed. Instance initializers run upon construction, so this uninstantiated class should produce no violations. The current traversal makes valid deferred dependencies fail the soak check.
   - Class: live-reproduced (basis: Ran the unmodified walker and separately evaluated the exact source through Node's module loader; observed a violation despite successful module evaluation.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/soak/breaks/deps-job-builtins-only-import-chain.mjs:52` — (edge-case, degraded) IIFE traversal flags defaults and generator bodies that never execute
   - Scenario: Inputs: ((x = import('ext')) =&gt; {})(123); and (function* () { yield import('ext'); })();. Both return ['we:e.mjs -&gt; ext'] from packageChains. Neither attempts the import: the supplied argument bypasses the default, and creating a generator does not execute its body. Both should produce no startup violations, but instead falsely fail the guard.
   - Class: live-reproduced (basis: Executed both exact inputs through the walker and Node's module loader. Both runtime evaluations succeeded without ext while the walker reported violations.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break
3. `we:scripts/conveyor/soak/breaks/deps-job-builtins-only-import-chain.mjs:79` — (failing-input, degraded) Relative import URL queries are treated as literal filename characters
   - Scenario: Given we:entry.mjs containing import 'we:./rule.mjs?v=1'; and we:rule.mjs containing import 'node:fs';, the walker requests we:rule.mjs?v=1 instead of we:rule.mjs and throws when reading it. Node supports this relative import URL. The walker should resolve its filesystem pathname and inspect we:rule.mjs, returning no violations rather than crashing.
   - Class: live-reproduced (basis: Confirmed Node successfully imports an existing repository module with ?fresh=1, then passed that same import to packageChains with readFileSync; the walker threw ENOENT for the filename including ?fresh=1.)
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
