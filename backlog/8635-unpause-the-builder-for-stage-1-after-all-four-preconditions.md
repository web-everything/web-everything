---
bornAs: xygar78
kind: decision
parent: "2445"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, plateau-app]
relatedTo: ["2445"]
preparedDate: "2026-11-20"
---

# Unpause the builder for stage 1 after all four preconditions?

Ask: Give conditional approval for one small Codex build only after all readiness proofs pass. Decide whether the old audit-scope setting and newer builder brief remain prerequisites.

## Digest

**Not yet; conditional go once named proofs exist.** This is a readiness gate accepted on merit, not a new design fork. Prep's 2026-11-20 21:40 snapshot had 0/4 initial conditions met and builder caps 0/0; later 22:00 update found priority-tool PR #7268 open. Historical status is not live authorization.

## What you're deciding

Stage 1 only: Claude 0 / external Codex 1 / max open PRs 10, one item size ≤3. R981 reverted unpause and requires its checklist; R1054 prioritizes restoration, not bypass. Stage 2 needs a new ruling.

## Recommendation — conditional go, not immediate unpause

**Default: remain paused until every proof exists**, then orchestrator sets 0/1/10, reports proofs at flip and restores caps 0 on rollback triggers.

1. Only-mode fix PR #7247 merged, merge SHA recorded. Prep found it open/changes/red-team blocked at e04c73013f; off-list prepares and expired list use had occurred that day.
2. Prepare-refusal stop PR #7251 merged or prototype-loaded, with installed-state log line. Prep found open at 1ebcb27a6a; check-conflict serialized it after #7247.
3. Validated build-priority-set operation merged. Initially no PR; later prep update records #7268 open. Requires atomic validated write, TTL ≤168 h and ids present on main.
4. Four-id list installed (6893/7323/4489/6966), proven by tick log, not a file claim. Previous list expired 08:03 ET.
5. Fresh 24 h stage-0 soak after fixes: listed ids only, no repeat prepares, list change honoured within one tick.
6. Operator keeps or drops G2 (R968 audit-scope/#6989) and G3 (proposed builder brief) explicitly. Do not silently waive them.

Excluded: go before proofs; off-list builds and repeated-refusal loops remain possible. “Fresh go later” and “conditional go now” differ only by round trip; R981 already permits checklist-triggered go.

## Context and prior-art delta

- Progressive/canary rollout with pass/rollback criteria is the precedent. WE adds shared scope admission against running workers and open PRs (R1055).
- Pass: clean PREP/audit/verify PR and no collision. Roll back on unfixed WEAKENED, collision, double or stale build; restore plist backup.
- G2 prep gap: #6989 closed unmerged; no audit-scope/invariantsHash code found on main. G3: #7085 merged but proposed brief still differs by 83 lines. Only operator decides whether these count.
- Sources: `we:builder-revival.md:22-32`, `builder-only-mode-prepare-prep`, `runtime-list-install-prep`, `s0-check-scope-pr1-prep`, `delivery-agent-brief.proposed`, `build-queue`, `we:rulings.md:2330` (R981), `rulings-active` R1054/R1055.

Skeptic: SURVIVES as historical not-yet evidence; rechecked PRs and caps. Screen: flagged(prio) → readiness/batch-confirm, no independent merit fork. Readiness prerequisites should acquire real backlog edges when corresponding cards are identified; PR numbers above are PRs, not invented card ids.

## Supported by default

Preserve priority fixer → blockers → builder. Shared scope/capacity checks still apply; installed-state evidence is stronger than merge alone. G2/G3 need explicit operator disposition.

## What ratifying unlocks

Conditional stage-1 start after proofs, with no second go required; “D16 yes” plus G2/G3 decisions makes the trigger mechanical. This cards-only task changes no caps or runtime list.

## Trust boundary and threat model

Builder output/PR text/runtime list are untrusted. Freeze proof SHAs and timestamped logs at flip; no moving-branch rereads, silence or elapsed-time approval. Stage 2 and larger caps are out of scope.

Full prep (Standards decisions-prep set):

```text
D16-xygar78.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
D16-xygar78.md
build-queue.md
builder-only-mode-prepare-prep.md
delivery-agent-brief.proposed.md
rulings-active.md
runtime-list-install-prep.md
s0-check-scope-pr1-prep.md
```
