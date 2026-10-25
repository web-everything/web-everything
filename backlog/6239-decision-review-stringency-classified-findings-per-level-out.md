---
bornAs: xugqjw1
kind: decision
status: resolved
dateOpened: "2026-10-17"
dateStarted: "2026-10-17"
dateResolved: "2026-10-17"
codifiedIn: "docs/agent/platform-decisions.md#review-stringency-classified-outcomes"
preparedDate: "2026-10-17"
preparedAgainstSha: "b1f6b2a13957d40ae74cae4c3b1811400ae4e008"
relatedReport: "reports/2026-10-17-review-stringency.md"
tags: ["review", "stringency", "debt", "settings"]
---

# Decision: review stringency — classified findings, per-level outcomes, debt register

## Ruling

**Ruled 2026-10-17 by the operator (Nicolas Gilbert), in conversation.** Verbatim: *"Ok for your picks"*, in
answer to the card's recommended defaults. The rule is codified at
[we:docs/agent/platform-decisions.md#review-stringency-classified-outcomes](../docs/agent/platform-decisions.md#review-stringency-classified-outcomes).
The prepared text below is kept as the lineage; where it differs from this section, this section wins.

- **Fork 1 = (a).** The reviewer tags the class; a path or pattern rule table overrides the tag. Low confidence
  caps the outcome at advisory except for always-block classes. An unknown class or a table gap is a block.
- **Fork 2 = (a).** A level move is blocked while debt due at that level is open. The only ways past are paying
  the debt, or an operator's recorded edit of that item's must-pay-before level.
- **Fork 3 = (a), with its precondition.** A new backlog kind `debt`. The same slice must register the kind's
  size rule and buildable rule and update every reference to the kind set. If that cannot ship together, the
  ruling falls back to (b), kind `task` plus debt frontmatter fields.
- **Always-block rows** are accepted as proposed.
- **Ratified invariants retained.** Each level inherits every block below it. Reckless or inadvertent debt
  cannot be admitted as ordinary deferred debt; this does not impose a quadrant on other outcomes. Low
  confidence on an always-block class triggers a second check and stays block pending it. Confirmed keeps
  block; verified not-real through the authenticated ruling path closes only that finding, never downgrades
  it to advisory. Failure, unavailable, inconclusive, timeout, malformed, stale, mismatched or forged results
  retain block. Results bind repository/PR/head/finding and classification/settings revision (slice 2 A12).
  Overdue expedite counts as debt due now at the current level and blocks a move without a quadrant assessment;
  unpaid debt resurfaces after 45 days and never expires silently. Only the operator changes effective settings.

**Security handoff clarification (advisory repair, 2026-10-17).** The implementation must make these existing
refusals effective: validate model-supplied fields before the confidence cap; unreadable/incomplete input blocks;
operator identity comes from a protected CI check of the authenticated GitHub review actor against a protected
allowlist, bound to the exact repository/base/head/diff, never a role written in PR content or commit metadata.
Debt cannot be hidden by deletion, rename, kind/status/class/deadline/source edits; payment needs independently
verified landed-fix and validation evidence. Agent-facing lessons/proposals use a fixed class/count template
with typed provenance kept separately, never interpolated PR-derived prose. These are implementation obligations
in the canonical statute and slices 2 A8–A12, 3 A6–A10 and 5 A5, not features delivered by this decision PR.

**Coverage handoff clarification (latest advisory repair, 2026-10-17).** Statute items 8–10 spell out wire
domains (severity low/medium/high/critical; confidence low/medium/high, exact low token; four-value
debtQuadrant required only for ordinary debt admission), security's severity-partitioned key, ambiguous path/pattern and same-kind rule conflicts
(block before the cap), read-side cascade value/source/revision logging, repeated staleness baselines and
repository/class feed aggregation. Expedite starts at ruling time; staleness starts at openedAt and repeats
45 elapsed days after each successful surfacing. The register retains the quadrant and trusted clock fields.
Protected base code/policy, PR-job credential isolation and bounded ingress have explicit production test
owners in slice 2 A15–A16, slice 3 A11, slice 4 A6 and slice 5 A8. Prevention tooling for every newly identified
gap is owed by 6235 A6–A12; A5/A6 also cover missing/malformed quadrant. These clarify the implementation
handoff, without changing ratified cell outcomes or claiming implementation delivery.

**Advisory handoff repair (2026-10-18).** Slice 2 A17 pins all ratified initial settings as independent literals,
including current level internal-delivery and lessons enabled true. A12 now declares every second-check
result, including failure/timeout. Debt admission applies only to an effective debt outcome after the
confidence cap: the accountable debt owner supplies the deferral assessment/rationale and the authenticated
operator confirms it, rather than a reviewer guessing intent for every defect. A5/A18 prove expedite and
advisory need no quadrant and ordinary debt remains reachable. Verified overdue expedite remains due now
without that assessment (slice 3 A2/A8). Register/gate injected display-text fixtures are slice 3 A12;
prevention obligations for these four gaps are recorded in 6235 A3/A6/A7. No runtime implementation is claimed.

**Amended table** (order: internal delivery, dogfood, public preview, public release). It replaces the
"The table" section below for the rows named here; all other rows stand as proposed.

| Class group | Internal | Dogfood | Preview | Release |
|---|---|---|---|---|
| Missing test on guard or delivery code | B | B | B | B |
| Missing test elsewhere | E | B | B | B |
| Security, high severity | E | E | B | B |
| Security, lower severity | D | D | B | B |
| Standards conformance (raised) | E | E | B | B |
| NEW: PR description wrong about what the change does | E | E | E | B |
| Doc, card or PR-body drift | D | D | D | B |
| Simplicity and style | A | A | A | D |

Notes on the rows. The "PR description wrong" row is to be revisited once the ledger allows a cheap
description-only round. "Standards" is no longer grouped with lower-severity security; it is its own row.

**Outcomes.** Four: block, expedite, debt, advisory.
- Expedite: the PR lands, the card goes to the top of the build queue with a deadline; past the deadline it goes
  to the operator as needs-you (one row per class) and becomes debt due now at the current level. The deadline
  length is a setting, initially 72 hours; extensions require a recorded operator edit, never automatic extension.
- **Advisory is redefined:** recorded in the ledger, never fixed per PR. Recurring classes become builder
  lessons.
- Settings: `advisory.lessons.enabled` (on), `advisory.lessons.schedule` (Sunday 20:00 ET),
  `advisory.lessons.recurrenceThreshold` (5 per class per week), `advisory.lessons.promoteToRule` (proposed to
  the operator, never automatic).
- The current level is **internal delivery**. Every cell and value is a cascade setting with its source logged.

**Build order.** 1 closed class list; 2 settings table used by the ruling step; 3 debt register (kind, expedite
queue position, level gate); 4 plateau debt panel; 5 advisory lessons on the ledger. Slices: see the epic filed
under this ruling (the epic's children carry dependencies as `blockedBy` edges; the panel and lessons may
follow their prerequisites independently).

Reference document (operator's proposal): https://claude.ai/code/artifact/85ac690b-07a7-4946-9d05-126c6ee16667

Operator ask, 2026-10-17: "Yes prepare the decision." Proposal document (operator's own):
[review stringency proposal](https://claude.ai/code/artifact/85ac690b-07a7-4946-9d05-126c6ee16667).

## Digest

Today every review finding is judged by the same bar, so a missing test on a card and a hung daemon tick both
cost a fix round. This card decides how to classify findings and what each class does at each release level:
**block**, **expedite**, **debt**, or **advisory**, with a debt register that gates the move up a level. It is
prepared against our own 14-day record (5,971 findings on 869 PRs) and eight outside models. Research topic:
[/research/review-stringency/](/research/review-stringency/); session report
`we:reports/2026-10-17-review-stringency.md`. The proposal itself is a single table (ratify as a block, below).
Three genuine forks remain, each with a **bold** default. Three of the operator's five open questions (the
current level, the deadline length, expedite past its deadline) dissolved into settings values (below).

## Problem

- One bar for everything. 42 finding classes exist in practice, but the review path only knows which lenses
  are mandatory (correctness and security, `MANDATORY_LENSES` at `we:scripts/lib/jury-core.mjs:1438`), the
  impact levels (`IMPACT_LEVELS` at `we:scripts/lib/jury-core.mjs:203`) and the dispositions blocker,
  carve-out and nit (`we:scripts/lib/jury-core.mjs:290`). It does not know the release level or the class.
- About a third of the findings that reach a ruling are not real: 257 of 780 ruled findings (33%) were
  ruled not-real by the strongest ruling on them.
- Fix rounds bundle reasons. Only 51 of 341 parseable changes-requested comments had a single cause. Most had
  3 to 5. Dropping one class from blocking will not by itself remove a round.

## Evidence (our own record, 2026-10-03 to 2026-10-17, web-everything repo only)

Method limits: class labels are model judgement (about 10 to 15 percent boundary mislabels expected), only
issue comments were read, the plateau-app repo was not sampled. Counts are upper bounds on distinct defects.

- Top classes by count: missing test for a stated guarantee 794 (13.3%), guard weakened or bypassable 336 (5.6%),
  doc, skill or card drift 291 (4.9%), planned test missing in a card 277 (4.6%), parser or regex edge case 264
  (4.4%), fail-open guard 248 (4.2%).
- Fix-round cost is led by missing tests (52.9 of 341 attributed rounds, 16%), then fail-open (18.0), missing
  path (16.7), weakened guard (15.5), injection (14.7).
- Security did not stall delivery. Secret exposure (86 findings), injection (210), authorization (225),
  data loss (75) and local paths (12) were all flagged for hostile-input or leak scenarios in a trusted
  single-operator setup. None of them caused a stall or a red main in the window.
- What did stall or break delivery: missing timeout (hung gate blocked a daemon tick, 53% stall language),
  performance and unbounded reads, races, non-hermetic tests (13 "fix red main" PRs in 14 days), recovery
  paths (34% stall language), counters and budgets, and import-cycle wiring.
- The review daemon's auto-block policy (`review.referralDefault=auto-block`, committed in
  `we:scripts/review-settings.json:2`) wrote 134 block rulings. On 126 of them the reviewer had ruled
  not-real. That is the largest single source of false blocks. Current main already carries a setting,
  `autoPolicyRespectsNotReal` (default true in `we:scripts/lib/review-settings.mjs:48`), which
  `operatorProtection` at `we:scripts/operations/record-referral-ruling.mjs:142` honours; whether it shipped
  after the 14-day window must be checked at build time, and the proof for this card includes re-counting.
- Red team: 672 findings confirmed, 623 not confirmed (48%). The worst false source is red-team re-check on
  card-only diffs (77 of 96 doc-drift items unconfirmed).
- Rulings split: strongest ruling block 414 (53%), card 77 (10%), not-real 257 (33%). The operator's own 67
  rulings split block 22, card 24, not-real 21.
- Holds that are not findings are the big time sinks (operator wait 39% of lost time, all one PR; approvals lost to
  a later head). They are out of scope here and stay with the existing process-hold work.

## Outside models

| Model | What it gives this design | Status |
|---|---|---|
| OWASP ASVS levels L1 to L3 | Each requirement carries the lowest level it applies to; stricter inherits lower. Our level ladder copies this. | Project page confirmed, current version 5.0.0. The level definitions were not on the fetched page, so they stay unverified here. |
| CVSS v4.0 environmental metrics | Same finding, different severity by consumer context. Supplemental metrics ride along without changing the score. | Fetched earlier in research (spec read). |
| Google SRE error budget policy | When the budget is spent, changes halt except P0 and security fixes. Backs "delivery stability always blocks". | Verified: exact wording confirmed. |
| SQALE and Fowler debt quadrant | Debt needs a fix cost and a cost of not fixing. Only prudent-deliberate debt is acceptable. | Fowler quadrant verified (four quadrants as stated). Fowler "interest = extra effort" verified. |
| Sonar new-code gate | Judge the delta, keep old debt in a separate list. | Verified on the current docs page (new-code-only quality gate). The older clean-as-you-code URL is dead. |
| AI-code failure modes | Hallucinated packages, insecure completions, test gaming, over-broad edits. | Pearce (about 40% of 1,689 programs vulnerable) and Perry (less secure code, more confidence) verified. AIDev corrected. |

## Source verification (done in this prepare, by opening each source)

Verified:
- Fowler technical debt quadrant: prudent/reckless by deliberate/inadvertent. Confirmed.
- Fowler technical debt: "The extra effort that it takes to add new features is the interest paid on the debt." Confirmed.
- Google SRE error budget policy: "halt all changes and releases other than P0 issues or security fixes" after
  the four-week budget is spent. Confirmed.
- Pearce et al. (arXiv 2108.09293): about 40% of 1,689 generated programs vulnerable. Confirmed.
- Perry et al. (arXiv 2211.03622): assistant users wrote significantly less secure code and were more likely to
  believe it was secure. Confirmed.
- Bacchelli and Bird abstract (Microsoft Research publication page): defect-finding is the main motivation but
  reviews deliver "less about defects than expected", more knowledge transfer and awareness. Confirmed on the
  abstract. The PDF link in the notes returned unreadable binary, so use the publication page as the citation.
- CWE Top 25: ranked by severity and prevalence; current edition 2025, page updated 2026-01-29. Confirmed.
- Sonar: the built-in quality gate "defines conditions applying to new code only". Confirmed at the
  about-new-code page.
- ISO/IEC 25010: the page lists the 2023-style characteristics (functional suitability, performance efficiency,
  compatibility, interaction capability, and more). Edition is inferred, not stated on the page. Pin the
  edition when citing.

Corrected:
- DORA: the guide now names five metrics, not four. Change lead time, deployment frequency, failed deployment
  recovery time (replaces time to restore), change fail rate, and a new fifth, deployment rework rate.
- AIDev (Li, Zhang, Hassan, arXiv 2507.15003): the paper is a dataset of 456,000 PRs from five agents. Its
  abstract reports lower acceptance of agent PRs, not rejection reasons. The earlier note that agent PRs are
  rejected "more for scope" is NOT supported by the abstract and is dropped from this card.
- Mozilla bug fields: the page does not define a "blocking" flag meaning must-fix-before-release. Its
  "Blocks" field is bug dependency, and tracking flags only mark intentions. The earlier "closest model" claim
  is weakened to "tracking flags exist". The debt gate stands on its own design, not on that precedent.
- Sonar clean-as-you-code URL: the old path is a 404. Use the about-new-code page.

Could not be verified (URL dead or page lacks the content), so treated as unverified background only:
- IEEE 1044-2009 page (error page returned).
- IBM research page for Orthogonal Defect Classification (404).
- OWASP ASVS level definitions (not on the fetched page).
- Mozilla release-management tracking-flags page (404).
- Kruchten, Nord and Ozkaya (IEEE Software 2012) and the SEI debt-register fields (no URL given).

## Axes (what the design touches)

The change spans four existing surfaces. None of them knows about release levels yet.

- Review ruling path: referral rulings are recorded by `we:scripts/operations/record-referral-ruling.mjs`,
  stored by `we:scripts/lib/ruling-ledger.mjs`, and the automatic policy runs in
  `we:scripts/conveyor/referral-auto-block.mjs`. The setting that picks who rules first is
  `review.referralDefault`, defined with its allowed values at `we:scripts/lib/review-settings.mjs:7` and
  committed as `auto-block` in `we:scripts/review-settings.json:2`.
- Verdict reduction: `we:scripts/lib/jury-core.mjs:1955` (`derivePanelVerdict`) turns lens verdicts into
  accept, changes or needs-human. A finding earns a round only as a blocker (`we:scripts/lib/jury-core.mjs:290`).
  The new outcomes (expedite, debt, advisory) would plug in where the blocker disposition is decided.
- Backlog item kinds: `we:scripts/check-standards-rules.mjs:364` defines six kinds. There is no `debt` kind.
- Settings dir: one JSON file per concern under `we:scripts/settings/` (for example
  `we:scripts/settings/red-team.json`, `we:scripts/settings/needs-you-feed.json`). The class-by-level table
  would live here as `we:scripts/settings/review-stringency.json`.
- Statute composition (review severity is NOT unowned). Existing anchors in `we:docs/agent/platform-decisions.md`
  govern the same turf and this design must compose with them, not replace them:
  `#claim-accuracy-advisory-blocks-on-impact` (blocking is decided by impact, not by lens),
  `#creator-owed-proof-not-reviewer-rederivation` (a fourth disposition, unverifiable as submitted),
  `#blast-radius-advisory-care-not-a-gate`, `#every-pr-gets-a-look-advisory-floor`,
  `#delivery-decider-under-fixed-settings` (invariants always win), and `#deterministic-core-thin-judgment`
  (deterministic rules decide, judgment is thin). Composition: the class table is a mapping onto the existing
  impact levels and dispositions, not a parallel scale. Blocker maps to block, carve-out to debt, nit to
  advisory, and expedite is the one new outcome. The always-block rows are the invariants that
  `#delivery-decider-under-fixed-settings` already says win. Any build must reconcile with these anchors
  before it sets `codifiedIn`.
- Standard-layer grounding: this is delivery tooling, not a web standard; no intent in `we:src/_data/intents/`
  owns release-level vocabulary. The stringency table is WE-resident definition data (a setting plus a validator), with the
  evaluator running in the daemon side. Placement per the zero-implementation rule: the table and a
  validation script are allowed; any runtime evaluator goes to the implementation repo.

## Recommended path at a glance

| Fork | Recommended default | Main alternative | Confidence |
|---|---|---|---|
| Fork 1 — who assigns the class | **(a) Reviewer tags the class; a rule table can override it** | (b) Deterministic classifier only | med-high |
| Fork 2 — level move while debt due | **(a) Block the move** | (b) Block unless operator waives | high |
| Fork 3 — what a debt item is | **(a) A new backlog kind `debt`** | (b) A task plus debt frontmatter fields | medium |

## Supported by default (not forks)

- **Outcomes.** Four: block (cannot land), expedite (the PR lands, the card goes to the top of the build queue
  with a deadline), debt (the PR lands, a normal-priority card due before a level), advisory (surfaced only).
- **Levels.** Internal delivery, dogfood, public preview, public release. Each inherits every block below it.
  An empty cell means block (fail closed).
- **Current level.** A settings value, not a fork. Both values are legitimate end states, only the operator may
  change it. Initial value: **internal delivery**, which matches all current work. Config dimension per the
  config-extends-platform-default rule.
- **Expedite past its deadline.** A settings value (`expediteOverdue`), not a fork: the screen found the
  difference between escalating and auto-blocking is operator-wait cost against freezing unrelated work, which
  is prioritization. Default: **escalate to the operator (needs-you feed, one row per class so the feed is not
  flooded) and count the overdue item as debt due now at the current level**, so the level gate blocks on it.
  The operator may extend, pay, or accept the block. Auto-extend is not offered.
- **Deadline length.** A settings value, not a fork. Initial values, low confidence, cheap to change because they
  are data: expedite deadline 72 hours; debt has no calendar deadline (its due point is a level), with a
  45-day staleness re-surface so open debt cannot sit unseen. No evidence in our record sizes either number, so
  the first re-count after build should set them.
- **Careless debt is never accepted.** Only prudent-deliberate ordinary deferred debt (Fowler) may be
  recorded. Reject reckless or inadvertent debt admission; block, expedite and advisory findings do not
  require a quadrant. The assessment concerns accepting a deferral, not guessing the original defect's intent.
- **Level gate.** The move up a level is blocked while debt due at that level is open.
- **Plateau debt panel.** A read view over the debt items. Build last.
- **Build order.** Closed class list, then settings table, then debt register, then plateau panel.
- **Operator-only edits.** Only the operator changes the current level, an invariant row, or loosens a cell.
  Loosening a cell is itself a guard-weakening change.

## The table (ratify as a block; each row is backed by the evidence above)

Outcome per level, in order: internal delivery, dogfood, public preview, public release. "E" = expedite,
"D" = debt, "A" = advisory, "B" = block.

| Class group | Internal | Dogfood | Preview | Release | Evidence |
|---|---|---|---|---|---|
| Delivery stability: timeouts, slow or quadratic code, races, recovery, flaky tests | B | B | B | B | Hung gate, red-main PRs, 34 to 53% stall language |
| Guard weakened, fail-open, stale state treated as current | B | B | B | B | 336 + 248 + 199 findings; 31 to 37% labelled broken or unrecoverable |
| Irreversible data loss, out of scope, nonexistent package | B | B | B | B | Not stalls, but not recoverable; scope fence cost 29.7 h on one PR |
| Secret exposed | B | B | B | B | Rare, cheap to prevent, impossible to un-leak |
| Missing test on guard or delivery code | B | B | B | B | 794 missing-test findings, 59% in daemon and guard paths |
| Missing test elsewhere | E | B | B | B | 72% of missing-test findings were advisory-only today |
| Security, high severity | E | E | B | B | No security finding stalled delivery in the window |
| Security, lower severity; standards | D | D | B | B | Same |
| Doc, card or PR-body drift | D | D | D | B | 76% false rate; card diffs worst |
| Simplicity and style | A | A | A | D | Cosmetic findings: 90% advisory-only today |

Debt register entry fields (backlog items of the debt kind): class, impact, severity, confidence, must-pay-before
level, deadline, fix cost, interest, source. This is the SQALE pair (cost to fix, cost of not fixing) with a short
interest note and trigger, not a number.

## Fork 1 — Which source wins when the class is in dispute

Fork-existence: reviewer-only classification (Fork 1 (c)) is the excluded branch. Our record shows the reviewer's
own label and the real root cause disagree (class boundaries mislabel 10 to 15 percent), and the same model that
raised the finding would then set how hard it blocks. Deterministic-only (b) cannot cover the 25 logic classes,
which have no path signature. The two coherent survivors cannot both be the final word on a conflict, so the
settings schema must declare one precedence order. This is a definitions question (the closed class list, how a
class maps onto the existing impact levels and dispositions, and the override-rule schema), not a daemon one; the
evaluator that applies it lives with the implementation.

- (a) **Reviewer tags the class from the closed list; a rule table overrides it by path or pattern.** The reviewer
  fills class and confidence; rules such as "any change under the guard hooks is the guard class" outrank the tag.
  Matches the operator's proposal and `#deterministic-core-thin-judgment`.
- (b) Deterministic classifier only. Predictable, but leaves most classes unclassifiable.
- (c) Reviewer only. Rejected: self-assigned stringency, no check.

Recommended default: **(a)**. Low reviewer confidence caps the outcome at advisory except for the always-block
classes, where low confidence goes to a second check instead. An unknown class or a gap in the override table
is a block, never a downgrade (fail closed, stated in the schema).

Skeptic: SURVIVES-WITH-AMENDMENT -> "class" is declared as a mapping onto impact and dispositions (statute
composition above), the deterministic-override half cites `#deterministic-core-thin-judgment`, and the
fail-closed rule is explicit so an incomplete table cannot downgrade a block. The config-dimension attack failed:
one side must win a conflict.
Screen: flagged(impl) -> reframed from "reviewer or daemon behaviour" to the definitions the standard side owns
(class list, mapping, override schema); the evaluator stays implementation-side.

## Fork 2 — A level move while debt due at it is open

Fork-existence: letting the move proceed with a warning (Fork 2 (c)) is the excluded branch. A due-before-level
date with no gate is the advisory outcome under another name, and the register would stop meaning anything.
Between (a) and (b) the difference is who can lift a block.

- (a) **Block the move.** The only way past is to pay the debt, or for the operator to edit that debt item's
  must-pay-before level, which is a visible, recorded change.
- (b) Block unless the operator waives at the gate. Faster, but the waiver is invisible to the register.
- (c) Warn only. Rejected.

Recommended default: **(a)**. Matches the proposal and SRE practice (halt, with named exceptions). The SRE
exception covers P0 and security fixes landing during a freeze; it is an analogy for halting, and does not
conflict with the table putting high-severity security at expedite, since expedite is about the PR that
introduces the issue.

Skeptic: SURVIVES - beat the config-dimension attack (a recorded edit to the debt item is the waiver, so (b)
adds nothing but invisibility). Its SRE citation is analogy-scope only.
Screen: clear - policy semantics with a real auditability merit.

## Fork 3 — What a debt item is

Fork-existence: a free-form note outside the backlog (Fork 3 (c)) is the excluded branch, because the level gate
must query it and the backlog is already the tracker. Between (a) and (b): a new kind changes the shared kind
axis and its sizing and buildability rules; fields on a task leave the axis alone.

- (a) **A new backlog kind `debt`.** Registered in `we:scripts/check-standards-rules.mjs:364`, queried by kind.
  Matches the proposal.
- (b) Kind `task` plus debt frontmatter fields, queried by field. No kind-axis change.
- (c) A separate register file. Rejected.

Recommended default: **(a)**, medium confidence, with a hard precondition: the one build slice that registers the
kind must also define its size rule and its buildable rule (every kind except `decision` ships work), and update
every reference to the kind set (about eight files use it). If that slice cannot ship together, (b) wins.

Skeptic: SURVIVES-WITH-AMENDMENT - a weak lean: eight files reference the kind set, so the precondition above is
now part of the default rather than a footnote. Not flipped, because the operator's proposal and a typed kind give
the level gate a one-field query.
Screen: clear - a kind-axis precedent against schema drift is a merit difference.

## Context

Provenance: the internal findings catalogue (every rejection and hold reason in code, plus the 14-day
cluster table) and the external models note are summarised above; the full tables live in the session report.
Proof requirement for the eventual build: before and after on a live PR, and a re-count of auto-block overrides
and not-real rulings over a fresh window.

## Acceptance

Doc-only exemption: this card rules a design, so its acceptance is an inspectable handoff; executable behavior
is owned by the still-open epic and slices listed below.

- [A1] **Inspection** — trace `decision-design-handoff` confirms the ruled choices and inherited invariants are
  codified at `we:docs/agent/platform-decisions.md#review-stringency-classified-outcomes`, with build ownership
  in [epic 6236](/backlog/6236-we-review-stringency-build-classed-findings-per-level-outcom/). This resolved
  decision delivers the design handoff; it does not claim a shipped settings validator.
- [A2] **Inspection** — trace `decision-acceptance-owners` maps class validation to slice 1 A1–A3; settings schema,
  monotonicity and ruling failures to slice 2 A1–A18; debt lifecycle, authority and provenance to slice 3 A1–A12;
  panel safety to slice 4 A1–A6; advisory recording/lessons to slice 5 A1–A8; live before/after and recount proof
  to epic A3–A4. Those cards remain open until their executable tests and evidence are delivered.

## Risks

A stricter level could accidentally relax a block (slice 2 A6). Missing or injected reviewer fields could become
advisory (slice 2 A8–A9). Forged authority or mutable debt fields could bypass the gate (slice 2 A10, slice 3
A6–A10). Unpinned defaults or a pending-only second-check contract could change behaviour (slice 2 A12/A17),
and universal quadrant checks could collapse non-block outcomes (slice 2 A5/A18). Debt display prose could
become policy (slice 3 A12); advisory prose could become stored prompt injection (slice 5 A5). Fixture success alone cannot show
delivery impact; epic A3–A4 require a live PR and fresh-window measurement. This PR rules and specifies those
checks; the implementation remains owed by the open epic and slices.

## Test plan

For this decision, inspect the statute and acceptance-owner trace (A1–A2), and run the scoped documentation
standards gate. During implementation, each slice adds and runs its named tests, followed by epic A1–A2
production-path tests, A3 live-PR evidence and A4 recount. The validator originally stated here is owned by
slice 2 A1 (`settings-table-schema`), A6 (`monotonic-levels`) and A7 (`table-gap-blocks`).

Planned implementation mapping (files below are not delivered by this decision PR). Each named case's
acceptance line in the owner card supplies its detailed observable assertions; every slice now also has
Risks and Test plan sections assigning all acceptance cases to its planned file.

| Risk / guarantee | Repository-qualified planned file; named cases | Observable assertion |
|---|---|---|
| Closed classes and row selection | `we:scripts/__tests__/review-stringency-classes.test.mjs`; `class-mapping-complete`, `unknown-class-fails-closed` | Pin exact tokens and unique row mappings; invalid input refuses. |
| Relaxed levels / wrong table cell | `we:scripts/__tests__/review-stringency-ruling.test.mjs`; `monotonic-levels`, `ratified-table-cells`, `override-precedence` | Reject relaxed blocks and conflicting rules; pin every class/severity/level outcome, including both security rows. |
| Malformed reviewer fields / missing provenance | `we:scripts/__tests__/review-stringency-ruling.test.mjs`; `malformed-finding-blocks`, `unreadable-table-blocks`, `cell-cascade-source-logged` | Missing/invalid consumed fields block; quadrant validation is conditional on ordinary debt admission; each consumed cell/scalar persists its winning cascade source/revision. |
| Wrong initial settings / incomplete second check / unreachable outcomes | `we:scripts/__tests__/review-stringency-ruling.test.mjs`; `ratified-initial-settings`, `always-block-second-check`, `non-block-outcomes-reachable`, `careless-debt-block` | Independently pin literal defaults; only verified not-real removes its own block; expedite/advisory need no quadrant and ordinary debt requires confirmed admission. |
| Forged settings authority / trust-root edits / resource abuse | `we:scripts/__tests__/review-stringency-ruling.test.mjs`; `forged-settings-operator`, `allowlist-and-gate-self-protection`, `review-ingress-bounds` | Invalid approval, PR-edited roots, token access and over-limit input cannot authorize a write. |
| Debt tampering / race / unreadable inventory | `we:scripts/__tests__/review-stringency-debt.test.mjs`; `debt-item-tamper`, `debt-approval-provenance`, `debt-register-unreadable`, `debt-gate-revision-race`, `debt-source-required` | Invalid transitions refuse and debt stays effective; no missing-quadrant admission or stale-writer bypass. |
| Register display-text injection | `we:scripts/__tests__/review-stringency-debt.test.mjs`; `debt-display-text-inert` | Injected instructions/markup round-trip as data, cannot change policy/payment/authority, and unpaid due debt still blocks through both register representations. |
| Missed escalation / silent staleness | `we:scripts/__tests__/review-stringency-debt.test.mjs`; `expedite-deadline-escalation`, `debt-staleness-resurface` | N+1 same-class debts aggregate; unpaid debt resurfaces at first and second threshold crossings without expiry. |
| Panel disclosure / stale or active content / request abuse | `plateau-app:tests/debt-panel.spec.ts`; `debt-panel-untrusted-content`, `debt-panel-unavailable`, `debt-panel-read-only-scope`, `debt-panel-revision-refresh`, `debt-panel-request-bounds` | Inert content, authenticated read-only scope, unavailable indication and bounded same-origin reads. |
| Stored lesson injection / partial output | `we:scripts/__tests__/review-stringency-lessons.test.mjs`; `lesson-content-template-only`, `lesson-input-unreadable`, `lesson-input-bounds` | PR prose never enters instructions; incomplete/over-limit input publishes nothing and advances no checkpoint. |
| Production wiring | `we:scripts/__tests__/review-stringency-integration.test.mjs`; `review-stringency-outcomes-e2e`, `review-stringency-level-gate-e2e` | Observe production merge/queue/ledger effects and enforced level gate through actual entry points. |
| Delivery impact / false blocks | `we:scripts/__tests__/review-stringency-recount.test.mjs`; `review-stringency-override-recount`; epic A3 inspection evidence | Pin deduplication/strongest rulings and missing-data errors; attach dated live PR pre/post effects plus fresh-window denominators. |

Decision A1–A2 are inspection evidence: inspect this ruling against statute items 1–10 and each slice's
acceptance/test-file trace. No request endpoint is delivered by this document; body-size, rate limit and
origin requirements are traced to the implementation owners above, with local-job/validator n/a reasons.

## Non-goals

- [N1] The operator-wait, stale-head and process holds. Those stay with the process-hold work.
- [N2] Building the evaluator, register or panel. This card only rules the design.

## Edge cases this change must handle

1. **Untrusted text** — validate class, severity and confidence before evaluation (slice 2 A8); lessons use only trusted templates (slice 5 A5). Trace: A2.
2. **Truncated reads** — an unreadable finding or table blocks (slice 2 A9); an incomplete debt register blocks the move (slice 3 A9). Trace: A2.
3. **Shared state files** — revision-checked atomic writes preserve validated settings/debt across races and crashes (slice 2 A11, slice 3 A10). Trace: A2.
4. **Fail closed** — unknown class, empty cell and lower-block relaxation refuse (slice 1 A2, slice 2 A6–A9). Trace: A2.
5. **Identity scoping** — debt names source repository/PR/finding (slice 3 A8); approvals bind exact repository and revisions (slice 2 A10). Trace: A2.
6. **State over time** — overdue expedite and 45-day debt re-surface without expiry (slice 3 A2–A3). Trace: A2.
7. **Who wrote it** — authenticated protected CI evidence, never agent-supplied claims, authorizes effective settings/debt transitions (slice 2 A10, slice 3 A6–A7). Trace: A2.
