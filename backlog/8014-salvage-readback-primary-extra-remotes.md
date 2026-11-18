---
bornAs: x98henb
kind: story
size: 3
status: active
scaffoldedBy: "fix-6319"
dateScaffolded: "2026-11-06"
scope: ["we:scripts/lib/lane-pool-salvage-push.mjs", "we:scripts/lib/__tests__/lane-pool-salvage-push.test.mjs"]
dateOpened: "2026-11-06"
tags: []
---

# Salvage read-back (remoteSha) refuses ordinary non-origin remotes in the operator primary

realSalvageIo().remoteSha runs ls-remote in the primary checkout (repo.referencePath) through transportGit, which applies the LANE transport rule: any remote not named origin (upstream, a fork), a local credential helper, or signing keys in the primary make every salvage read-back throw 'lane-controlled transport configuration', so salvage fails and release refuses the lane. PR 6319 gave the release proof (remoteHeads) a primary-only rule but kept remoteSha strict on purpose, because main pins remoteSha's strict rule in the alias-isolation and unattended-transport suites, which run with referencePath set to a lane. No present instance: the operator primary has only remote.origin today. Decide whether referencePath is operator-trusted for salvage; if yes, give remoteSha the remote-name half of the primary rule (keep credential/signing/per-remote transport keys refused) and update those pins explicitly with a recovery-on release test whose primary has an upstream remote. Found by the PR 6319 fix self-review.

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
