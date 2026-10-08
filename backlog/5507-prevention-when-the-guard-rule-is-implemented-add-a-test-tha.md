---
bornAs: xy78cxk
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5503-migrate-repo-slug-call-sites.md", "we:backlog/5502-repo-identity-registry-and-guard.md", "we:backlog/5504-org-rename-runbook.md"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — When the guard rule is implemented, add a test that runs it against the tree and asserts that eve… (from web-everything/web-everything#4506 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5503-migrate-repo-slug-call-sites.md:4` — When the guard rule is implemented, add a test that runs it against the tree and asserts that every allowlist entry's file is in 5503's scope. Add a one-line match-semantics sentence (code vs comment, account names exempt) to 5502.
2. `we:backlog/5502-repo-identity-registry-and-guard.md:41` — Add to the card template's fail-closed edge case: 'enumerate every identity state (current, previous-only, unknown) and name a test for each'. For the shim, a table-driven test over all three states.
3. `we:backlog/5503-migrate-repo-slug-call-sites.md:29` — A check:standards rule that flags any new `process.env`/`os.environ` read in the daemon paths unless it is on an allowlist. Also require that cards introducing a test-only seam name the test showing the seam is inert in production.
4. `we:backlog/5502-repo-identity-registry-and-guard.md:39` — State in A5/A7 that an unresolvable base fails the test rather than skipping it. Compare allowlist entries as a set (no new entries), not just count.
5. `we:backlog/5503-migrate-repo-slug-call-sites.md:24` — Add an acceptance item requiring a first workflow step that fails when `vars.FUI_REPO` is empty, and extend the guard to flag `repository: ${{ vars.* }}` without that assertion.
6. `we:backlog/5502-repo-identity-registry-and-guard.md:49` — Add the planned two-repository regression test to the implementation acceptance gate.
7. `we:backlog/5504-org-rename-runbook.md:53` — Add a deterministic configuration-read failure test to the remote-rewrite implementation gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4506@fce8cfa3d0b03b09318cfac9218a00f00ee2f600

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
