---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/dep-trace.mjs", "we:scripts/lib/ci-selection-settings.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7123 (head 1ea3e15b0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7123 (reviewed head `1ea3e15b09a837065e7b1462fdff8ec174419591`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/dep-trace.mjs:59` — (failing-input, degraded) Stream and file-descriptor reads silently escape tracing
   - Scenario: After activation, consume fs.createReadStream('we:package.json'), or open it with fs.openSync and pass the descriptor to fs.readFileSync. Both successfully read 8241 bytes, but produce an empty, untruncated trace. Replay reports traced=false, traceKnown=true and unknown=0 for we:package.json. Record these read dependencies or mark unsupported reads as incomplete evidence.
   - Class: live-reproduced (basis: Reproduced with real Node 22 filesystem reads. The activation probe replaced only trace persistence with in-memory output, avoiding filesystem writes.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/ci/dep-trace.mjs:171` — (edge-case, degraded) Replay ignores dependencies represented by directory-list edges
   - Scenario: A test enumerates scripts/ci with readdirSync and asserts its filenames. The tracer correctly records scripts/ci with kind=list. Supply a miss for deleting we:scripts/ci/dep-trace.mjs: compareCoverage reports traced=false and traceKnown=true because it checks only exact file keys. A deletion changes the observed listing; replay should account for list-edge membership dependencies rather than classify this pair as uncovered.
   - Class: live-reproduced (basis: A real readdirSync recorded the directory edge; passing the child path to mergeTraces and compareCoverage reproduced traced=false with unknown=0.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
3. `we:scripts/lib/ci-selection-settings.mjs:23` — (edge-case, degraded) Settings loader bypasses the platform preference layer
   - Scenario: Provide platform preferences containing ci.selection.trace with enabled=false and maxEdgesPerTest=17, then call loadCiSelection with tool={} and no explicit platform argument. The loader returns enabled=true and maxEdgesPerTest=5000. Converting the absent platform argument to an empty object prevents cascadePolicy from loading platform preferences. Leave platform undefined when it was not supplied so valid lower-layer settings apply.
   - Class: live-reproduced (basis: With an in-memory platform-file read seam, direct cascadePolicy resolved false and 17, while loadCiSelection using the same environment resolved true and 5000.)
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
