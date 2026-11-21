---
kind: task
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# lane-pool branch: eight hostile-holder and race hardening items

From lane/lane-pool-branch (waived under R1085, round 2 of 2). Eight audit findings, all needing a hostile lane holder or a race; none reachable from an honest worker. Fix together:

1. `we:scripts/lane-pool.mjs:5663` — `releaseTrackedChanges` never rejects lane-owned filter drivers before status; clean filters can hide edits and execute commands, and the switch can run smudge/process filters. Reuse the existing safety checker.
2. `:5665` — Both cleanliness probes omit ignored files, while `git switch` overwrites them. An ignored file tracked by the `--from` commit can be overwritten.
3. `:5637` — Isolation checks cover the lane and `.git` directories but not ref directories; a `.git/refs/heads` symlink into the primary checkout lets the branch be created there.
4. `:5654` — Legacy leases without `ttlMinutes` use caller `--ttl-minutes` for expiry; a longer value revives an expired lease. The final ownership check repeats it.
5. `:5654` — The expiry helper trusts future `acquiredAt`/`renewedAt`; an expired lease with a future renewal passes both freshness checks.
6. `:5663` — The cleanliness helper hashes only assume-unchanged or skip-worktree entries; ordinary entries with forged index stat data rely on Git's stat cache.
7. `:5682` — Lease read, hold check and switch are separate operations with no shared lock; a takeover or new verification between them can invalidate ownership without preventing the mutation.
8. `:5670` — An explicit `--from` can switch away from an unpushed detached HEAD without preserving it under a ref.

Full verbatim audit text: the R1085 waiver request for lane/lane-pool-branch (sha bd7a827065cddd8dbbfd353f1cbc28b87eb4d2cf).

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/heavy-admission.mjs run -- node --test` on the lane-pool tests under we:scripts/__tests__/ passes with eight new negative cases, one per item above, that fail on main (filter driver refused; ignored file counted dirty; ref-dir symlink refused; legacy lease ignores caller TTL; future timestamps rejected; forged stat data caught; lock held across read, hold check and switch; unpushed detached HEAD preserved under a ref).

## Non-goals

- [N1] Does not change honest-worker behaviour of `lane-pool branch`, and does not claim to stop a holder using raw git in its own clone.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Branch names, lease fields and git config are data; refuse lane-owned drivers.
2. **Truncated reads** — Unreadable or partial lease or index state refuses.
3. **Shared state files** — Lease file is read and checked under one lock across the switch.
4. **Fail closed** — Any isolation, expiry or cleanliness doubt refuses the switch.
5. **Identity scoping** — Ownership is rechecked against the lease holder immediately before the switch.
6. **State over time** — Expiry uses the lease's own ttl and rejects future timestamps.
7. **Who wrote it** — The lane holder may be hostile; its own `.git` contents are not trusted.
