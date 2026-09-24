---
bornAs: x54akv4
kind: epic
parent: "3383"
status: open
relatedTo: ["3629", "3627", "3628"]
dateOpened: "2026-09-12"
tags: []
---

# Wire the remaining mechanical-harness launch kinds: build, prepare, prepare-decision, fix, ci-heal

Per we:backlog/3383-a-background-mechanical-dispatcher-replaces-the-interactive.md own 2026-09-12 delegation audit (session-update table), review is the ONLY one of 7 dispatch launch kinds actually wired to a mechanical harness -- its agent brief carries no lifecycle commands, and we:scripts/operations/review-dispatch-wrapper.mjs is the wired default path. The other six still hand the dispatched agent a full prose brief and let it drive lane-pool acquire/release, open-pr, learnings-drop, etc. itself, out of we:scripts/guard-bash.mjs verification-only coverage rather than a real denylist. This epic tracks wiring the five kinds this repo currently has a clear next-step for -- build (we:scripts/operations/deliver-item-wrapper.mjs exists, unwired), prepare/prepare-decision (no wrapper), fix (we:scripts/operations/fix-dispatch-wrapper.mjs exists, unwired, blocked on the WE_DISPATCH_KIND=fix two-spawner conflict named in the same audit), and ci-heal (no wrapper). investigation, the seventh kind, is deliberately out of scope here -- it already has its own dedicated tracking item, #3567. we:backlog/3629-review-and-fix-dispatch-should-get-the-same-minimal-context.md (fix design), #3627 (build minimal-context design), and #3628 (generalized lane-acquisition design) are the UNRATIFIED design-proposal cards this epics children build against -- they are inputs/context, not superseded or duplicated by this epic. Also note: PR #2113 (the PR that wired review, the one already-done kind) is itself currently broken -- review-gate and a test-shard CI check both FAILING as of 2026-09-11 -- a dependency concern for whichever child lands nearest it, flagged but out of scope to fix here. Each child is sized and scoped so it can be built and tested independently, tested at each seam rather than one untested batch, per the operators own stated preference.

## Cross-cutting acceptance criterion: preserve restart-survival (2026-09-12)

Every one of today's SEVEN dispatch launch kinds, including the six this epic's children wire, currently
survives a runner/supervisor restart cleanly: a dispatched agent runs as a detached `claude --bg` process, not
a child of the runner, so it is never killed by a runner restart and is simply rediscovered next tick from
`claude agents --json` + live GitHub/PR state -- nothing about it lives only in the runner's own memory. A
separate investigation confirmed this is a real, load-bearing property, and the operator wants it PRESERVED
(never regressed) by whichever wrapper mechanism each child below builds. Concretely: a wrapper must not
introduce a long synchronous/blocking command run inside the runner's own process that would be lost or
corrupted if the runner restarts mid-execution -- any real work delegated to "the mechanical layer" must still
end up as either a detached process or durable on-disk state a fresh process can pick back up, not an
in-memory promise chain inside the runner. Flagged here as a real, unresolved tension worth each builder's
attention, not resolved: `we:scripts/operations/deliver-item-wrapper.mjs`'s design, prototyped under `#3627`'s
2026-09-09 amendment, deliberately spawns its delivery agent in the FOREGROUND (no `--bg`), blocking until the
child exits, specifically so the wrapper's own blocking call is the completion signal with zero polling -- the
opposite shape from today's detached `--bg` kinds. Whether that foreground-blocking call itself runs inside the
long-lived runner process (restart-unsafe) or inside a separate, restartable per-dispatch process
(restart-safe) is exactly what each child below must get right; this card does not resolve it, only requires it
be resolved before that child's build is considered done. This same note is repeated on each of the five child
items.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
2. **Restart-survival preserved for every wired kind** — for each of the five kinds this epic covers, a runner
   restart mid-dispatch must not lose or corrupt the in-flight work; verified per-child, not just asserted here.

## Additions from 2026-09-24 incident review

This epic is the main owner of operator proposal 2 ("turn prose rules in agent briefs into mechanical code").
Two additions:

- **The wrapper writes the completion record, not the agent.** The recurring root cause on 2026-09-24 was
  agents forgetting to write their completion record, which leaves finished sessions looking alive and
  freezes reconcile (the #3721 shape). Each wrapper this epic wires should write `started` before it spawns
  the agent and `done` or `failed` from the child's exit, on every exit path. The agent may add an outcome
  note, but the record exists whether or not it remembers. Then #3721's reaper axis reads a fact the agent
  cannot skip.
- **Count what is left.** The new brief-rule ledger (4055) lists every imperative in each brief and whether
  code enforces it. Each child here should end with that count lower for its brief, and say which rules moved
  into its wrapper.
- **Proposal 5 ("workers that survive interruptions") depends on this epic plus a live dispatcher.** Daemon
  fixes can only be "filed as cards and built by the conveyor" once the build dispatcher runs unattended
  (#3984, active; the runtime-core graduation #3487) and the build kind is wired (#3645), because an in-chat
  worker dies with its chat. The restart-survival criterion above is the same property, seen from the runner's
  side.
