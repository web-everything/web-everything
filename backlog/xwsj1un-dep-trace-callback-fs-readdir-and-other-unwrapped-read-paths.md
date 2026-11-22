---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/dep-trace.mjs", "we:scripts/ci/__tests__/dep-trace.test.mjs", "we:docs/agent/testing.md"]
dateOpened: "2026-11-21"
tags: []
---

# dep-trace: callback fs.readdir and other unwrapped read paths leave no edge and no incomplete flag

Read-path gap carded per the PR #7123 exit ruling (send-back item 3). we:scripts/ci/dep-trace.mjs install() wraps readFileSync/readFile/readdirSync/existsSync and fs/promises readFile/readdir, but not callback fs.readdir (nor opendir or other callback read paths). A test that lists a directory through callback fs.readdir leaves no list edge while its evidence reads complete, so replay can report traced:false for a real dependency. Fix: wrap the callback form observe-only (same peek-based safe reads, untouched arguments), or mark the evidence incomplete on any unwrapped read path; add a named test per path.

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
