---
bornAs: xtzqoyq
kind: story
size: 5
priority: high
parent: "5467"
status: open
blockedBy: ["5469"]
relatedTo: ["5468", "5399"]
scope: ["we:scripts/lib/review-round-rules.mjs", "we:scripts/lib/__tests__/review-round-rules.test.mjs", "we:scripts/lib/__tests__/review-round-rules.replay.test.mjs", "we:scripts/lib/review-settings.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs", "we:scripts/operations/review-round-replay.mjs"]
dateOpened: "2026-10-08"
preparedDate: "2026-10-09"
preparedAgainstSha: "6e57185099f3dc66c49a7954e7722debdc55020f"
tags: [review]
---

# Binding prior round: late findings on unchanged code become cards

Fixer/review proposal, operator 2026-10-08, P3. On code unchanged since round N, a finding that was tolerated or not raised in round N is filed as a card, not a blocker. The one exception is `broken` + `CONFIRMED`: a reviewer may still block a real defect (the #5399 floor rule). A re-raise of a finding marked "fixed" must say why the fix fails; without that it is advisory. Ruled: 3 days in shadow with a "would have blocked" journal first, then on. Needs the finding identity from 5469. The rule is a pure function in the protocol card 5468's shape.

## Acceptance

- [A1] **Executable** — replay fixtures: (a) a tolerated finding re-raised on unchanged code becomes a card; (b) a `broken`+`CONFIRMED` one on unchanged code still blocks; (c) a finding on changed code blocks as today; (d) a re-raise of a "fixed" finding with no reason is advisory.
- [A2] The mode is a declared setting: off (today) / shadow / on. Shadow journals "would have blocked" per finding and changes no verdict.
- [A3] Shadow runs at least 3 days; the switch to on is a settings change citing the journal's counts.
- [A4] Each auto-carded finding is filed as a backlog card with its identity and the round that tolerated it, and counted ("auto-carded findings").
- [A5] **Proof** — on a live round-2+ PR, before/after: the shadow journal entry, then (after the flip) the card filed instead of the block.

## Non-goals

- [N1] No change to round 1, CI, or the drain's live gate.
- [N2] No round budget: that is 5471 (P5).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the "why the fix fails" reason is read as text for the card, never as a verdict switch by itself.
2. **Truncated reads** — unknown "changed since round N" status counts as changed: the finding blocks as today.
3. **Shared state files** — the shadow journal and the filed-cards record are append-only; cards are filed through `file-item` under a per-`findingId` lock, so two concurrent rounds cannot both file (Design 5).
4. **Fail closed** — missing identity or ledger read error leaves today's blocking behaviour.
5. **Identity scoping** — "unchanged" is per finding identity and per PR head pair.
6. **State over time** — the 3-day shadow window is a setting with a recorded start date.
7. **Who wrote it** — `CONFIRMED` comes only from the review role's ledger row.

## Progress

- 2026-10-09 prepare pass. Premise check against `main` (`git log --grep=5470` finds only the JIT-number commit): the goal is NOT delivered. Card 5469 (resolved) built the pure rule and the shadow, so this card is the `on` half only; the card text predates that and reads as if the rule were still to write.
- Corrected drift: the pure R6 rule `bindingRoundDecision` (we:scripts/lib/review-round-rules.mjs:259), `shadowRound` (we:scripts/lib/review-round-rules.mjs:301) and the replay fixtures (we:scripts/lib/__tests__/review-round-rules.replay.test.mjs) already exist. `SCOPED_REREVIEW_MODES` is `['off','shadow']` (we:scripts/lib/review-settings.mjs:18). The original `scope:` missed the real targets and listed we:scripts/lib/review-loop-policy.mjs, which this change does not touch. Review round 1 of this PR found that; `scope:` (it carries file-overlap locks) is now corrected here: it names we:scripts/lib/review-round-rules.mjs, we:scripts/operations/review-pr-io.mjs, we:scripts/lib/review-settings.mjs, we:scripts/operations/review-pr.mjs, we:scripts/operations/review-round-replay.mjs and their tracked tests, and drops review-loop-policy. we:scripts/review-settings.json is deliberately not in scope: the flip is a Follow-up, not part of the build.
- Size: 3 → 5. Evidence: a new post-reduce step with io (we:scripts/operations/review-pr.mjs:2453-2745), composition with the live round rules (:2564-2580), a `file-item` filing path with dedupe, and an `on` replay path. Review round 1 of this prepare pass found the first design (apply inside reduce) infeasible; this version uses the post-reduce step. Frontmatter `size:` updated accordingly.
- Shadow start: we:scripts/review-settings.json already sets `scopedRereview: shadow`. The 3-day window is measured from the journal's first line; enforcement is a Follow-up.

## Design

Today the shadow runs as the LAST effect of the `advise` step (we:scripts/operations/review-pr.mjs:2775), after the verdict is final. `recordScopedRereviewShadow` (we:scripts/operations/review-pr-io.mjs:341) reads the ledger and git, calls `shadowRound`, appends `finding` rows and the journal; it never changes a verdict. To make `on` real, the decisions must be known BEFORE the verdict is fixed:

1. **Setting.** Add `'on'` to `SCOPED_REREVIEW_MODES` (we:scripts/lib/review-settings.mjs:18). Env override keeps working through `resolveReviewSettings`. Every place that tests `=== 'shadow'` must learn `'on'`: the read carry at we:scripts/operations/review-pr-io.mjs:311, `read.scopedRereview` (we:scripts/operations/review-pr.mjs:1130), `basisLenses` (we:scripts/operations/review-pr.mjs:2708) and the shadow effect gate (we:scripts/operations/review-pr.mjs:2775). `resolveScopedRereviewMode` (we:scripts/operations/review-pr-io.mjs:408) already follows `SCOPED_REREVIEW_MODES` and needs no change. The shadow-mode start date is the journal's first line; there is no new setting for it (see Follow-ups).
2. **Extract the compute.** Split `recordScopedRereviewShadow` (starts at we:scripts/operations/review-pr-io.mjs:341) into `computeScopedRound({payload, exec, readLedgerRows})` (reads only: prior head, scope, prior statuses, per-finding symbol via `git show`, then `shadowRound`) and the existing recorder that appends rows and journal. `shadowRound` entries gain `priorRound` (from `foldFindingStatuses`' `round`). Shadow behaviour stays byte-identical.
3. **Where `on` applies: a new step after `reduce`, before the referral verdict (decided; option b).** Findings do not exist at read time: they are juror answers consumed inside the pure `reduce` compute (we:scripts/operations/review-pr.mjs:2453-2680), which has no git or ledger access, and `computeScopedRound` needs reduce's output (`scopedRereviewFacts`, `basisLenses`) plus `git show` for symbols. So `on` adds one step `bind-round` (an effect step with io, like `advise`) between `reduce` and `referralVerdict` (we:scripts/operations/review-pr.mjs:2721-2750). It runs `computeScopedRound` on reduce's output, then a new pure `applyBindingRound` (we:scripts/lib/review-round-rules.mjs) moves each finding whose entry is `decision: 'card'` out of the blocking set into `deferredAdvisory`. It never moves a finding with no entry, nor one with reason `confirmed-broken` (we:scripts/lib/review-round-rules.mjs:269). Any throw or unreadable ledger returns the unchanged lists.
   - **Entry-to-original mapping.** `scopedRereviewFacts` (we:scripts/operations/review-pr.mjs:3063) rebuilds findings as copies, so entries refer to copies. `findingId` is NOT unique per finding: `findingIdentity` (we:scripts/lib/review-round-rules.mjs:128) hashes only repo, pr, path, symbol and defect class, never line, verdict or impact, so two findings in one function (or two with an empty symbol) share an id while carrying different decisions (one `confirmed-broken`, one `card`). Matching by id alone would move both and drop the mandatory-referral blocker. So `applyBindingRound` groups entries by `findingId` and moves an ORIGINAL only when its whole group is carded: every entry sharing that id decides `card`, AND the number of entries equals the number of originals with that id (an original with no entry of its own keeps the group blocking). Any `block` entry in the group, or a count mismatch, keeps every original in the group blocking. The moved originals keep their lens-prefixed category. Tests: two findings, one carded, the right original moves; two originals sharing one `findingId` with mixed decisions (`confirmed-broken` + `card`) both stay blocking and the verdict does not flip; a shared-id group with an entry-less sibling stays blocking.
   - **Verdict recompute.** The panel verdict is built inside `reduce` from `verdictAdmitted` (per-lens `deriveVerdict` at we:scripts/operations/review-pr.mjs:2616-2620, then `derivePanelVerdict` at :2655 and `deriveLoopOutcome` at :2677), and `verdictAdmitted` (which excludes the advisory seat) is not in reduce's output. So `reduce` must also expose `verdictAdmitted`; `applyBindingRound` drops the carded originals from it and the `bind-round` step recomputes `lensVerdicts`, `admittedFindings`, `verdict` and the loop outcome with those same functions. `deriveAdvisoryOutcome` (we:scripts/operations/review-pr.mjs:1899) re-derives from `lensVerdicts` + `admittedFindings`, so both must be the recomputed ones. The builder confirms `referrals`, `deferredAdvisory`, `humanRequired` and `pendingReferrals` also see the shorter list.
4. **Composition with the live rules.** `bind-round` runs AFTER `classifyReferralsByRound` / `classifyLaterRoundAdvisory` (we:scripts/operations/review-pr.mjs:2564-2580), so it only sees what they kept; it never re-promotes anything. A finding that is a kept or block-ruled referral (`blockedReferrals`, `pendingReferrals`) is excluded from carding. The existing `referralVerdict` promotion of deferred findings back to blocking (we:scripts/operations/review-pr.mjs:2736-2745) must not promote a `bind-round` card: carded findings are tagged `deferred: 'binding-round'` and the promotion skips that tag. Test both.
5. **File cards.** For each carded entry, `bind-round` calls the `file-item` operation in-process (we:scripts/operations/file-item.mjs) for the WE backlog: kind task, size 1, no parent, `queue=false` (so the conveyor does not dispatch an auto-card to a builder), title from the folded summary, body carrying `findingId: fi-…`, the PR, path/symbol/class, and the round that tolerated it (`priorRound`, `priorStatus`). **Dedupe, in this order**, under a per-`findingId` lock (an atomic `mkdir` lock directory beside the journal; failing to take it leaves the finding blocking, so two concurrent rounds cannot both file): (1) the **filed-cards record**, an append-only `bound-cards.jsonl` beside the journal, one line `{findingId, cardId, pr, round}` written right after each successful `file-item`; a hit whose card file still exists (in the daemon checkout's `backlog/` or on `origin/main`) is linked, not refiled. This is what catches a card that is written but not yet landed: the `origin/main` tree cannot see it, the record can. (2) A grep of the `origin/main` `backlog/` tree for a line that is exactly `findingId: fi-<id>` (anchored, multiline `^findingId: fi-[0-9a-f]{12}$`, never the bare id): card bodies hold folded untrusted finding summaries, so an unanchored match would link a finding to a card that merely quotes its id. The step writes that line itself and `foldUntrusted` removes newlines from every summary, so no summary can forge a line start. A record hit whose card file is gone (never landed, then discarded) is stale: re-file and append the new `cardId`. A failed lookup, a failed lock, a failed record append or a failed `file-item` call leaves the finding blocking. **Durability:** `file-item` writes the card file into a checkout and does not land it; landing goes through the normal verify and `open-pr` path, which this step does not run. So the durable record of a carded finding is the ledger `finding` row with status `carded`, the journal entry (`autoCarded`, `cardIds`) and the filed-cards record; the card is landed later, and an unlanded card is reused by the next round rather than duplicated.
6. **Re-raise of a "fixed" finding.** In the MVP `reraise-of-fixed` always cards (already the rule's behaviour, we:scripts/lib/review-round-rules.mjs:282), which satisfies A1(d) "no reason → advisory". Accepting a stated "why the fix fails" is a Follow-up: the field does not exist and the finding normalizer would strip it.
7. **Journal, no double count.** In `on`, `bind-round` writes the finding rows and the journal entry itself, with `mode: 'on'`, `autoCarded` and `cardIds`; the `advise` shadow effect (we:scripts/operations/review-pr.mjs:2775) is skipped when the mode is `on`, so rows and counts are written once. Shadow entries keep their would-block / would-card rows. Reuse `appendScopedRereviewJournal` (we:scripts/operations/review-pr-io.mjs:322).

## MVP

Musts:
- `'on'` accepted by the setting; `off` and `shadow` unchanged.
- `computeScopedRound` extracted; `applyBindingRound` pure, with a replay path for `on` (extend `replayPrRounds`, we:scripts/lib/review-round-rules.mjs:395, to apply the decisions).
- The `bind-round` step, composed after the existing round rules (Design 3-4), with `reduce` exposing `verdictAdmitted`.
- The replay CLI (we:scripts/operations/review-round-replay.mjs) gains an `on` mode and a `--dry-run` that prints the blocking set before/after and the `file-item` payload (the Proof plan needs it).
- In `on`: carded findings leave the blocking set; each is filed through `file-item` (`queue=false`), deduped by `fi-` id, and counted in the journal (`autoCarded`).
- Fail closed on every uncertainty (unplaceable change, unreadable ledger, unknown head, missing identity, failed filing): findings stay blocking.
- Replay fixtures A1(a)-(d) plus the settings, composition and journal cases below.

Out of scope (Follow-ups): the live flip itself (A3); a setting-held window start plus a 3-day refusal and a `shadowWindowReport` (A3 only needs the flip to cite the journal's counts, which a manual count of the journal satisfies); `whyFixFails`; the "auto-carded findings" summary line; the round budget (5471); any change to round 1, CI or the drain gate (N1). The A5 live proof stays open past this build, by design.

## Test plan

Add to we:scripts/lib/__tests__/review-round-rules.replay.test.mjs (pure) and we:scripts/operations/__tests__/review-pr-io.test.mjs (io):
- (a) `applyBindingRound`: tolerated finding on unchanged code, round 2 → moved to `deferredAdvisory` (the field Design 3 names; there is no `cardSuggestions`), blocking set empty. RED today: the function does not exist and mode `on` is rejected by the setting.
- (b) GUARD (red only by absence of `applyBindingRound`): `broken`+`CONFIRMED` on unchanged code → stays blocking, entry reason `confirmed-broken`. Catches a naive "card everything unchanged" build.
- (c) GUARD (same): finding on changed code (`near`) → still blocks.
- (d) re-raise of a `fixed` identity with no stated reason → carded (advisory). RED today: `on` does not exist, so nothing leaves the blocking set.
- Verdict recompute (RED): carding the only blocker of a mandatory lens flips that lens to accept, the panel verdict and loop outcome follow, and `deriveAdvisoryOutcome` returns `accept`. Entry-to-original: with two findings and one card entry, the right original object moves.
- Settings: `'on'` valid, RED today. Garbage → `off` is a GUARD (already green).
- Composition (RED): a carded finding is not re-promoted by `referralVerdict`; a finding already kept/block-ruled by `classifyReferralsByRound` is never carded; a finding the live later-round rule already demoted is not carded twice.
- io: `on` with unreadable ledger → unchanged blocking list, one loud miss line, no card filed. Two reviews of the same finding with the FIRST card written but NOT landed (not on `origin/main`) → exactly one `file-item` call, the second round reuses the first `cardId` from the filed-cards record; a record hit whose card file is gone re-files. Two concurrent rounds on one `fi-` id → one filing (the loser fails the lock and its finding stays blocking). A card on `origin/main` whose body only MENTIONS the id (inline, or inside a folded summary) and has no exact `findingId: fi-…` line is not a hit. `file-item` failure, lookup failure, lock failure or record-append failure → finding stays blocking. `queue=false` is passed.
- io: `on` writes finding rows and the journal entry once (the `advise` shadow effect is skipped); the entry carries `priorRound`, `autoCarded`, `cardIds`.
- io GUARD: shadow-mode rows and journal entry byte-identical to before the extraction (golden fixture from the current test).
- Untrusted text: a finding summary with newline, backtick and a leading `--flag` yields a card title and body folded by `foldUntrusted` (we:scripts/lib/jury-core.mjs); the title builder additionally strips a leading `--`, tested directly.

## Proof plan

1. Before: read the live shadow journal (`scopedRereviewJournalPath()`) and quote one round-2+ entry with a `card` decision and the PR's actual blocked verdict. If the journal has no `card` entry yet, use the recorded 5469 fixture PRs (#4441, #4433) instead and say so.
2. Dry-run: run the replay CLI (we:scripts/operations/review-round-replay.mjs) with the `on`-mode path on that PR's recorded rounds; it prints per round the blocking set before and after `applyBindingRound` and the exact `file-item` payload, and files nothing (`--dry-run`).
3. After (post-flip, by the operator citing the journal's counts): on a live round-2+ PR, show the filed card (id, `fi-` identity, tolerating round), the `autoCarded` counter, and the verdict that no longer blocks. Steps 1-2 are the build PR's proof; step 3 is the A5 live proof, open past this build, after the 3-day shadow window.

## Follow-ups

- Flip `scopedRereview` to `on` in we:scripts/review-settings.json, citing the journal's counts after 3 days of shadow (A3, A5 live proof).
- A setting-held shadow start date, a pure `shadowWindowReport`, and a refusal that resolves `on` to `shadow` inside the 3-day window (adds a clock input to `resolveReviewSettings`).
- `whyFixFails` as a first-class finding field in the review role's schema, so a stated reason can keep a re-raise of a fixed finding blocking.
- A report line for the "auto-carded findings" counter in the review summary.
