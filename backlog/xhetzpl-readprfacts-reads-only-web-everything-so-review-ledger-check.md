---
kind: task
parent: "2405"
status: open
scope: ["we:scripts/lib/pr-state-io.mjs", "we:scripts/review-ledger-check.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# readPrFacts reads only web-everything, so review-ledger-check scores every frontierui and plateau-app PR as unreadable

Found building #3930 on 2026-10-09: we:scripts/lib/pr-state-io.mjs hard-codes REPO = CONSTELLATION_REPOS.we.slug, and we:scripts/review-ledger-check.mjs passes readFacts = () => null for other repos. Live run: plateauapp/plateau-app had 1 open PR, counted unreadable, so --history marks that day '?' for every family. A clean week across the constellation is impossible while either repo has an open PR. Fix: readPrFacts(pr, { repo }) uses the given slug; the checker passes it for every repo. Done when: a test asserts the gh argv carries the plateau-app slug when repo=plateauapp/plateau-app, and a live 'node we:scripts/review-ledger-check.mjs --repo=plateauapp/plateau-app' reports unreadable 0.

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
