---
bornAs: xtv678v
kind: task
status: open
scope: ["we:scripts/lib/__tests__/author-stamp-restore.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# author-stamp-restore tests: use backtick-free inputs for wrong-author and conflicting-ID cases

From the PR #7231 audit (waived R1085): in `we:scripts/lib/__tests__/author-stamp-restore.test.mjs` (~line 961) the wrong-author and conflicting-ID tests share a backticked fixture, so the blanket backtick refusal fires first and the provenance/agreement checks are never reached. Make those two tests use backtick-free inputs.

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/heavy-admission.mjs run -- node --test we:scripts/lib/__tests__/author-stamp-restore.test.mjs` passes, and with the provenance check (wrong author) or the agreement check (conflicting ID) disabled the matching test fails, proving each now reaches its own check rather than the backtick refusal.

## Non-goals

- [N1] Does not change the backtick refusal or any production code.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Fixtures stay hostile in every way except backticks.
2. **Truncated reads** — n/a: test-only change.
3. **Shared state files** — n/a: test-only change.
4. **Fail closed** — Each test asserts a refusal naming its own reason, not the backtick one.
5. **Identity scoping** — The wrong-author test uses a real mismatching author.
6. **State over time** — n/a: test-only change.
7. **Who wrote it** — n/a: test-only change.
