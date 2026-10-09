---
bornAs: xx2620y
kind: epic
status: open
dateOpened: "2026-10-08"
preparedDate: "2026-10-08"
preparedAgainstSha: "8c38bb29412dab7ff4a15e7a8dda21e1542c7f47"
tags: []
---

# Task agreement on every card: required Acceptance and Non-goals, and reviewers judge the diff against them

Umbrella for the task-agreement rule; sliced 2026-10-08 into S1 #xdeqs8k, S2 #xbb6fgj, S3 #xk8lm2t, S4 #xphujml, S5 #x6f9vwo, S6 #xdg7er2, S7 #x251p1l (see `## Slices`). Every buildable card carries `## Acceptance` and `## Non-goals` with `[A#]`/`[N#]` items, checked at prepare and judged by the correctness juror as a floor.

Operator 2026-10-08 (from the Harness Engineering article review): every buildable card should say what "done" means and what is deliberately out of scope, and reviewers should judge the diff against that list, so a build that solves an easier task and calls it done is caught. **Prepared and ruled 2026-10-08: see `## Ruling` below, which supersedes the prepared defaults where they differ (Fork 1 adds a one-off refresh; Fork 3 picks `## Acceptance` with cite-able `[A1]`/`[N1]` items).** Measured on `main` @ `8c38bb294` (script under Context): of 1,448 open stories, 646 (44.6%) have a filled `## Done when`/`## Acceptance`, 679 carry only the scaffold TODO, and 38 (2.6%) have a Non-goals section. Acceptance already has a home (`## Done when`, #2949); Non-goals has none; nothing enforces either; jurors never see either. Five forks below, each with a **bold recommended default**, a `Skeptic:` and a `Screen:` line, kept as the prepared record. The review `humanGate` the preparer set is removed now that the forks are ruled; the card was split into the slices below (now an epic with no size; the children carry the points).

## Ruling (ratified 2026-10-08, operator)

Each fork was discussed with the operator in chat on 2026-10-08 before the call. Where a ruling differs from the prepared default below, the ruling wins.

- **Fork 1 — ruled BOTH ("ok").** The rule is (c): the task agreement is checked when a card is prepared for build. On top of that, a **one-off refresh** of the open stories runs now, on spare token capacity: it writes `## Acceptance` and `## Non-goals` into open stories, **nearest-to-build first**, in batches of **about 50 cards per PR**. Every refreshed section is marked **draft**; a draft does not count as agreed until the preparer confirms it at prepare time, so the prepare check stays the rule and the refresh only saves it work. Model routing for the refresh: **Sonnet writes, Haiku 5.5 checks the shape.** Resolved cards are still never touched. This is new slice S2.
- **Fork 2 — ruled BOTH, asymmetric ("ok"), = default (c).** Filing only warns and never refuses. The prepare/dispatch gate is the one that enforces. The `advise → enforce` setting lives at that gate.
- **Fork 3 — ruled body sections named `## Acceptance` and `## Non-goals`, with numbered, cite-able items ("do that").** The operator asked what is best on merit, then agreed to this. It is not the prepared default (a): it is not frontmatter, and the new heading is `## Acceptance`, not `## Done when`. Each item is one line with a stable id: `- [A1] …`, `- [A2] …` under `## Acceptance`, and `- [N1] …` under `## Non-goals`, so reviewers and the gate can cite an item by id. The shared reader also accepts the legacy `## Done when` as an alias for `## Acceptance` during migration; new cards are written with `## Acceptance`. This re-opens #2949's choice of heading on purpose. #2949's reason for `## Done when` (it is a provenance-lint escape zone for not-yet-built paths) is kept by giving `## Acceptance` the same escape, so every code path that hard-codes `## Done when` today moves to the shared reader (new slice S7).
- **Fork 4 — ruled (b) ("ok").** The correctness juror gets the list and cites `A#`/`N#` in its findings. No new dedicated lens. A new step in the review read looks up the PR's card (PR → card ids → `## Acceptance`/`## Non-goals` on `main`).
- **Fork 5 — ruled FLOOR, (b) ("ok").** The list is the minimum. Reviewers may still block on a real defect the list does not name. A build PR that weakens its own card's criteria is flagged; the juror judges against the `main` copy.

**Codification.** The card is a `kind: epic` and stays open until its slices land, so `codifiedIn` (set when a `kind: decision` resolves) does not apply yet. The reusable rule (every buildable card carries `## Acceptance` and `## Non-goals` with `[A#]`/`[N#]` items; checked at prepare; reviewed as a floor) is written into `we:docs/agent/backlog-workflow.md` by slice S6.

**Slice numbers.** The slice table below is renumbered for the ruling (new S2 refresh, new S7 reader migration). The fork text keeps the prepared numbers: its S2 is now S3, S3 is S4, S4 is S5, and S5 is S6.

## Recommended path at a glance (prepared defaults — see Ruling above for what was decided)

| fork | recommended default | main alternative | confidence |
|---|---|---|---|
| Fork 1 — rollout for existing cards | **(c) just-in-time: checked when a card is prepared for build; resolved cards never touched** | (a) grandfather by `dateOpened` | high |
| Fork 2 — where enforcement lives | **(c) both, asymmetric: file-item always advises, the prepare/dispatch gate is the one that flips advise → enforce** | (b) dispatch only | med-high |
| Fork 3 — section format | **(a) body sections: keep `## Done when`, add `## Non-goals` after it, one line per item** | (b) frontmatter fields | high |
| Fork 4 — how jurors use the list | **(b) the review read gains a card lookup; the list is fenced input to the correctness juror, which owns "meets every line"** | (a) a new dedicated lens | med |
| Fork 5 — diff meets the list, reviewer still thinks it is wrong | **(b) the list is a floor, not a ceiling: other findings still route through the existing three-question disposition** | (a) the list is a ceiling | high |

## Supported by default (not decisions)

- **The enforcement knob is a config value, not a fork.** One committed JSON policy file in the style of `we:scripts/lib/dispatch-size-policy.json`, with its own validator (like `validateSizePolicy` over the two-value `UNSIZED_CARD_POLICIES` enum at `we:scripts/lib/dispatch-contracts.mjs:804`), holding `taskAgreementPolicy: off | advise | enforce`. Both `advise` and `enforce` are legitimate end states of one setting, so this is a knob, not a fork. `dispatchPlan` reads no settings file for the prepare gate today (its `preparePolicy` is a hard-coded object at `we:scripts/readiness/dispatch-plan.mjs:1110`), so the new policy is threaded in beside it by the IO shell. Default at landing: `advise`. A missing or invalid policy file is read as `enforce` with the reason reported, never as a silent `advise`, and S4 tests the setting through the real `we:scripts/backlog.mjs` path. Suggested flip trigger to `enforce`: the prepare agent has written both sections on 20 consecutive prepares with no `could-not-prepare` escalation caused by them.
- **Which kinds.** The same set the prepare gate already uses (`we:scripts/readiness/dispatch-plan.mjs:604`): story and task are checked; `fix`/`ci-heal` (`sizeExempt`, `:578`) and `prepare-item` (its own clause on `:604`) are exempt; epic, feature, decision and investigation never build, so they are never checked.
- **One reader module.** Whatever layout Fork 3 picks, one pure module (`we:scripts/backlog/task-agreement.mjs`, mirroring `we:scripts/backlog/edge-case-classes.mjs`) owns the headings, the skeleton and `readTaskAgreement(body)`; the scaffold, `prepareCardStatus`, the health audit and the review read all import it. That is internal code shape, not a call.
- **Resolved cards are never touched** under any option (3,410 of 5,390 cards are not open or active).
- **An explicit `n/a: <why>` line satisfies Non-goals**, the same escape the edge-case section uses (`we:scripts/backlog/edge-case-classes.mjs:51`). A bare `none` or a leftover `TODO` does not.
- **The prepare agent's `## MVP` keeps its job** (the Musts cut). Its "deliberately OUT of scope" sentence (`we:skills-src/conveyor/prepare-item-agent-brief.md:46`) moves to `## Non-goals`, so the out-list has one home.

## Fork 1 — rollout for the existing cards

*Why this is a fork:* the old open cards are either checked before they build or exempt forever; one card cannot be both. Branch (a) is excluded on merit: it leaves the failure the card targets in place on the 1,211 unprepared open stories, which will build under the old rules.

Crux: 1,980 cards are open or active (1,448 stories, 282 tasks). Every story already passes through a prepare pass before build, because the dispatcher holds an unprepared story `needs-prepare` (`we:scripts/readiness/dispatch-plan.mjs:604`), and that gate is live (`:1110`). Prepared stories already carry filled `## Done when` in 225 of 237 cases, but Non-goals in only 2.

- **(a) Grandfather.** Only cards with `dateOpened` after the cutover must carry both sections. Cheap and quiet. *Rejected:* the 1,211 unprepared open stories would still build with no agreement; the rule would take a year to matter.
- **(b) Backfill now.** A sweep writes both sections into all 1,730 open stories and tasks. *Rejected:* criteria written months before the build go stale against moving code. The repo already holds prepares to a staleness check for exactly this reason (`prepare-stale`, `we:scripts/readiness/dispatch-plan.mjs:612`). Many of those cards will be re-scoped, merged or dropped before they build.
- **(c) Just-in-time, at prepare (recommended).** The rule is checked when a card is prepared for build. The prepare agent, which already reads the code and writes `## Design`/`## MVP`/`## Test plan`, also writes `## Done when` and `## Non-goals`. Cards already stamped before the rule are sent back through prepare once the knob reads `enforce` (Fork 2). The criteria are written against the code as it is when the build starts, by an agent that is not the builder, and reviewed by `review-prep` (`we:scripts/operations/review-prep.mjs`).

**Default: (c).**

*How it composes with #2949.* #2949 says "author criteria at file time, in one pass — never let the implementing lane write its own" (`we:docs/agent/backlog-workflow.md:398`). That rule stays the primary path for new cards (Fork 2 keeps file-time authoring, as advice). Just-in-time at prepare is the fallback for a card that reached prepare without them, and it keeps the half of #2949 that matters for anchoring: the prepare agent is not the implementing lane. The #2949 text gains one sentence saying so (slice S5), so the two rules do not read as a collision.

*Accepted limit.* The dispatcher-side hold reaches only builds the conveyor dispatches. A hand-dispatched build, or a run with `--no-prepare-check` (`we:scripts/readiness/dispatch-plan.mjs:1110`), skips it, exactly as it already skips the `needs-prepare` gate. The review side (Forks 4 and 5) is the backstop for those paths.

Skeptic: SURVIVES-WITH-AMENDMENT → beat "the gate misses builds outside the dispatcher" by naming it as an accepted limit with the review side as backstop; the #2949 citation was downgraded from authority to a stated composition (file time first, prepare as fallback).
Screen: clear — which cards get checked, and when, is visible to the operator.

## Fork 2 — where enforcement lives (file-item, readiness, or both)

*Why this is a fork:* the question is where the knob's `enforce` value bites, and branch (a) is broken: refusing at file time loses the capture. A conveyor session that files a discovery mid-run often cannot name non-goals yet, so it would either drop the card or write filler to pass the gate.

Crux: `file-item` takes only `title` and `digest` as prose (`we:scripts/operations/file-item.mjs:126-133`); the body comes from the scaffold skeleton, which today emits a `## Done when` TODO (`we:scripts/backlog/scaffold.mjs:115`). The readiness side already has a section checker, `prepareCardStatus`, with a fixed `REQUIRED` list (`we:scripts/conveyor/prepare-result.mjs:4`), used by the probation runner and `prepare-stamp-land`.

- **(a) file-item only, refusing.** *Rejected:* loses captures, invites `Non-goals: none` filler, and never reaches the 1,730 existing cards.
- **(b) readiness only.** One gate at the moment it matters. Leaves new cards with no prompt at birth, so every card arrives at prepare empty.
- **(c) both, asymmetric (recommended).** `file-item` never refuses: the skeleton gains a `## Non-goals` TODO next to `## Done when`, two optional inputs (`acceptance`, `nonGoals`) fill them when the filer knows, and the verdict carries a warning when they are empty. The gate that flips with the knob is at prepare: `prepareCardStatus` requires both sections (so `prepare-stamp` and the probation runner refuse a stamp without them), and `dispatchPlan` holds an already-stamped card that lacks them with a new reason `needs-task-agreement`, which routes it back to the prepare agent. Under `advise` the same checks only log.

**Default: (c).**

```js
// Fork 2 (c) — we:scripts/conveyor/prepare-result.mjs, sketch. Today the function takes only `raw` (:35);
// the policy becomes an optional second argument, injected by the IO callers, so the module stays pure.
import { readTaskAgreement } from '../backlog/task-agreement.mjs';
const TASK_AGREEMENT_POLICIES = new Set(['off', 'advise', 'enforce']);
export function prepareCardStatus(raw, { taskAgreementPolicy } = {}) {
  // A missing or invalid policy reads as `enforce` (fail closed, per the ruling), never as a silent `advise`.
  // `advise` is only ever the committed value in the policy file, not a code fallback; callers report the reason.
  const policy = TASK_AGREEMENT_POLICIES.has(taskAgreementPolicy) ? taskAgreementPolicy : 'enforce';
  const stamp = readField(raw, 'preparedDate');
  const body = String(raw).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').replace(/<!--[^]*?-->/g, '');
  const sections = readSections(body);
  const hasPrepare = REQUIRED.every((name) => Boolean(sections.get(name)?.trim()));
  const agreement = readTaskAgreement(body);
  const agreed = agreement.acceptance.length > 0 && agreement.nonGoalsAnswered;
  return {
    preparedDate: /^\d{4}-\d{2}-\d{2}$/.test(stamp ?? '') ? stamp : null,
    hasSections: hasPrepare && (policy !== 'enforce' || agreed),
    agreement, // callers log `agreed === false` under `advise`
  };
}
```

*New hold reason.* `needs-task-agreement` has no exact precedent: `needs-prepare` covers "never stamped" and `prepare-stale` covers "stamp too old". This one covers "stamped, but the stamp predates the rule". It routes to the same prepare agent as the other two.

Skeptic: SURVIVES-WITH-AMENDMENT → beat "file-item refuse vs warn is just a knob value" (it is, which is why the fork is placement, not mode); fixed the sketch's signature (`prepareCardStatus` takes only `raw` today) and stated that the policy must be threaded into `dispatchPlan` beside its hard-coded `preparePolicy`.
Screen: clear — whether captures are kept and which gate holds a card are both visible behaviour.

## Fork 3 — where the author writes the list on the card

*Why this is a fork:* the author, the reviewer and the rendered backlog page all need one place to find the list. Two homes (body sections and frontmatter fields) would drift, and every reader would have to merge them.

Crux: `## Done when` is already the ruled heading (#2949, `we:docs/agent/backlog-workflow.md:403`), and 2,392 cards use it. Frontmatter is read with a single-line regex (`readField`, `we:scripts/backlog/frontmatter.mjs:37`), and the backlog page renders the body, not the frontmatter. The repo already reads card sections by heading (`readSections`, `we:scripts/conveyor/prepare-result.mjs:7`).

- **(a) Body sections (recommended).** Keep `## Done when` as the acceptance section (legacy `## Acceptance` and `## Acceptance criteria` read as aliases, never written). Add `## Non-goals` right after it. Each criterion or non-goal is one numbered or bulleted line, so a script can count them and a reviewer can cite "line 3".
- **(b) Frontmatter fields** (`acceptance: [...]`, `nonGoals: [...]`). Strictly structured. *Rejected:* criteria are prose with backticks, colons and commands, which is fragile as YAML; the rendered page would not show them; and the 2,392 existing `## Done when` sections would need moving or a second reader.
- **(c) Body sections, but rename to `## Acceptance`.** Matches the card's own wording. *Rejected:* #2949 chose `## Done when` because it is a provenance-lint escape zone for not-yet-built paths; renaming re-opens a ruled call for no gain.

**Default: (a).** *Superseded by the Ruling: `## Acceptance` + `## Non-goals` with `[A#]`/`[N#]` items; `## Done when` read as a legacy alias.*

```markdown
<!-- Fork 3 (a) — the card layout an author writes -->
## Done when

1. **Executable** — `npm run test:unit -- some.test.mjs` fails before and passes after.
2. **Observable** — the hold reason `needs-task-agreement` appears in the dispatch-eligibility output.

## Non-goals

1. Backfilling resolved cards.
2. n/a: <why> — the accepted escape when there is genuinely nothing to exclude.
```

Skeptic: SURVIVES — beat "a heading reader is too loose for a gate" (`readSections` is fence-aware and lowercases names, which handles `## Done when` and `## Non-goals`); no anchor in `we:docs/agent/platform-decisions.md` governs card section layout.
Screen: flagged(impl) → rewritten: the fork now asks where the author writes the list (body vs frontmatter), and the single reader module moved to "Supported by default".

## Fork 4 — how jurors use the list

*Why this is a fork:* one question ("did the diff do what the card agreed?") needs one owner. A dedicated lens and correctness both judging it would give two verdicts on the same axis, and a split between them would escalate for noise.

Crux: today a juror's "goal" is only the PR title (`we:scripts/operations/review-pr.mjs:1251`) or a one-sentence `--goal` (`we:scripts/converge-cli.mjs:337`). Both are fenced into the mandate by `buildSubjectMandate` (`we:scripts/lib/jury-core.mjs:2392`, "Judge it against THAT goal"). Correctness's registered bar already reads "does what the spec says" (`we:scripts/lib/review-core.mjs:1915`); the spec is just never handed over. **The PR review does not read the card today:** nothing in `we:scripts/operations/review-pr.mjs` or `we:scripts/operations/review-pr-io.mjs` resolves a backlog card, and only `review-prep` holds a card body. A PR can be mapped to its card ids through `deliveredItemNumsFromPr` (`we:scripts/lib/open-pr-items.mjs:149`), which reads the `lane/<slug>` branch grammar and can return no id or several (a batch).

- **(a) A dedicated `task-agreement` lens.** Clear ownership and its own verdict row. *Rejected for now:* duplicates correctness's existing bar, adds one juror to every PR, and the repo's rule for a new lens is measured evidence (claim-accuracy was added on a 27-case cross-tab, `we:scripts/lib/jury-core.mjs:1386`). There is no such measurement yet.
- **(b) Input to the correctness juror, which owns the check (recommended).** The review read gains a card lookup (new work in slice S4): PR → card ids → each card's `## Done when` and `## Non-goals` lines, read from `main`. With no id, the goal stays title-only, as today; with several, each card's list is labelled by its id. The lines go, fenced as data, into the goal block of the **correctness** juror only, in review-pr and converge. The other lenses keep the title-only goal, so the Non-goals text cannot invite scope findings from security, simplicity or standards-conformance. Correctness's expectation gains one clause: every Done-when line is met, and no Non-goal is built. Once the review corpus (`we:scripts/review-corpus/`) shows whether correctness misses "solved an easier task" cases, promoting to a lens is a separate, evidence-based call.
- **(c) A script runs the executable criteria, no juror.** *Not a rival:* tier-1 lines are commands, and running them is a good follow-up, but tier-2/3 lines and non-goals still need a reader. Listed as a follow-up, not a branch.

**Default: (b).**

```js
// Fork 4 (b) — we:scripts/operations/review-pr.mjs, sketch. `read.cards` is NEW: the io shell resolves
// deliveredItemNumsFromPr(headRefName, title, …) → each card's body on main → readTaskAgreement(body).
const agreementGoal = (title, cards = []) => [title, ...cards.map(({ id, agreement }) =>
  `CARD ${id} — DONE WHEN:\n${agreement.acceptance.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n`
  + `NON-GOALS:\n${agreement.nonGoals.map((l, i) => `${i + 1}. ${l}`).join('\n')}`)].join('\n\n');
const goal = lens === MANDATE_LENSES.CORRECTNESS ? agreementGoal(read.title, read.cards) : read.title;
buildPanelMandate({ lens, netChangedFiles: read.netChangedFiles, goal, fenced: true, aim });
```

Skeptic: SURVIVES-WITH-AMENDMENT → the skeptic refuted the premise "the review read resolves the card" (it does not; grep of the review-pr files finds no card read). Kept (b) on merit, but the card lookup is now named as new work in S4, the zero-id and batch cases are specified, and the list goes to the correctness juror only, which removes the scope-creep risk from the other lenses.
Screen: clear — whether a dedicated lens exists changes verdict rows and review cost the operator sees.

## Fork 5 — the diff meets the list, but a reviewer thinks it is still wrong

*Why this is a fork:* meeting the list either ends the review (ceiling) or does not (floor). The two cannot both hold, and the ceiling is broken: no list can name every regression, so a diff that meets every line but adds a security hole would land.

Crux: every finding already routes through three questions (introduced? worse than base? fixable in parallel?), and only "yes, yes, no" blocks (the DISPOSITION clause, `we:scripts/lib/jury-core.mjs:2403`).

- **(a) Ceiling.** Meeting every line means accept; other findings become carve-outs automatically. *Rejected:* lets a correct-on-list diff with a real regression land.
- **(b) Floor (recommended).** A missing Done-when line or a built Non-goal blocks on its own (it is introduced by definition). Any other finding is judged by the existing three questions, unchanged. If the reviewer thinks **the list itself** is wrong (too weak, wrong target), that is a carve-out to amend the card. A **build** PR that edits its own card's `## Done when` or `## Non-goals` gets that edit flagged to the correctness juror, and the juror judges against the `main` copy, because weakening criteria must stay a visible, separate change (#2949, `we:docs/agent/backlog-workflow.md:398`). **Prepare** PRs are exempt: writing those sections is their job, and `review-prep` judges them.
- **(c) Escalate every disagreement to a human.** *Rejected:* puts the operator back in every review the list was meant to settle.

**Default: (b).**

Skeptic: SURVIVES-WITH-AMENDMENT → the floor held; the "PR may not edit its own card" clause collided with prepare and resolve lanes that legitimately edit cards, so it is now scoped to build PRs, and the edit is flagged rather than refused.
Screen: clear — whether a diff with a regression can land once it meets the list is visible policy.

## Slices (forks ratified 2026-10-08; total ~26 points, so this card splits)

| slice | size | touch-set | blocked by |
|---|---|---|---|
| S1 — reader module, skeleton `## Non-goals` section and setting: **built on `main`** (e0da013e4, PR 4484, card xj67z1d). What stays open as #xdeqs8k: switch the reader's draft marker from the HTML comment `<!-- agreement: draft -->` to the visible line `Draft: model-written, not yet confirmed.` | 2 | `we:scripts/backlog/task-agreement.mjs`, `we:scripts/backlog/__tests__/task-agreement.test.mjs` | — |
| S2 — one-off refresh of open stories (Fork 1 ruling) | 5 | a new refresh runner under `we:scripts/backlog/` with its test, then the open `backlog/*.md` stories it rewrites, about 50 cards per PR | S1, S7 |
| S3 — file-item warns | 2 | `we:scripts/operations/file-item.mjs`, `we:scripts/operations/scaffold.mjs`, `we:skills-src/file-item/SKILL.md`, `we:scripts/operations/__tests__/` | S1 |
| S4 — prepare + dispatch gate | 5 | `we:scripts/conveyor/prepare-result.mjs`, `we:scripts/readiness/dispatch-plan.mjs`, `we:scripts/backlog.mjs`, `we:skills-src/conveyor/prepare-item-agent-brief.md`, `we:scripts/readiness/__tests__/` | S1, S7 |
| S5 — correctness juror reads the list | 5 | `we:scripts/lib/review-core.mjs`, `we:scripts/operations/review-pr.mjs`, `we:scripts/operations/review-pr-io.mjs`, `we:scripts/converge-cli.mjs`, `we:scripts/operations/review-prep.mjs`, `we:skills-src/converge/SKILL.md` | S1 |
| S6 — docs + health audit (the rule, the #2949 composition sentence, the heading change) | 3 | `we:docs/agent/backlog-workflow.md`, `we:scripts/audit-backlog-health.mjs` | S1 |
| S7 — move hard-coded `## Done when` readers to the shared reader (Fork 3 ruling) | 3 | `we:scripts/lib/citation-check.mjs` (`PROVENANCE_ESCAPE_HEADINGS`), `we:scripts/check-standards-rules.mjs` (Must-cite, TODO-placeholder and scope guards), `we:scripts/check-standards.mjs`, `we:scripts/operations/codex-worker.mjs`, `we:scripts/lib/probation-launcher.mjs`, plus `we:scripts/backlog/scaffold.mjs` (the skeleton's switch to `## Acceptance` lands here, once the readers recognize it), their tests | S1 |

**S2, the refresh (Fork 1 ruling).**

- Order: nearest-to-build first, by the dispatch/readiness rank (prepared stories first, then the rest by rank).
- Skip any card that is `active`, held by an open PR or a registered scope (the free-scope check), or that already has a filled, non-draft `## Acceptance` and `## Non-goals`. An existing `## Done when` is renamed to `## Acceptance` and its lines get `[A#]` ids; its meaning is not changed.
- Every section the refresh writes carries a draft marker that the S1 reader exposes. The marker is a visible line, never an HTML comment: the first non-blank line under the heading is `Draft: model-written, not yet confirmed.` `prepareCardStatus` strips `<!--…-->` comments before it reads sections, so a comment marker would be invisible to the S4 gate and would fail open. Under `enforce`, S4 treats a draft section as not agreed, and the prepare agent confirms it by removing the marker line after checking it against the code.
- The runner's code inserts the draft marker line after the model output; the model is never trusted to write it, because a missing marker would read as agreed.
- Sonnet writes each card's sections. Haiku 5.5 checks only the shape (headings present, `[A#]`/`[N#]` ids, no `TODO`, `n/a: <why>` used correctly, the draft marker line present) and sends a failing card back once; a second failure leaves the card untouched and logged.
- About 50 cards per PR, each PR through `open-pr` and the normal review.
- S2 waits for S7, so a card that switches to `## Acceptance` does not lose the provenance escape or the Must-cite check.

**Already on `main` when this card was reviewed:** the S1 reader, the numbered format and the setting (e0da013e4), and the S7 reader move with the skeleton switch to `## Acceptance` (cecdc6a92). The landed reader uses an HTML-comment draft marker, which this epic rejects; #xdeqs8k is now only that correction, and S2 and S4 wait on it.

**Filed 2026-10-08:** S1 #xdeqs8k (now 2: the marker correction only), S2 #xbb6fgj (5, blocked by S1 and S7), S3 #xk8lm2t (2), S4 #xphujml (5, blocked by S1 and S7), S5 #x6f9vwo (5), S6 #xdg7er2 (3), S7 #x251p1l (3); S3–S7 are each blocked by S1.

S4 also waits for S7: the prepare brief writes `## Acceptance`, so the readers that still key on `## Done when` must move first or prepared cards would lose the Must-cite, TODO-placeholder and provenance checks. S3, S5, S6 and S7 have disjoint touch-sets and can run in parallel after S1; S4 follows S7. The setting flip from `advise` to `enforce` is a one-line config change after S4, on the trigger above.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/backlog/__tests__/task-agreement.test.mjs` passes: `readTaskAgreement` reads `## Acceptance` and its legacy alias `## Done when`, reads `## Non-goals`, returns each `[A#]`/`[N#]` id with its line, drops TODO lines, treats `n/a: <why>` as answered, and reports a draft marker, which is the visible line `Draft: model-written, not yet confirmed.`, never an HTML comment (the module landed in e0da013e4; the visible-line marker fails before #xdeqs8k).
- [A2] **Executable** — a `dispatch-plan` test holds a stamped story with no `## Non-goals`, or with a draft-marked section, as `needs-task-agreement` under `enforce`, and dispatches it under `advise`.
- [A3] **Executable** — a `review-pr` mandate test shows a PR whose card has `[A#]` lines carries those lines, with their ids, inside the correctness juror's fenced goal block and not in any other lens's; a PR with no resolvable card keeps the title-only goal.
- [A4] **Executable** — a `citation-check` test shows an unresolved path under `## Acceptance` gets the same provenance escape as one under `## Done when` (S7).
- [A5] **Observable** — after S2, every open story it processed has `## Acceptance` and `## Non-goals` with ids, marked draft, in PRs of about 50 cards each, nearest-to-build first.
- [A6] **Observable** — re-running the measurement script under Context after S4 shows every story stamped after the flip has both sections, not draft.

## Non-goals

- [N1] Touching resolved cards.
- [N2] Treating the S2 refresh as agreement: refreshed sections stay draft until the preparer confirms them.
- [N3] A new review lens (Fork 4 (a)); revisit only on review-corpus evidence.
- [N4] Refusing a card at filing time (Fork 2 (a)).
- [N5] Treating the list as a ceiling (Fork 5 (a)): meeting it does not wave through a real defect.
- [N6] Running tier-1 criteria automatically at review (a follow-up).
- [N7] Changing the edge-case section or the `## MVP` Musts cut beyond moving the out-of-scope list.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — card criteria are author prose; they reach the juror only inside `fenceUntrusted` (the goal block is already fenced), never as instructions or argv.
2. **Truncated reads** — the PR-to-card lookup must treat an unreadable or missing card as "no card" with a logged reason, never as "empty list = agreed".
3. **Shared state files** — n/a: the knob is a committed JSON file read-only at runtime; no runtime writer.
4. **Fail closed** — under `enforce`, an unparseable section reads as not agreed (hold), never as agreed.
5. **Identity scoping** — a PR resolves to a card by `deliveredItemNumsFromPr`; hash (`bornAs`) and NNN spellings must both resolve to the same card.
6. **State over time** — a card stamped before the flip is re-checked at dispatch, so the flip applies to old stamps too; the `prepare-stale` gate still governs criteria age.
7. **Who wrote it** — for a build PR, the criteria the juror reads come from the card on `main`, not from the PR's own copy, so a build cannot weaken its own bar; a prepare PR is judged by `review-prep` on its own copy, since writing the list is its job. A prepare PR is classified by its diff alone (every changed file is a `backlog/*.md` card file), never by its title or branch name, so a PR that edits criteria and also changes code is a build PR.

## Context

### Measurement (reproducible)

Save the script below in a scratch directory and run it with node, passing the WE `backlog` directory as its one argument. Results on `main` @ `8c38bb294`, 2026-10-08:

| population | n | `Done when`/`Acceptance` heading | heading with real content | TODO only | `## Non-goals`-type heading | any "non-goal / out of scope" mention |
|---|---|---|---|---|---|---|
| all cards | 5,390 | 2,701 | 1,786 (33.1%) | 915 | 102 (1.9%) | 447 (8.3%) |
| open + active, any kind | 1,980 | 1,689 | 881 (44.5%) | 808 | 44 (2.2%) | 151 |
| open + active stories | 1,448 | 1,325 | 646 (44.6%) | 679 | 38 (2.6%) | 111 |
| open + active stories + tasks | 1,730 | 1,558 | 785 (45.4%) | 773 | 39 (2.3%) | 123 |
| open stories, prepared | 237 | 225 | 225 (94.9%) | 0 | 2 (0.8%) | 42 |
| open stories, unprepared | 1,211 | 1,100 | 421 (34.8%) | 679 | 36 (3.0%) | 69 |

The filing note's "~740 of 5,051" and "~345" used a different count; the numbers above are the measured ones. Headings counted as acceptance: `## Done when`, `## Acceptance…`, `## Test plan and/or Done when`. Non-goals headings: `## Non-goals`, `## Not in scope`, `## Deliberately not in scope`, `## Out of scope` (level 2 or 3). "Real content" means at least one non-blank line that is not a scaffold `TODO` or `Hint:` line.

```js
// measurement script — acceptance / non-goals coverage over every backlog card
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
const fm = (raw, k) => { const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/); if (!m) return null;
  const l = m[1].split('\n').find((x) => x.startsWith(`${k}:`)); return l ? l.slice(k.length + 1).trim().replace(/^["']|["']$/g, '') : null; };
function sections(raw) {
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').replace(/<!--[^]*?-->/g, '');
  const out = []; let cur = null; let fence = false;
  for (const line of body.split('\n')) {
    if (/^ {0,3}(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && line.match(/^(#{2,3})\s+(.*)$/);
    if (h) { cur = { name: h[2].trim().toLowerCase(), level: h[1].length, text: '' }; out.push(cur); continue; }
    if (cur) cur.text += line + '\n';
  }
  return out;
}
const ACC = /^(done when|acceptance|test plan (and|\/) done when)/;
const NG = /^(non-goals?|not in scope|deliberately not in scope|out of scope|out-of-scope)/;
const real = (t) => t.split('\n').map((l) => l.trim()).filter((l) => l && !/^Hint:/.test(l)).some((l) => !/TODO/.test(l));
const rows = readdirSync(dir).filter((x) => x.endsWith('.md')).map((f) => {
  const raw = readFileSync(join(dir, f), 'utf8'); const s = sections(raw);
  const acc = s.filter((x) => x.level === 2 && ACC.test(x.name)); const ng = s.filter((x) => NG.test(x.name));
  return { kind: fm(raw, 'kind'), status: fm(raw, 'status'), prepared: !!fm(raw, 'preparedDate'),
    accHeading: acc.length > 0, accFilled: acc.some((x) => real(x.text)), ngHeading: ng.some((x) => real(x.text)),
    ngLoose: /non-goals?\b|out of scope|not in scope/i.test(raw) };
});
const open = rows.filter((r) => r.status === 'open' || r.status === 'active');
for (const [label, set] of [['all', rows], ['open', open], ['open story', open.filter((r) => r.kind === 'story')]]) {
  const c = (k) => set.filter((r) => r[k]).length;
  console.log(label, set.length, c('accHeading'), c('accFilled'), c('ngHeading'), c('ngLoose'));
}
```

### Prior art

- Google-style design docs carry a "Goals and non-goals" section; Shape Up pitches carry explicit "no-gos"; Scrum separates per-story acceptance criteria from a team-wide Definition of Done. All three put the out-list next to the in-list, in the same document, as prose a reviewer reads.
- In this repo: #2949 (the `## Done when` determinism ladder), #4470 (every story is prepared before build), #2950 (the juror goal block), #3035 (a lens is added only on measured evidence).

### Review jury (provisional — pre-registered #2638)

Care level: `elevated`. This jury binds against the item's predicted scope and is re-checked against the real diff at PR open.

| juror | lens | grounding method | pre-registered expectation |
| --- | --- | --- | --- |
| correctness#1 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. |
| security#1 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. |
| simplicity#1 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| standards-conformance#1 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| claim-accuracy#1 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |
