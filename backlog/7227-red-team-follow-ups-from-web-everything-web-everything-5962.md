---
bornAs: x7p30do
kind: story
size: 2
status: open
scope: ["we:scripts/worker-brief.mjs", "we:scripts/operations/run.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5962 (head 8642c8b82)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5962 (reviewed head `8642c8b828a7f794b71ff0a87fbf9f2deddacb4a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/worker-brief.mjs:96` — (failing-input, degraded) The first Codex round runs full verification before reaching the size checkpoint.
   - Scenario: Use build.finalGate=full (the standard default) and have the first coding round produce 301 non-test lines. The brief invokes we:codex-direct-task.mjs synchronously with --gate=full. That wrapper awaits executeGate() before returning, so verification runs before the worker can commit and invoke pr-size. A probe rendering this policy and invoking runGate with an injected executor recorded we:scripts/verify-lane.mjs run --gate=npm run test:unit && npm run check:standards. The oversized round should be measured and stopped before this full verification, as the new instruction claims.
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/run.mjs:773` — (edge-case, degraded) The read-only CLI operation can fetch and write through its freshness preflight.
   - Scenario: Invoke pr-size from a runner outside the lane pool and managed-clone exemption, with an origin remote and a missing or expired freshness cache. PR_SIZE_OP receives an in-memory store here but is omitted from the zeroWrites operations passed to assertRunnerFreshness at line 763. An injected probe of the actual freshness function recorded git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main and write/rename calls for we:.git/operation-runner-freshness.json. Thus this read-only check can update remote refs, write cache files, and require network access. It should pass zeroWrites:true s
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
