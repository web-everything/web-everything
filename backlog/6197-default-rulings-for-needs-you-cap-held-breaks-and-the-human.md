---
bornAs: xf5n5yw
kind: decision
status: open
dateOpened: "2026-10-17"
tags: []
---

# Default rulings for needs-you: cap-held breaks and the human-only list

In 48 h the operator was pinged 76 times (20 PRs). He answered 61 of them with 69 short comments. Every parsed answer was "Ok", "Yes to all", "Go" or "Approve": 56 of 56, none overrode the agent's pick. Only 5 episodes (7%) were a real design or scope call. 20 (26%) were product bugs, which fixes in flight remove. This card proposes two cascade-settings rules that remove most of the rest.

Data: needs-you-events.jsonl, 2026-10-15T17:45Z to 2026-10-17T17:45Z (48 h).

## Context (the numbers)

Episode = PR + head + kind. 76 episodes, 84 raw events, 20 PRs. Classes are hand-assigned from the operator comments and PR file lists (heuristic; see Risks).

| Class | Episodes | Share | Example PRs | Rule-predictable? |
|---|---|---|---|---|
| a. approval lost to harmless head change (renumber, rebase) | 8 | 11% | #5169, #5414 | Yes, 8/8 same answer. Fixed by #5425 / #5463 |
| b. stale or re-raised finding (ruled not-real) | 6 | 8% | #5242, #5399 | Yes, 6/6. Fixed by #5463 (repeated-finding reset) |
| c. false stand-down from a system bug | 6 | 8% | #5425, #5462 | Yes, 6/6. #5425 (posted in error), #5448 + fence warn-only default (scope-increase) |
| d. cap-held break ruled card | 2 | 3% | #5242 (test gap), #5453 (rare edge case) | Yes, 2/2 "degraded edge case -> card" |
| e. human-only approval, settings/docs/card diff or clean advisory | 9 | 12% | #5399 (1 card file), #5233 | Yes in outcome, 9/9 "Ok"; no rule exists to skip it |
| f. human-only approval: workflow, protection, guard | 6 | 8% | #5413, #5465 | Outcome 6/6 "Ok", but this list is meant to stay human |
| g. genuine design or scope decision | 5 | 7% | #5403 (scope back to leading cd), #5460 (stop hardening the redactor) | No |
| h. other: cap hit, answered by +1 round and "binding" blocks | 18 | 24% | #5403 (12), #5461 (6) | Yes, 13/13 extensions granted |
| h. other: ruling not needed in the end (no operator answer) | 15 | 20% | #5461, #5441 | n/a (not an interruption) |
| h. other: single block ruling | 1 | 1% | #5399 | Yes (block) |
| Total | 76 | 100% | | |

Predictability, over the 61 episodes the operator answered: 50 (82%) match a rule that could be written (a, b, c, d, e, h-cap, h-block). Add class f, whose answer was also always "Ok", and it is 56 (92%). Only class g (5, 8%) was a real call. Caveat: 100% agreement with the agent's pick shows the operator is a rubber stamp today, not that every case is safe to automate.

Operator comments in the window: 16 clear-human, 13 round extensions, 12 changes-requested decisions, 12 referral rulings, 7 stand-down answers, 1 red-team ruling, 8 other.

Already in place: `referralDefault: auto-block` (we:scripts/review-settings.json) auto-blocks every referral, with no card option. Human surfaces are already "narrow" (workflow, protection, permission, identity, secrets, plus the self-protection floor; we:scripts/settings/human-review-surfaces.json). Hypothesis to check in shadow: most class e episodes were not on a sensitive surface (5233, 5242, 5399 scan clean). They stay `review:human` because an operator send-back put the label on, and nothing removes it after a clean advisory.

In-flight fixes (they remove classes a to c, so they are not counted again below):
- a: #5425 (carry the human clearance across the drain's card-numbering commit), #5463 (carry across identical net patch)
- b: #5463 (repeated-finding reset)
- c: #5448 and the fence warn-only default (#5461: `fix.scopeFence.mode` defaults to warn; the #5462 and #5465 stand-downs were scope-fence false stand-downs); #5425's "posted in error" fix for exhausted-retry stand-downs

## Proposal

**Rule 1 - default ruling for a break held at the round cap** (setting `review.capBreakDefault`):
- degraded edge case (rare input, test-coverage gap, no security or core effect) -> `card`, with an auto-filed card, so no operator ping;
- security finding, or core logic broken -> `block` automatically;
- only broken core logic that matches neither rule goes to the operator;
- a daily digest lists every auto-ruling: PR, finding, ruling, card id, rule that fired, source layer.

