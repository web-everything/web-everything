---
kind: decision
size: 3
status: resolved
scaffoldedBy: "decision-collector-pr"
dateScaffolded: "2026-10-18"
dateOpened: "2026-10-18"
dateResolved: "2026-10-18"
codifiedIn: "docs/agent/platform-decisions.md#collector-pr-card-batching-streams"
preparedDate: "2026-10-18"
preparedAgainstSha: "257b2769a9a288323e9c3dab6a5afaf22c1e885c"
relatedTo: ["4703", "6250"]
relatedReport: reports/2026-10-18-collector-pr-per-stream-card-batching.md
tags: [card-batch, pr-flow, prevention, decision]
---

# Decision: collector PRs batch card-only filings per stream (count or age flush)

Operator 2026-10-18 "Ok", verbatim idea: "group more finding in a single pr, could have a parked pr that collect those and merge once a count or delay is reached, then a new one take over."

## Ruling

**Ruled 2026-10-18 by the operator (Nicolas Gilbert), in conversation.** Verbatim: *"All ok"*, in answer to the card's recommended defaults. The rule is codified at [we:docs/agent/platform-decisions.md#collector-pr-card-batching-streams](../docs/agent/platform-decisions.md#collector-pr-card-batching-streams). The prepared text below is kept as the lineage; where it differs from this section, this section wins.

- **Fork 1 = (a).** Streams `prevention` and `filing` (follow-up and expedite cards fold into `filing`), plus `ruling` declared and disabled.
- **Fork 2 = (a).** Count and age, count wins a tie. Prevention 10 / 120, ruling 8 / 60, filing 10 / 60.
- **Fork 3 = (a).** Expedite cards bypass the collector via `highPriorityBypass`.
- **Fork 4 = (a).** A card with a blocking finding is extracted to its own PR; it is never re-queued.
- **Fork 5 = (a).** Every member is numbered at seal, before the PR is marked ready.
- **Fork 6 = (a).** The coordinator owns the collector branch and retires a stuck sealed state from GitHub truth.

**Build:** epic x87psvt. First slice, top priority (unblocking): x5nmdnt, the self-heal (live case: prevention batch 9 sealed since 2026-10-14, 327 cards spooled). Then x1mmp60 (numbering at seal), x245i7o (resumable seal timeout), xf1z2w3 (age escape), xpabefb (ruling stream declared, follow-up and expedite folded into filing), x7nf3f5 (ruling filer wired and the stream enabled; the Fork 1 skeptic amendment).

## Digest

**Most of this already exists.** Epic #4703 shipped rolling card-only PRs: kinds `prevention`, `filing`, `prepare` ([we:scripts/lib/card-batch-policy.mjs:5](../scripts/lib/card-batch-policy.mjs)), a count-or-age seal where count wins ([we:scripts/lib/card-batch-policy.mjs:71](../scripts/lib/card-batch-policy.mjs)), a high/urgent bypass ([we:scripts/lib/card-batch-policy.mjs:82](../scripts/lib/card-batch-policy.mjs)), a held draft PR ([we:scripts/operations/card-batch-seal-io.mjs:265](../scripts/operations/card-batch-seal-io.mjs)), and per-card extraction of a review-rejected member ([we:scripts/operations/card-batch-extract.mjs:1](../scripts/operations/card-batch-extract.mjs), routed at [we:scripts/conveyor/reconcile-core.mjs:3594](../scripts/conveyor/reconcile-core.mjs)). Settings already cascade with their source logged ([we:scripts/lib/card-batch-settings.mjs:1](../scripts/lib/card-batch-settings.mjs), [we:scripts/settings/prevention-batch.json](../scripts/settings/prevention-batch.json)). Shipped defaults: prevention 10 cards / 120 min, filing 10 / 60, prepare off.

**Why it did not save the overnight PRs: the prevention collector has been stuck since 2026-10-14.** Batch 9 (PR 5272) merged, but its state file kept `sealedAt` at seal step `ready`: the seal job timed out before `label-on-green`, and only that step retires a state ([we:scripts/operations/card-batch-seal-io.mjs:88](../scripts/operations/card-batch-seal-io.mjs)). Admission then refuses every card with `batch-sealed` ([we:scripts/operations/card-batch.mjs:57](../scripts/operations/card-batch.mjs)) and the filer spools it ([we:scripts/operations/land-prevention-card.mjs:607](../scripts/operations/land-prevention-card.mjs)). Measured 2026-10-18 08:06 ET: 327 spooled cards, all with reason `coordinator refused: batch-sealed`; the last real batch merged 2026-10-14. The 109 `prevention-card` PRs merged since came from fallback and other filer paths.

