---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/dep-trace.mjs", "we:scripts/lib/ci-selection-settings.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use, coverage-or-style, attacker-same-user] from web-everything/web-everything#7123 (head 2456a9825)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7123 (reviewed head `2456a9825d64b54804ef2a51a0656c245121fd7f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/dep-trace.mjs:218` — (edge-case, degraded) SIGTERM discards child dependency evidence without marking the test incomplete
   - Scenario: A traced parent starts a child that reads we:package.json, then terminates it with child.kill('SIGTERM'). Node's default signal termination does not emit the exit event, so the child's recorded edges are never persisted. Merging the surviving parent trace treats the test as known despite losing the child's dependencies. Persist the child's evidence or classify the test as unknown when its child trace is missing.
   - Class: live-reproduced (basis: An actual Node child read we:package.json through the tracer. Clean termination invoked persistence; SIGTERM produced no persisted evidence. The probe replaced filesystem persistence with synchronous stdout capture and created no files.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/ci/dep-trace.mjs:71` — (failing-input, degraded) execSync bypasses trace propagation when supplied an explicit environment
   - Scenario: A traced test calls execSync with a Node command and options.env containing only PATH. execSync is absent from the wrapped API list, so the child receives neither WE_TRACE_TEST nor NODE_OPTIONS and emits no trace. Reads performed by that child disappear from the merged evidence. The explicit environment should receive the same trace propagation provided by the wrapped spawn APIs.
   - Class: live-reproduced (basis: A real execSync child printed an empty object when asked for its trace identity and NODE_OPTIONS; the installed parent's trace also contained no spawn edge.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
3. `we:scripts/ci/dep-trace.mjs:68` — (failing-input, degraded) Promise reads through FileHandle silently lose the dependency
   - Scenario: Open we:scripts/settings/ci-selection.json with fs.promises.open, then pass the returned FileHandle to fs.promises.readFile. The read succeeds, but the wrapper passes the handle to a path normalizer that ignores it, while open is uninstrumented. The resulting trace has no edges and truncated=false; compareCoverage reports traced=false and traceKnown=true for the file. Track the handle's source path or classify this evidence as incomplete.
   - Class: live-reproduced (basis: The actual filesystem read returned 374 bytes. The tracer snapshot remained empty, and replay reported zero unknown entries for that test.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break
4. `we:scripts/lib/ci-selection-settings.mjs:24` — (failing-input, degraded) The settings loader suppresses platform preference discovery
   - Scenario: Set the platform policy ci.selection.trace to enabled=false and maxEdgesPerTest=7, with the tool trace block absent. loadCiSelection passes platform={} even when no platform argument was supplied. cascadePolicy therefore skips its platform preference reader and returns enabled=true and maxEdgesPerTest=5000. Unset tool leaves should inherit the configured platform values.
   - Class: live-reproduced (basis: With a virtual platform file supplied through an in-memory filesystem interception, direct cascadePolicy resolution returned false and 7, while loadCiSelection with the same environment and an empty tool block returned true and 5000.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
5. `we:scripts/lib/ci-selection-settings.mjs:25` — (failing-input, degraded) An object-valued cap bypasses validation and disables the edge bound
   - Scenario: Supply the tool block trace.maxEdgesPerTest={nested:0}. Cascade validation accepts the nested integer and returns the whole object as maxEdgesPerTest. The tracer then compares its edge count against that object, which converts to NaN, so the cap never triggers. Invalid cap values should retain the numeric lower-layer default of 5000.
   - Class: live-reproduced (basis: The actual settings loader returned the object-valued cap. Adding 5001 unique edges produced edgeCount=5001 and truncated=false instead of enforcing the fallback cap.)
   - Also class: attacker-same-user
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
