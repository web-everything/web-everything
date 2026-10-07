---
bornAs: x5yd38g
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/test-cache/tracer.mjs", "we:scripts/lib/test-cache-trace.mjs", "we:scripts/test-cache/__tests__/tracer.test.mjs", "we:scripts/lib/__tests__/test-cache-trace.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — In installTracer, after copyProps, redefine promisify.custom on the wrapper for exec/execFile so… (from web-everything/web-everything#4314 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/test-cache/tracer.mjs:88` — In installTracer, after copyProps, redefine promisify.custom on the wrapper for exec/execFile so it delegates to the wrapper. Add a we:tracer.test.mjs case that runs promisify(execFile) and promisify(exec) and asserts a spawn event is recorded. Optionally add a check:standards rule listing the exotic call paths the tracer must cover.
2. `we:scripts/lib/test-cache-trace.mjs:135` — Add a table-driven `analyzeTrace` test of evasion shapes (compound shell lines, `--git-dir`, `GIT_DIR`, URL cwd, git clone). Before any slice acts on `admitted`, make the S4 gate reject `shell: true`/`exec` lines with metacharacters and any git invocation not scoped by cwd or `-C`.
3. `we:scripts/test-cache/tracer.mjs:115` — Add a deterministic tracer integration test covering net.connect/createConnection and direct Socket.connect, asserting that each produces the expected network event without requiring an external connection.
4. `we:scripts/lib/test-cache-trace.mjs:132` — Add a deterministic analyzer regression test with root nested beneath tmpRoots, requiring repository reads to remain traced and repository spawn cwd to remain denied; give repository membership precedence over temporary-root exemptions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4314@7056ee1053f8e37b1e7e8c6663f0e80bed738270

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
