---
bornAs: xemmhmy
kind: story
size: 3
status: open
scope: ["we:scripts/lib/clone-maintenance.mjs", "we:scripts/lib/daemon-self-sync.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Daemon clone maintenance residuals (#6853, #6860)

#6853: buildLeaseIsLive fails open on aged or malformed startedAt and malformed leases; equal git-dir paths do not exclude alternates; gc.pruneExpire is inherited from git config (pin -c gc.pruneExpire=2.weeks.ago); corrupt-state tests do not discriminate. #6860: an exit-128 config read gets the override even on config-access failures; the busy check misses external git with an absolute --git-dir and no index.lock; the runner does not check object borrowers (helper in we:daemon-self-sync.mjs would create an import cycle). Also find who set gc.pruneExpire=gc.auto on the fix clone config.

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
