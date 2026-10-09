---
kind: story
size: 3
status: resolved
scope: ["we:scripts/readiness/red-main-remediation.mjs", "we:scripts/merge-gate-check.mjs", "we:scripts/lib/red-main-freeze-shared.mjs", "we:scripts/lib/merge-delivery-policy.mjs"]
dateOpened: "2026-10-09"
dateStarted: "2026-10-09"
dateResolved: "2026-10-09"
tags: []
---

# merge-gate: publish the red-main freeze marker to a shared source CI can read

The required merge-gate CI check (we:scripts/merge-gate-check.mjs, strategy github-merge-queue) FAILS CLOSED on the red-main-freeze gate because the freeze marker (we:.conveyor/red-main-freeze.json, written by freezeDispatch/unfreezeDispatch in we:scripts/readiness/red-main-remediation.mjs) lives only on the drain host. Publish every freeze/unfreeze to a shared ops/* git branch (same transport as ops/review-requests), make we:scripts/merge-gate-check.mjs read it (facts.redMain = {source, frozen, reason}), and keep fail-closed on an unreadable branch. Blocked on #4624 (red-main hold, review:changes/human) which edits we:scripts/readiness/red-main-remediation.mjs. Until this lands every PR's merge-gate is red, so the operator must not require merge-gate yet.

## Acceptance

- [A1] **Executable** — `npm run test:unit` on we:scripts/lib/__tests__/red-main-freeze-shared.test.mjs (the module does not exist before this item): a clear shared copy passes the merge-gate `red-main-freeze` gate, a simulated freeze holds it, and a missing branch / missing file / bad JSON / non-boolean `frozen` fails it closed.
- [A2] `we:scripts/readiness/red-main-remediation.mjs` `freeze`, `unfreeze`, `decide --apply` and the new `publish` write the local marker exactly as before, then publish its state to the shared branch (`we:scripts/lib/red-main-freeze-shared.mjs`, through `we:scripts/lib/git-transport-branch.mjs`). A failed publish keeps the local marker, prints the retry command and exits 1.
- [A3] The branch is the policy-cascade knob `mergeDelivery.redMainFreezeBranch` (`we:scripts/lib/merge-delivery-policy.mjs`, default `ops/red-main-freeze`, only `ops/<slug>` accepted); writer and reader resolve it the same way.
- [A4] `we:scripts/merge-gate-check.mjs` reads the shared copy once per run into `facts.redMain`; live proof: #4643 goes from `fail-closed red-main-freeze` to `pass` after the live publish.

## Non-goals

- [N1] The drain's own reader in `we:scripts/merge-ai-prs.mjs` keeps reading the local marker (held by #4624/#4631) — follow-up card x09e2bn, blocked on xx7ckd6.

## Edge cases this change must handle

1. **Untrusted text** — the shared doc is parsed as data; only a boolean `frozen` is trusted, anything else fails closed.
2. **Truncated reads** — a fetch failure or absent file is an error (fail closed), never "not frozen".
3. **Shared state files** — the branch is written only through the worktree transport (no branch switch, push pinned to exactly `refs/heads/<branch>`, no force).
4. **Fail closed** — unreadable shared copy → merge-gate `fail-closed`; failed publish → CLI exit 1 with retry hint, local marker intact.
5. **Identity scoping** — one branch per repo, named by policy; the writer refuses any non-`ops/` ref.
6. **State over time** — every publish mirrors the CURRENT local marker (not a delta), so `publish` is an idempotent repair after any missed write.
7. **Who wrote it** — the doc records `publishedAt` and `publishedBy` (host); pushes need repo write access, same trust as the other ops branches.
