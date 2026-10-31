---
bornAs: xix6jja
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing.md"]
dateOpened: "2026-10-31"
tags: []
---

# #6059 R251 review carve-outs: reserveWorker, transfer-byte test, snapshot cap, test gaps

2026-10-30 16:07 ET: (1) reserveWorker validates the requested slot but allocates the first available (CONFIRMED); (2) remote-exec.test lacks an exact transfer-byte total incl. sibling payloads while we:docs/agent/testing.md claims it (CONFIRMED x2); (3) forge-exec-bases worktree materialize fails on a snapshot file over 4MiB while manifest/staging have no cap (PLAUSIBLE); (4) test gaps: warm-cache archive hash, slot-quarantine marker removal failure, prod ops-identity wiring, bypass==='held' conjunct.

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
