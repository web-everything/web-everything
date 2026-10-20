---
bornAs: xcmv56f
kind: decision
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/settings/"]
dateOpened: "2026-10-19"
tags: []
---

# Should plateau-app PRs get the drain's post-accept red-team hold?

THE FACT: Today the drain lands plateauapp/plateau-app PRs 'directly (repo outside this policy)'. recordedHold and the enqueue red-team hold in we:scripts/lib/drain-merge-strategy.mjs apply to the local repo (web-everything) only, so plateau-app PRs merge without waiting for a post-accept red team. EVIDENCE: 2026-10-19 plateau-app#226. A drain dry run said 'would merge directly'. A request-only hotfix (lane/hot-plateau-redteam) now asks for red teams on plateau-app PRs but does not wait for them. OPTIONS: (a) apply the same hold to plateau-app, as a per-repo cascade setting redTeam.holdRepos (we:scripts/settings/); (b) keep plateau-app exempt, as the product repo with a different risk profile; (c) hold only for certain paths (daemon or tooling code under plateau-app tools/). QUESTIONS: which care level applies to plateau-app PRs, and is the red-team cost (Claude usage) acceptable for product PRs? RELATED: the review-stringency decision xugqjw1 (classes and levels) and the delivery-modes epic xc4ft34.

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
