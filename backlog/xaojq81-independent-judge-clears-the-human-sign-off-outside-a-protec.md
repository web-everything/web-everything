---
kind: epic
status: open
dateOpened: "2026-10-03"
tags: []
---

# Independent judge clears the human sign-off outside a protected list

Build the ruling of decision xne1udi (operator, 2026-10-03): an independent strong-model judge from a different provider than the author may clear review:human once the reviewers accept and only the human gate remains, except on a protected list (merge/approval logic, credentials and secrets, anything weakening a security check) that always stays human. Every clearance is logged durably with reasoning and summarized in one daily digest; a kill switch turns the judge off without a PR; an N-hour wait switch exists but defaults off. The same judge also arbitrates fixer/reviewer disagreements.

The rule: `we:docs/agent/platform-decisions.md#independent-judge-clears-review-human-outside-protected-list`. The lineage: decision xne1udi.

## Slices (build order)

1. `xfnv9ay` — decision core: protected list (in the leash: merge/approval logic including the merge gate's workflows and label appliers, credentials, security checks, the ratification surfaces as class (d) — ruled by the operator 2026-10-04 — and the judge's own inputs and control modules, the last defined by a `judge-*` pattern so a later module is covered the day it lands) and the provider/actor independence check, with the author provider read from the trusted dispatch run record bound to the run window that created the PR, never PR text. Pure; exports the one protected-list check the arbiter also uses.
2. `x6e8z3o` — kill switch and default-off wait switch. Fails closed: an absent or unreadable store reads as judge OFF, at one fixed path; the operator turns the judge on with one `on` command. (Parallel with 1.)
3. `xq3kn88` — judge seat runner and the `clear-human-judge` target at the label home, including the target's ledger mapping and the `judge` block row appended there. One PR at a time, by hand. Blocked by 1 and 2.
4. `xfbj1fa` — the post-spawn decline rows and the daily digest, reading the judge rows slice 3 writes. Blocked by 3.
5. `x6prrg3` — the arbiter for fixer/reviewer disagreements, same judge seat, bounded by the same protected-list check. Blocked by 1 and 3.
6. `xfetp9j` — the conveyor pass that runs 3 and 5 each tick and the digest daily. Blocked by 3, 4 and 5, so nothing clears unattended before records and arbiter limits exist.

## Done when

1. **Executable** — every child is resolved and the conveyor's `judge-pass` dry run on the real repo lists candidates with the decision for each.
2. **Observable** — at least one real PR outside the protected list has been cleared by the judge, with its reasoning comment on the PR, its ledger record, and its line in that day's digest; and one protected-list PR shows the `protected-list` refusal. Until the cross-provider seat (`xud2hha`, `xb1e9nj`) lands, the cleared PR must be one not authored by Claude (a Codex-authored build); if none exists, the epic records that and shows the `same-provider` refusal on a Claude-authored PR instead, so it is not held open on the seat.
3. **Must** — a judge failure of any kind (spawn error, timeout, bad output, unreadable switch) leaves the PR on `review:human` (refuse). Docs, config, data and backlog changes are checked against the protected list and the secret scan the same as code.

## Known limit (answer: the cross-provider seat, `xud2hha` and `xb1e9nj`)

Most PRs today are Claude-authored. An Opus judge is the same provider, so the ruling's provider rule refuses it there, and those PRs stay human (the arbiter, `x6prrg3`, is held to the same independence rule). The ruled answer is a cross-provider Codex judge seat, with its fallback when Codex is unavailable following the configurable independence dimension; it is tracked by decision `xud2hha` (who judges Claude-authored PRs) and decision `xb1e9nj` (what stands in when the cross-provider seat is unavailable), which are one question. `xq3kn88` ships without that seat, and no slice here is blocked on it: until it lands, the live proof of the judge clearing is a PR not authored by Claude, and Claude-authored PRs show the `same-provider` refusal.