**Not absorbed: the rule-file conflicts.** PRs 5515, 5524, 5527, 5532 each edit one shared check file. Those are code, and "code never joins a collector". Card 6250 (not "372": that number is the loan data table) keeps that half; the card-filing half of 6250 is covered by the collector.

**Carved child (build, not a fork): self-heal a sealed collector.** A sealed state whose PR is merged or closed on GitHub retires itself (GitHub is the truth; a batch closed without a merge or a split is archived and its members surfaced to the operator, so no card is dropped silently), a seal-job timeout becomes resumable with bounded retries then a held reason, and a batch held for an unextractable finding gets an age escape, so none of these can block admission again. Proof required: before/after on the live 327-card spool draining into a fresh batch. Predicted scope: `we:scripts/operations/card-batch-seal-io.mjs`, `we:scripts/operations/card-batch.mjs`, `we:scripts/operations/card-batch-io.mjs`. Filed separately after this ratification; the forks below do not depend on it.

## Recommended path at a glance

| Fork | Question | Recommended default | Main alternative (excluded) | Confidence |
| --- | --- | --- | --- | --- |
| 1 | Which streams | **Keep `prevention` + `filing`; fold follow-up and expedite cards into `filing`; add `ruling` as a declared kind (enabled once a filer routes to it)** | One shared pool for all cards | High |
| 2 | Flush rule and defaults | **Count AND age (shipped, count wins); keep the ratified 10/120 for prevention; `ruling` 8/60; `filing` stays 10/60** | Count-only or age-only | High |
| 3 | Expedite cards | **Skip the collector (shipped `highPriorityBypass`)** | A short-age collector for expedite | Medium |
| 4 | Ejection | **Extract the bad card to its own PR (shipped); do not re-queue it** | Eject into the next collector | High |
| 5 | Card numbering and the merge queue | **Number all members once at seal, before ready (statute #3732); sealed batch queues normally** | Number at admit; or leave hash names for the drain (superseded rule) | Medium |
| 6 | Who owns the collector branch | **The coordinator (lease + state file), made self-healing against GitHub; neither filer nor drain** | Drain owns it; each filer owns its own | Medium |

## Fork 1 - Which streams

**Fork exists because** each stream needs its own flush clock and review risk (a ruling is a human decision, a prevention card is a mechanical rule); one pooled collector would flush on one clock and make a ruling wait behind, or ride with, unrelated mechanical cards.

- **(a) Keep the shipped kinds, fold follow-up and expedite cards into `filing`, add `ruling` (default).** Follow-ups and expedites are filings by origin. Rulings are already hand-batched today (`lane/rulings-1018-cards`, `lane/morning-1018-cards` are open PRs), which is the stream the collector does not yet serve. The one code change: add `ruling` to `CARD_BATCH_KINDS` and the policy JSON.

  ```js
  // we:scripts/lib/card-batch-policy.mjs:5 - the stream list is the only place a stream is declared
  export const CARD_BATCH_KINDS = Object.freeze(['prevention', 'filing', 'prepare', 'ruling']);
  // we:scripts/lib/card-batch-policy.json - one new block, same shape as the others
  // "ruling": { "enabled": false, "maxCards": 8, "maxAgeMinutes": 60, "highPriorityBypass": true }
  ```
- **(b) Add separate `followup` and `expedite` kinds.** *Rejected* - they share the filing reviewer and the filing clock; two more collectors means two more open PRs at any time, which is the opposite of the goal.
- **(c) One pooled collector for every stream.** *Rejected* - see the fork-existence line.

Skeptic: SURVIVES-WITH-AMENDMENT -> `ruling` is a policy knob plus one list entry, and no filer routes to it yet. Amendment folded in: the carved child (or a second one) must wire the ruling filer to the collector, otherwise `ruling` stays declared and unused; until then the default is to declare it with `enabled: false`.
Screen: flagged(impl) -> the reviewer saw tooling config, not a standard-side concern; fix applied: scope stated as WE's own delivery tooling (nothing crosses the WE-FUI boundary), and only `ruling` is a real new stream, so the fold-in of follow-up and expedite is recorded as the default, not a contested branch.

## Fork 2 - The flush rule and its defaults

**Fork exists because** count-only strands a quiet stream forever and age-only lets a busy stream grow without bound, so "both" is a forced invariant. Only the numbers are open, and they are settings, so the pick is a default, not a lock.

- **(a) Count and age, whichever first, count wins a tie (default; shipped at [we:scripts/lib/card-batch-policy.mjs:71](../scripts/lib/card-batch-policy.mjs)).** Keep prevention at the operator-ratified 10 cards / 120 minutes (#4703 re-preparation, 2026-10-06). New `ruling` at 8 / 60 (low volume, human readers). Overnight volume was 52 PRs in roughly 10 hours, about 5 per hour, so 10 / 120 gives about one PR per two hours; 8 / 60 would give one per hour and twice the CI.
- **(b) Use the operator's example 8 / 60 for prevention too.** *Not the default* - twice the PRs for the same cards. One setting change if wanted; the cascade logs its source.
- **(c) Count-only or age-only.** *Rejected* - see the fork-existence line.

Skeptic: SURVIVES -> a settings pick, not a lock. The "52 PRs in about 10 hours" figure is the operator's evidence, not measured here; the numbers stay settings.
Screen: flagged(prio) -> count AND age is a forced invariant; only the numbers are open and they are settings. Fix applied: the fork ratifies the invariant and the shipped defaults; the 8/60 example stays a one-line setting change.

## Fork 3 - Expedite cards

**Fork exists because** an urgent card cannot both wait for a flush and be urgent, so it either skips the collector or the collector flushes early for it.

- **(a) Skip the collector (default; shipped).** `bypassesBatch` returns true for `high` and `urgent` ([we:scripts/lib/card-batch-policy.mjs:82](../scripts/lib/card-batch-policy.mjs), used at [we:scripts/operations/card-batch-file.mjs:52](../scripts/operations/card-batch-file.mjs)). A card-only PR takes the light CI path, so a lone urgent card is cheap.
- **(b) A short age (for example 10 minutes) for expedite.** *Rejected* - it is a second collector per stream, open at the same time as the first, and still makes an urgent card wait.
- **(c) No expedite concept.** *Rejected* - an urgent card would sit up to the full age.

Skeptic: SURVIVES -> ratifies shipped behaviour; Medium confidence because no expedite volume was measured.
Screen: flagged(prio) -> shipped as `highPriorityBypass`; option (b) is dominated. Fix applied: the fork is a ratification of shipped behaviour and says so; no new build.

## Fork 4 - Ejection of a card with a blocking finding

**Fork exists because** the operator's `ejectOnFinding` sends the card to the next collector, but a card with a known blocking finding re-admitted to a batch poisons that batch too; the two ends cannot both hold.

- **(a) Extract it to its own PR, parked `review:changes`, and re-seal the rest (default; shipped).** The fix loop owns it from there. A finding that names no single card file, or several, holds the batch for a person ([we:scripts/operations/card-batch-extract.mjs:7](../scripts/operations/card-batch-extract.mjs)). No new setting is needed: ejection is always on, because the alternative is a sunk batch.
- **(b) Eject into the next collector.** *Rejected* - the card is still bad; it fails the next review and ejects again, forever.
- **(c) Close the whole batch.** *Rejected* - sinks good cards for one bad one.

Skeptic: SURVIVES-WITH-AMENDMENT -> a finding that names no single card file, or several, holds the batch for a person and can stall it. Amendment folded in: stated in option (a); the hold has no age escape today, so the carved child should also bound it.
Screen: flagged(impl) -> shipped, and option (b) loops forever. Fix applied: kept as a ratification of shipped behaviour with the loop named as the excluded branch; no new setting.

## Fork 5 - Card numbering and the merge queue

**Fork exists because** the ratified rule ([#backlog-ids-numbered-before-publish](../docs/agent/platform-decisions.md), #3732) makes the producer number hash cards before the first push for review, and a required `backlog-ids` check refuses hash-named paths on the tip tree. A collector holds cards for up to two hours, so numbering them at admit and numbering them at seal are two different moments and cannot both be the rule.

- **(a) Number every member at seal, before the PR is marked ready (default).** Members stay hash-named while the held draft accumulates (a draft is not yet "for review"). The seal job calls the declared numbering operation once over the whole branch, so N cards are numbered in one pass and sibling references resolve together; numbering rewrites the head, which is fine because verify already runs once, on the sealed head ([we:scripts/operations/card-batch-seal-io.mjs:174](../scripts/operations/card-batch-seal-io.mjs)). It fails closed: if numbering fails, the batch stays held and never reaches ready. The shortest window between allocation and landing keeps number clashes rare; uniqueness is still guaranteed where main is written (statute rule 1). The collector therefore needs the numbering step added; today the seal steps are `record-sealed, verify, remove-hold, ready, label-on-green` ([we:scripts/operations/card-batch-seal.mjs:25](../scripts/operations/card-batch-seal.mjs)).

  ```js
  // we:scripts/operations/card-batch-seal.mjs - add one named boundary before verify
  const steps = ['record-sealed', 'number-members', 'verify', 'remove-hold', 'ready', 'label-on-green'];
  ```
- **(b) Number each card at admit.** *Rejected* - numbers are held for up to two hours, so they clash with other lanes' allocations more often, and each admit becomes a numbering run under the land mutex.
- **(c) Leave hash names and let the drain number at land.** *Rejected* - that is the superseded #2288 behaviour the statute replaced; the `backlog-ids` check would refuse the sealed PR.

Queue position: a sealed batch queues like any PR. While open it is a labelled draft; the drain skips drafts and the promote-draft pass respects the hold label ([we:scripts/conveyor/reconcile-core.mjs:228](../scripts/conveyor/reconcile-core.mjs), [we:scripts/merge-ai-prs.mjs:2346](../scripts/merge-ai-prs.mjs)). No queue privilege: a card-only PR has no code conflicts, so priority buys nothing.

Reuse note: the collector is **not** a stack. [we:scripts/conveyor/pr-stack.mjs:99](../scripts/conveyor/pr-stack.mjs) (`detectStacks`) handles one PR containing another's head; a collector is one branch with one commit per card. The file-claim registry ([we:scripts/operations/free-scope.mjs:61](../scripts/operations/free-scope.mjs), `registerScope`) matters for the 5515-5532 code conflicts, not for cards.

Skeptic: REFUTED as first drafted ("no change, the drain numbers at land" cited the stale #2288 comment at [we:scripts/backlog.mjs:730](../scripts/backlog.mjs) and collided with statute #backlog-ids-numbered-before-publish). Default flipped to number-at-seal and the rationale rewritten against the statute; no codifiedIn is set by this fork beyond a rider, so the overlap is reconciled in the item now.
Screen: flagged(impl) -> tooling internals, invisible across the WE-FUI boundary. Fix applied: kept because the statute above makes numbering moment a ruled choice and the collector must state its place in it; ratifying it is one rider line.

## Fork 6 - Who owns the collector branch

**Fork exists because** one branch cannot have two writers: the lease holder appends, and only one party may seal and retire.

- **(a) The coordinator owns it (default; shipped).** Filers call `admitCard` under a per-kind lease with an expected-head check ([we:scripts/operations/card-batch-io.mjs:61](../scripts/operations/card-batch-io.mjs)); the seal job and the health-watch tick seal. Add one rule: a sealed state whose PR is merged or closed on GitHub is retired on the next admission (the carved child above).
- **(b) The drain owns it.** *Rejected* - the drain is the single writer to main; making it also a branch appender mixes two jobs and makes the drain a filing dependency.
- **(c) Each filer owns its own batch.** *Rejected* - that is one PR per card again.

Skeptic: SURVIVES-WITH-AMENDMENT -> root cause is the seal job timing out (`spawnSync` ETIMEDOUT) and leaving step `ready` terminal; retiring against GitHub only masks that. Amendment folded in: the carved child also makes a seal timeout resumable (bounded retries, then hold with a reason) and retires on a merged or closed PR.
Screen: flagged(impl) -> tooling ownership, invisible across the WE-FUI boundary. Fix applied: kept as a ratification of the shipped coordinator owner; the one new rule (retire a sealed state against GitHub) is the carved child.

## Supported by default

- `collector.ejectOnFinding` as a setting: not added; ejection is unconditional (Fork 4).
- The collector settings keep the existing cascade (standard, platform, repo, env) with each value's source logged ([we:scripts/lib/card-batch-settings.mjs:1](../scripts/lib/card-batch-settings.mjs)).

## Acceptance

- [A1] **Executable** - after the carved child lands: x5nmdnt's [A1] cases pass, among them `retires a sealed state whose PR merged on the next admission` (we:scripts/operations/__tests__/card-batch.test.mjs) and `closed-unmerged batch is archived, retired and surfaced` (we:scripts/operations/__tests__/card-batch-io.test.mjs), and the 327-card spool drains into a new batch (live before/after count).

## Non-goals

- [N1] Code PRs never join a collector; the shared-rule-file conflicts stay with card 6250 and the file-claim machinery.

## Edge cases this change must handle

1. **Untrusted text** - n/a: a decision card; no input is parsed.
2. **Truncated reads** - n/a: no reads.
3. **Shared state files** - the collector state file is shared; retirement runs under the existing lease (the carved child, x5nmdnt).
4. **Fail closed** - an unreadable PR state keeps the batch sealed and holds, never retires.
5. **Identity scoping** - state is keyed by repo and kind.
6. **State over time** - the stuck state is exactly this class; GitHub is the truth source. Open: stays sealed. Merged: retire. Closed by a split: retire (the survivors are on the remainder PR). Closed otherwise: archive with its members, retire, and surface the members as needs-you. Unreadable: stay sealed and held. Each row has a named case in x5nmdnt.
7. **Who wrote it** - n/a: mechanical filers only.
