---
bornAs: xhetzpl
kind: task
parent: "2405"
status: resolved
scope: ["we:scripts/lib/pr-state-io.mjs", "we:scripts/review-ledger-check.mjs"]
dateOpened: "2026-10-09"
dateResolved: "2026-10-09"
tags: []
---

# readPrFacts reads only web-everything, so review-ledger-check scores every frontierui and plateau-app PR as unreadable

Found building #3930 on 2026-10-09: we:scripts/lib/pr-state-io.mjs hard-codes REPO = CONSTELLATION_REPOS.we.slug, and we:scripts/review-ledger-check.mjs passes readFacts = () => null for other repos. Live run: plateauapp/plateau-app had 1 open PR, counted unreadable, so --history marks that day '?' for every family. A clean week across the constellation is impossible while either repo has an open PR. Fix: readPrFacts(pr, { repo }) uses the given slug; the checker passes it for every repo. Done when: a test asserts the gh argv carries the plateau-app slug when repo=plateauapp/plateau-app, and a live 'node we:scripts/review-ledger-check.mjs --repo=plateauapp/plateau-app' reports unreadable 0.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/pr-state-io.test.mjs we:scripts/__tests__/review-ledger-check.test.mjs`: the "reads the repo it is given (5660)" tests fail before (the gh argv carried web-everything; the checker passed no repo) and pass after.
- [A2] **Live** — `node we:scripts/review-ledger-check.mjs --repo=plateauapp/plateau-app --json` reported `unreadable: 1` for plateau-app PR 220 before, and `unreadable: 0` after, with plateau-app's own required checks (test, e2e) read green.

## Non-goals

- [N1] Scheduling the checker (that is 5663). `readCardFacts` stays WE-only: nothing asked it to cross repos.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — unchanged: PR strings still pass through `cleanText`/`stripTerminal`; the repo value is resolved through `repoKeyForSlug`, never interpolated raw.
2. **Truncated reads** — unchanged per repo: rollup and comment caps still mark checks unknown, never missing.
3. **Shared state files** — the daemon logs are shared by all repos: for a non-WE PR a line must also name that repo, so WE's PR with the same number never leaks in.
4. **Fail closed** — an unknown repo throws (the checker turns that into an unreadable row), never a silent WE read.
5. **Identity scoping** — sessions and fix claims are keyed by the repo key; a non-WE PR matches only its own minted session names or an absolute link to its own slug.
6. **State over time** — an unreadable branch-protection probe falls back to that repo's own declared policy (`DECLARED_REQUIRED_STATUS_CHECKS`), not WE's.
7. **Who wrote it** — n/a: no new trust decision; advisory comments keep the existing trusted-author filter.
