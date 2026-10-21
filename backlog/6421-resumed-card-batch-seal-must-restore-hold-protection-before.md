---
bornAs: x77rl7p
kind: story
size: 3
priority: high
parent: "4075"
status: open
scope: ["we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Resumed card-batch seal must restore hold protection before any re-publish

we:scripts/operations/card-batch-seal-io.mjs resumes a sealing batch from persisted state; protection recovery (hold label, draft) is only re-applied on some resume paths, so a resumed batch can publish or ready a PR without the hold. Always restore protection first, fail closed if it cannot be restored.

## Acceptance

- [A1] Executable: we:scripts/operations/__tests__/card-batch-seal-io.test.mjs — resume a sealing batch from every persisted step (including after a crash mid-protection): the hold label and draft state are restored before any push, ready or merge; red before: a resumed path publishes without protection.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the 7 approved prototype relaxations or other guards; fixes only this gap, which is already present on main (pre-existing gap, expedited).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — persisted state is read as data only.
2. **Truncated reads** — a half-written state file refuses the resume, never guesses.
3. **Shared state files** — state file written atomically under the lease.
4. **Fail closed** — restore protection first; if it cannot be restored, hold and refuse.
5. **Identity scoping** — the batch ref and repo are pinned in state and re-checked against the remote head.
6. **State over time** — protection is re-applied on every resume, not only the first.
7. **Who wrote it** — only the lease owner may resume.