**Rule 2 - narrowed human-only list** (setting `review.humanOnly.cleanAdvisoryMerge`):
- keep human-only: security, identity, code-running workflows, guard deny rules;
- a settings-only, docs-only or card-only diff may merge on a clean advisory review with no confirmed findings;
- every such merge writes one audit line (PR, head, files, advisory run id, rule, source layer).

**Common to both rules:**
- each is a cascade setting (built-in default, then settings file, then env) and logs the effective value and its source layer once per process, as we:review-precedents.json does;
- shadow period first: for 7 days the rule logs what it would have decided next to the operator's real answer and enforces nothing; enforce only after zero disagreements on class d and e across at least 15 cases, or each disagreement is explained;
- a disagreement on a security or core finding turns the rule off for that class (fail closed to today's behaviour).

## Options

**Option A (recommended): ship both rules, shadow 7 days, then enforce.**
Expected reduction on top of the in-flight fixes: class e (9) + class d (2) + h-block (1) = 12 of 76 (16%) for certain. Up to 18 more (the h-cap episodes) if the auto-block on security or core findings also stops the cap pings; that part still needs a round extension, so count it as unproven. Range: 12 to 30 of 76 (16% to 39%). With the in-flight fixes (20, 26%): 32 to 50 of 76 (42% to 66%). What stays: class f (6), class g (5), and the rare off-rule break.

**Option B: fixes in flight plus shadow logging only (no enforcement now).**
Reduction: 20 of 76 (26%) from the fixes alone, 0 from the rules. Costs one week; produces the agreement data and de-risks the later enforcement. Pick this if you do not trust the hand-made classes.

Recommendation: A. The operator's answer matched 100% of the time; the shadow period gives the proof before any rule enforces, and the fail-closed fallback keeps today's behaviour.

## Settings

| Setting | Default | Values | Cascade |
|---|---|---|---|
| `review.capBreakDefault` | `shadow` | `off` / `shadow` / `enforce` | built-in, then we:scripts/review-settings.json, then `WE_REVIEW_CAP_BREAK_DEFAULT` |
| `review.capBreakDefault.degradedEdge` | `card` | `card` / `ask` | same |
| `review.capBreakDefault.securityOrCore` | `block` | `block` / `ask` | same |
| `review.humanOnly.cleanAdvisoryMerge` | `shadow` | `off` / `shadow` / `enforce` | built-in, then we:scripts/settings/human-review-surfaces.json, then `WE_HUMAN_ONLY_CLEAN_ADVISORY_MERGE` |
| `review.autoRulingDigest` | `daily` | `daily` / `off` | same |

Invalid layer: fail closed to `ask` / `off`. The effective value and source layer are logged once per process. Human-surface-setting self-protection floor and the workflow floor apply unchanged.

## Risks

- Data is hand-classified from comments and a path-only surface scan (hunks were not available, so `sandbox-widening` hits on 5169, 5403, 5441, 5461, 5485 are fail-closed guesses). Class counts may move a few points. The shadow run replaces them with logged ground truth.
- "Degraded edge case" is a judgment. A wrongly carded break ships. Mitigations: the card is auto-filed and shown in the digest, the security/core test is checked first, and the rule is off for that class on any shadow disagreement.
- A card-only or docs-only diff can still carry an instruction an agent will follow. The rule excludes the human-surface-setting files, and the audit line makes each merge reviewable.
- Cap pings (h-cap, 24%) may stay: auto-block does not grant a round. A follow-up on "grant one round when only in-scope blocks remain" is out of scope here.
- 15 episodes (20%) had no operator answer. They need a separate look (why raised, then dropped); they may be noise in the event feed, not decisions.

## How to measure success

- Operator-answered needs-you episodes per 48 h: baseline 61. Target after enforcement: 30 or fewer (about half), counting the in-flight fixes.
- Shadow agreement: rule decision equals the operator's real answer on 100% of class d and e cases (target at least 15 cases) before enforcing.
- Zero security or core finding carded or auto-merged; any one reverts the rule to shadow.
- Digest reviewed daily; auto-carded items resolved or promoted within 7 days.
- Counted again 7 days after enforcement with the same script on the same event file.

Operator 2026-10-17: "Yes to all" — pick option A (both rules shadow 7 days, then enforce).
