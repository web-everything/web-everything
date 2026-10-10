---
kind: story
size: 2
parent: "xayvwbh"
status: active
scaffoldedBy: "fix-4689"
dateScaffolded: "2026-10-10"
dateOpened: "2026-10-10"
tags: []
---

# Merge queue: pin pulls/files read to the judged head sha, and make affected-mode read the cwd clone only for its own repo

Found in PR 4689 fix review: readMergeFreshnessFacts reads pr.files from pulls/{num}/files without pinning headSha (a push between reads gives a verdict from a different head; the merge itself is pinned by match-head-commit, so bounded), and readAffectedFacts uses process.cwd() for cross-repo PRs (fails closed only because the commits are missing). Add tests for both.

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
