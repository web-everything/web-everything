---
bornAs: xgyc95h
kind: task
status: open
scope: ["we:scripts/operations/scaffold-io.mjs", "we:scripts/operations/scaffold.mjs", "we:scripts/operations/file-item.mjs", "we:scripts/operations/__tests__/scaffold-io.test.mjs", "we:scripts/operations/__tests__/file-item-io.test.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Reserve birth numbers only after filing validation

PR #5958 review (2026-10-26), correctness finding 2: createScaffoldReader reserves before planScaffold or planFileItem validates the input. A rejected title, size, or operator-task role can burn a number without creating a card. Defer reservation until validation succeeds, or expose an allocation thunk invoked once after validation. Preserve required-remote refusal, identity replay, and burned-claim semantics after reservation. Add integration tests asserting no hash-object or push on rejected input, while valid filings reserve before writing. This tracks an accepted gap in slice 0.

## Acceptance

- [A1] **Executable** — Run the scaffold-io and file-item-io unit suites with a stub transport. Missing title, invalid size, and refused operator-task role cause zero hash-object/push calls and no card writes; a valid card reserves exactly once before writing.

## Non-goals

- [N1] Change post-reservation burned-gap semantics or relax operator-task admission.

## Edge cases this change must handle

1. **Untrusted text** — Keep title, size, and role validation intact before allocation.
2. **Truncated reads** — Unavailable remote evidence retains best-effort fallback and required-mode refusal.
3. **Shared state files** — Keep the shared numbering lock and atomic create-only claims.
4. **Fail closed** — Reject invalid filings without reserving or writing; valid required-mode failures still refuse.
5. **Identity scoping** — Preserve one birth hash and id-to-number mapping for a valid filing.
6. **State over time** — Retries of invalid filings must not advance the frontier.
7. **Who wrote it** — n/a: no new endpoint or authority; reuse the caller and existing guarded writer.
