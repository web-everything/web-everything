---
bornAs: xp700tn
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/daemon-overlay.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Review-daemon rebuild starvation: let an in-flight rebuild adopt before a newer main restarts it

2026-10-24 20:39 ET: registered lane/reaper-stale-terminal-row-daemon@acaabbc9d2 was not adopted after about 50 min; each main move queues a new rebuild (build plus about 6 min smoke) and the clone never moves ('rebuild did not move the clone'). Want: an in-flight rebuild finishes and adopts before a newer main restarts it, or rebuilds coalesce. Live proof: the next fix-N lease on a PR with old stopped rows survives the reaper after adoption.

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
