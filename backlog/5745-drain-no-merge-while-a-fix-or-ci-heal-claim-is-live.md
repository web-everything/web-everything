---
bornAs: xh8442i
kind: task
parent: "5767"
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Drain: no merge while a fix or ci-heal claim is live

Slice S6a of the async-daemons epic (S3t needs it). we:scripts/merge-ai-prs.mjs merges with `--match-head-commit` (around :5950) but ignores live fix claims. Add a read-only claim check (no claim write, per R4) next to the existing `--match-head-commit`: a live fix or ci-heal claim defers the merge with a `claim-held` skip reason.

## Acceptance

- [A1] **Test (a)** — a push races a merge and `--match-head-commit` refuses it.
- [A2] **Test (b)** — a live claim defers the merge with a `claim-held` skip reason (J2-10, J2-22).
- [A3] **Live** — one `claim-held` skip seen in `daemon.log`.

## Non-goals

- [N1] Writing or taking the claim from the drain (R4 keeps the drain read-only here).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the claim file is daemon-written; no external text is read.
2. **Truncated reads** — An unreadable claim file defers the merge (treated as held), it never merges.
3. **Shared state files** — Read-only access to the claim store; no write, no lock taken.
4. **Fail closed** — Fail closed: an error reading the claim defers.
5. **Identity scoping** — The claim is keyed by repo and PR number.
6. **State over time** — A claim past its TTL and not quarantined does not block; a quarantined claim does.
7. **Who wrote it** — n/a: the drain only reads claims written by the fixer.
