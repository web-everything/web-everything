---
bornAs: x8zfjb5
kind: story
size: 8
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/operations/"]
dateOpened: "2026-10-18"
tags: []
---

# Hotfix lane: one fix, one daemon, minutes to live, auto-expiring

Command. One declared operation, hotfix --daemon=<name> --branch=<lane/...> --reason --by, does a scoped guard audit, then the load, the adoption check and a proof line. Scope. One fix for one daemon on its own small branch; refuse a branch that touches files outside that daemon's entries plus shared libs it declares. Scoped audit. The guard audit runs on that diff only (minutes); its only hard stop is a weakened guard or hold. Code quality and test depth may be minimal (quick and dirty), but a weakened merge guard is never allowed. Fast start. Loads with emergency fast start and blue-green warm rollback (cards xgyj0q6 and xd6bq9f) once those exist; until then, the normal overlay load. Expiry. Auto-expires after hotfix.ttlHours (default 24, source logged): the overlay is removed and the daemon reloaded unless a graduation PR referencing it is open and green, or merged. Logging. Every hotfix is logged with who, why, daemon and expiry, and shows in the needs-you feed when within 2 h of expiry. Evidence. On 2026-10-18, prototype batch 4 bundled fixes for 4 daemons. Four audit rounds of about 1 h each found weakenings in unrelated features, and the red-team request fix and conflict resolver (about 45 PRs blocked) waited more than 5 h. A drain-only batch (b5) was audited clean in about 40 min. Related cards: xd6bq9f and xgyj0q6.

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
