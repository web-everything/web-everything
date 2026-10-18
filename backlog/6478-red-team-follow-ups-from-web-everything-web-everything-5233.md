---
bornAs: xofj1ri
kind: story
size: 2
status: open
scope: ["we:scripts/lib/numbering-carry.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5233 (head 3401ef8bf)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5233 (reviewed head `3401ef8bf1254eedb365a74d5554a3b258d1f53d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/numbering-carry.mjs:605` — (edge-case, degraded) Head-only refusal caching prevents recovery after main's numbering aliases become available
   - Scenario: Use a numbering commit A→B that renames xabc123 to 7001 and rewrites a reference xdef456 to 8000. Initially, the local origin/main lacks the bornAs:xdef456 alias, so the proof refuses and caches B as settled. Fetch main so it now contains we:backlog/8000-old.md with bornAs:xdef456, without changing the PR head. A read-only git-response fixture reproduced proveNumberingOnlyMove returning ok:true afterward, while restampAfterNumbering still returned null for the same input. The sweep also skips settled heads before reading live evidence. Refusals dependent on main's aliases must be invalidated when
   - Claude's re-check: A non-retryable proof refusal does settledRestamps.add(repo#pr(at)head). The key has no main-alias component, and extraMap.readFailed only marks retryable when the grep itself fails, not when aliases are missing. After main gains the alias, restampAfterNumbering returns null at the settledRestamps check, and the sweep skips via numberingRestampSettled, so the carry never recovers on that head.

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
