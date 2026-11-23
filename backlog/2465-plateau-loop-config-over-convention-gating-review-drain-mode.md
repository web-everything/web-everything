---
bornAs: x8wagm6
kind: story
size: 8
parent: "2445"
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: the #3119 split is done and plan step DZ-SETTINGS exists."
dateParked: "2026-11-22"
priority: low
dateOpened: "2026-07-12"
tags: []
---

# Plateau Loop: config-over-convention — gating / review / drain / model as platform config

Turn today's convention-encoded policy (gating, review escalation, drain policy, model choice) into inspectable, editable platform config, wired to the operable console. Deferred behind the phase-1 evidence gate — parked, pickable.

## Prep assessment (2026-08-15) — NOT build-ready as scoped; recommend split

Verified against live code before preparing this as one story (checklist item 8). Two findings, both grounded
in `path:line`, converge on "this card's premise is now stale and its four axes no longer share one shape":

1. **The "deferred behind the phase-1 evidence gate" framing is stale.** That gate ([#2456](/backlog/2456-review-the-drain-daemon-s-first-weeks-of-operating-evidence/),
   still `status: open` — the "few weeks unattended" bar is not met) governed
   [#2444](/backlog/2444-plateau-loop-phase-1-agent-runner-shape-cli-spawn-contract-s/) and
   [#2446](/backlog/2446-where-does-plateau-loop-live-plateau-app-module-own-repo-or-/). #2444 was
   independently un-deferred and ratified 2026-07-16 (a different consumer,
   [#2530](/backlog/2530-build-endpoint-supervised-builder-post-api-backlog-build-dra/), greenlit it — see
   #2444's "Un-deferred + prepared" note) and #2530 shipped (plateau#61, `plateau:src/build-runner/runner.ts`,
   `plateau:src/build-runner/build-action.ts`). Phase 1's runner/builder already exists; "wait for evidence"
   is no longer why this card can't move.
2. **Two of the card's four axes already shipped as config, under different epics, after this card was
   filed (2026-07-12).** Handing this card to a builder unchanged risks a redundant rebuild of work that's
   already live:
   - **Gating** is already explicit, versioned config: `we:scripts/lib/gate-config.mjs` (#2448) is the single
     source of truth for the trust-chain tiers (`isPolicyCorePath`/`isGateSelfPath`), split into a
     `leash: 'spec'` (declarative, always `review:human`) vs `leash: 'derivation'` (agent-clearable) tier per
     `we:docs/agent/platform-decisions.md#review-human-declarative-leash-only` (#2771/#2785).
   - **Review escalation** is already a machine-diffable DATA contract: `we:scripts/lib/review-policy.contract.json`
     declares the rubric thresholds, escalation-reason vocabulary, and disposition table as versioned JSON
     (#2566/#2563/#2564); `we:scripts/lib/review-escalation.mjs` derives from it and a conformance suite proves
     the derivation matches. "A diff to it trips the policy-tier path test" — it is already inspectable and
     already gated.
   - **Drain policy** is only PARTLY config: `plateau:tools/drain-daemon/lib.mjs:36-50` (`resolveConfig`)
     already reads `DRAIN_DAEMON_INTERVAL_SEC`/`_MAX_BACKOFF_SEC`/`_PASS_TIMEOUT_MIN`/`_HEARTBEAT_SEC`/`_PORT`
     from env — but the qualitative thresholds that actually decide degraded/stuck are still hardcoded module
     constants with no override: `STALL_WARN_PASSES`/`STALL_CRIT_PASSES` (`plateau:tools/drain-daemon/lib.mjs:405-406`),
     `FAIL_WARN_COUNT`/`FAIL_CRIT_COUNT`/`TIMEOUT_WARN_COUNT` (`:415-418`), `PARK_STALE_PASSES`/`CONSIDERED_NEVER_MERGED_PASSES`
     (`:419-420`). This axis is genuinely still convention.
   - **Model choice** is genuinely still convention — worse, it's unbuilt. `RunnerTask.model`
     (`plateau:src/build-runner/runner.ts:36-37`) and `BuildFlowOpts.model` (`plateau:src/build-runner/build-action.ts:131-132`)
     are plumbed all the way to `--model` on the CLI spawn (`plateau:src/build-runner/runner.ts:90`), but
     **nothing ever sets them** — grepped every caller of `runBuildFlow`/`BuildFlowOpts` in `plateau:src/`;
     the only two hits are the module itself and its test. There is no config source, no env var, no console
     control.
   - Checked the console for a policy-CONFIG surface (not per-PR escalation-outcome text, which
     `plateau:tools/dev-panel/drain-daemon.html:542-543` already shows read-only): none of
     `we:scripts/lib/gate-config.mjs`, `we:scripts/lib/review-policy.contract.json`, the `DRAIN_DAEMON_*` env
     vars, or model choice is referenced anywhere under `plateau:tools/dev-panel/` or `plateau:src/backlog-view/`.
     **The "wired to the operable console" half is 100% unbuilt for all four axes** — that part of the
     premise still holds.

**Why this blocks preparing #2465 as one story (checklist item 4 — decided design, not a menu):** the four
axes no longer share a mechanism. Two are already data-driven contracts with their own human-gated write path
(gating, review escalation — editing them from a console re-opens the self-gating invariant,
`we:docs/agent/platform-decisions.md#review-human-declarative-leash-only`, which is its own design call, not
assumable here). One is partially env-config, partially hardcoded constants (drain). One has no config
surface at all (model). A single "make it all platform config" story would either silently re-decide the
gating self-gating question or skip it and under-deliver — exactly the buried-fork failure mode item 4
exists to prevent. This needs to be split before it can be prepared to build-ready; see the follow-up item
filed for the recommended slice breakdown.

Parked 2026-11-22 (plateau ruling, master plan; premise stale per its own prep note). Unpark when: the #3119 split is done and plan step DZ-SETTINGS exists. Parked, not blockedBy, because the trigger is partly a plan step.
