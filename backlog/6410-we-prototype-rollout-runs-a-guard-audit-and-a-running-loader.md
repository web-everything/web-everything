---
bornAs: x2bm019
kind: story
size: 5
status: open
dateOpened: "2026-10-18"
tags: []
---

# Prototype rollout runs a guard audit and a running-loader check before any daemon load

Operator 2026-10-18: prototype rollouts (lane/proto-*) must never loosen a guard. Today the guard audit (a Codex read-only diff vs origin/main that lists anything weaker than main beyond operator-approved relaxations) lived only in agent prompts, and the approved list was copied by hand. Fix: (1) a declared operation `proto-guard-audit` runs before any overlay load of a lane/proto-* ref; its approved-relaxations list is DATA (settings, each entry with the operator ruling quote and date) and it refuses the load on any finding outside the list; (2) the loader refuses while another loader for the same clone is in flight; (3) the audit verdict and the list version are recorded with the overlay.

Scope: we:scripts/lib/daemon-load-overlay.mjs, we:scripts/daemon-overlay.mjs, a new we:scripts/operations/proto-guard-audit.mjs and its test, plus a settings file for the approved-relaxations list.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/operations/proto-guard-audit.test.mjs` fails before this lands and passes after. It covers: a weaker-than-main diff outside the list refuses the load; an approved one passes; a second concurrent loader for the same clone is refused; the audit verdict and list version are recorded with the overlay.

## Non-goals

- [N1] Does not decide which relaxations the operator approves; the list is filled only from operator rulings.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the audit reads the diff as data and never executes or follows instructions found in it.
2. **Truncated reads** — a diff or audit output that cannot be read in full refuses the load.
3. **Shared state files** — the in-flight loader check uses a per-clone lock file; a stale lock is reported, never silently ignored.
4. **Fail closed** — any audit error, missing list, or malformed list entry refuses the load.
5. **Identity scoping** — the approved list is keyed by lane/proto ref; an entry for one ref never approves another.
6. **State over time** — the recorded verdict carries the list version, so a later list change is visible.
7. **Who wrote it** — each approved entry must carry the operator ruling quote and date, or it is rejected.
