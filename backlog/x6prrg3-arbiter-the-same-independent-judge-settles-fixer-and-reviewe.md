---
kind: story
size: 5
parent: "xaojq81"
status: open
blockedBy: ["xq3kn88"]
scope: ["we:scripts/operations/judge-arbitrate.mjs", "we:scripts/conveyor/stand-down-answer-core.mjs", "we:scripts/lib/finding-bounce.mjs", "we:scripts/operations/__tests__/judge-arbitrate.test.mjs", "we:scripts/conveyor/__tests__/stand-down-answer.test.mjs", "we:scripts/lib/__tests__/finding-bounce.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "e1f0523e0881357fc863f3e88da72e0164eb7091"
tags: []
---

# Arbiter: the same independent judge settles fixer and reviewer disagreements

When a fixer stands down or escalates on a review finding, or the same finding bounces twice, the same independent judge seat reads the finding, the objection, the code and the ratified rules and rules one of three ways: fixer right (record a finding ruling so the PR proceeds), reviewer right (restate the demand for the fixer), or real conflict (file a decision card and escalate with a recommendation). It never overrides a security finding or a mandatory reviewer block alone.

Builds rule 7 of `we:docs/agent/platform-decisions.md#independent-judge-clears-review-human-outside-protected-list` — the answer to decision xne1udi's original question. Runs on ONE PR, by hand; the tick wiring is `xfetp9j`.

## Design

**Runner** `we:scripts/operations/judge-arbitrate.mjs --pr=<n> [--finding=<id>] [--dry-run]`. It accepts two kinds of dispute, and the tick pass (`xfetp9j`) calls it with `--pr` alone for the first and `--pr --finding` for the second:

1. Read the PR and find the dispute. **Shape A, a stand-down** (no `--finding`): find the unresolved stand-down with `latestUnresolvedStandDown` (`we:scripts/conveyor/stand-down-answer-core.mjs`). **Shape B, a twice-bounced finding with no stand-down** (`--finding=<id>`): the runner does not trust the flag; it re-derives the count itself and proceeds only if that finding id was reported in at least two **distinct review rounds that each ended `changes`** on this PR, and the PR has no unresolved stand-down (a stand-down always wins and is handled as shape A). **Data source — the PR's own verdict comments, not the verdict ledger and not the jury log.** `we:scripts/lib/verdict-ledger.mjs` records only a `findingCount` integer (its header says finding text is deliberately not kept there), so it cannot name a finding. The jury log (`we:scripts/lib/jury-ledger.mjs`) is also the wrong source: it is gitignored, local to the clone that ran the review, overridable by `CONVEYOR_JURY_DIR`, and its `round` is the negotiation round inside ONE review run (one run writes its findings at its final round), so two separate bounces both land at round 0 and the log is a single jury run per subject. The durable, clone-independent record is on the PR itself: every bounce posts a structured `🔁 review — changes requested` comment (the heading `parseVerdictComment` in `we:scripts/lib/review-log-claims.mjs` already recognises) whose `### Findings` section lists one bullet per finding as `` - `<file>:<line>` — <summary> … ``. Only comments posted by an `AUTOMATION_LOGINS` member count, the same trust rule the answer marker uses, so a human or PR-author comment cannot fake a bounce. The **finding id** is a new pure export `findingId(finding)` = a sha256 of `file`, a newline and the whitespace-collapsed `summary` — **not** `line`, which moves between rounds as code shifts (the jury fold's own key includes the line and would call a moved finding new). A reworded finding therefore reads as a new finding, which fails toward "not bounced twice", never toward a false arbitration. New pure helpers in `we:scripts/lib/finding-bounce.mjs`: `parseFindingBullets(body)` (the top-level bullets of the `### Findings` section, each split into `file` and `summary`, using the same section scoping as `countFindings`) and `bouncedRounds(comments, id)`, which returns the creation times of the distinct automation-authored `changes` verdict comments that list the id (one entry per comment, so a finding listed twice in one comment counts once); the runner and the pass (`xfetp9j`) share it, so detection and re-verification cannot disagree. A comment that does not parse as a verdict comment, a findings section whose three counts disagree (the existing self-consistency rule), or fewer than two such comments → not bounced twice. The finding text is the latest `review:changes` comment's finding; there is no fixer objection, so the judge is told there is none and is given the two bounced rounds (each round's re-arm comment and the commits pushed between them) in its place. Shape B's `--finding` that does not meet this → exit "nothing to arbitrate". For shape A, only the reason `needs-judgment` from `STAND_DOWN_REASONS` (`we:scripts/conveyor/stand-down.mjs`) is eligible: it is the one stand-down that records a real disagreement or an ambiguous finding. `conflict` is a mechanical same-line merge conflict with `main` — no reviewer and fixer disagree about anything, so a judge ruling cannot resolve it — and `gate-red`, `lane-ref-gone` and the `concurrent-author` pause are likewise mechanical; all of these are skipped, left for the existing conflict-fix and human paths. No stand-down and no valid `--finding` → exit with "nothing to arbitrate".
2. Read the switches; the kill switch also stops the arbiter.
3. Seat the judge exactly as `xq3kn88` does (same seat function, same independence rule): different provider and actor from the PR author, the fixer (in shape B, the fixer of either bounced round), and the reviewer whose finding is disputed. Unknown or equal → no ruling; the stand-down stays for the human.
4. Spawn the judge, tool-free, with the disputed finding, the fixer's stand-down text, the diff, and the ratified rules the finding cites. Schema: `{ outcome: "fixer-right" | "reviewer-right" | "real-conflict", restatedDemand?: string, recommendation?: string, reasoning: string, touchesSecurityOrMandatoryBlock: boolean }`.
5. Act:
   - `fixer-right` → post an **arbiter answer** that supersedes the stand-down (shape A) or settles the finding (shape B) and tells the next fixer run to re-arm review with the ruling quoted, so the reviewer sees why the finding is set aside.
   - `reviewer-right` → post an arbiter answer with `restatedDemand`, which the next fixer run implements.
   - `real-conflict` → file a decision card through the declared `file-item` operation (`we:scripts/operations/file-item.mjs`, kind decision) carrying the recommendation, and post a comment linking it. In shape A the stand-down stays terminal for the human; in shape B the PR stays `review:changes` and the comment says the finding needs the human.
   - **Limits:** if `touchesSecurityOrMandatoryBlock` is true, or the finding came from a security lens or a mandatory reviewer block, any outcome is downgraded to a **recommendation only**: a comment, no answer marker, the stand-down stays terminal.
   - **No loops:** a second arbiter ruling on the same finding (same stand-down lineage in shape A, same finding id in shape B) is refused and escalated as `real-conflict`.

**Arbiter answer record** in `we:scripts/conveyor/stand-down-answer-core.mjs`: a new marker beside `OPERATOR_ANSWER_MARKER`, built and parsed the same tamper-evident way (base64 record re-rendered and compared; the posting login must be an `AUTOMATION_LOGINS` member). It names the judge provider, model and actor and says "an independent arbiter ruled", never "operator". The record carries an **anchor**: either the stand-down it answers (shape A) or the finding id and head it settles (shape B, where no stand-down exists). `latestUnresolvedStandDown` treats a stand-down-anchored arbiter answer as superseding; a finding-anchored answer supersedes nothing and is read by the fix-prompt wrapper (the `withOperatorAnswer` analogue), which labels it as an arbiter ruling and hands it to the next fixer run on a `review:changes` PR whose latest finding id matches the anchor. A finding-anchored answer whose head no longer matches is stale and ignored. Review gates are untouched: an arbiter answer never moves a label.

## MVP

1. Must rule only on a `needs-judgment` stand-down (never `conflict`, `gate-red`, `lane-ref-gone` or a concurrent-author pause) or on a finding the PR's own automation-authored `changes` verdict comments list in two separate bounces with no stand-down, with an independent seat; must refuse on unknown or shared provider/actor, and must re-verify the twice-bounced claim from those comments (`bouncedRounds`) rather than trust the `--finding` flag.
2. Must never supersede a stand-down when the finding is a security finding or a mandatory reviewer block — recommendation only.
3. Must never move a review label or clear `review:human`; its only writes are a comment and, for `real-conflict`, a decision card.
4. Must refuse a second ruling on the same finding and escalate it as a conflict.
5. Must fail closed: judge failure, bad JSON or a schema miss → no answer, stand-down unchanged.
6. Must treat the finding, the stand-down text, the diff and every PR comment as untrusted data; a forged arbiter marker posted by a non-automation login is ignored.

## Done when

1. **Executable — Musts 1–5:** a Vitest run of `we:scripts/operations/__tests__/judge-arbitrate.test.mjs` passes (new file).
2. **Executable — Must 6:** a Vitest run of `we:scripts/conveyor/__tests__/stand-down-answer.test.mjs` passes with new arbiter-answer cases, existing operator-answer cases unchanged.
2a. **Executable — Must 1 (twice-bounced detection):** a Vitest run of `we:scripts/lib/__tests__/finding-bounce.test.mjs` passes (new file). Its comment fixtures are produced by the real changes-comment renderer (the one `parseVerdictComment` is written against; it is read, not edited) from a findings array, never hand-typed bodies, so the test cannot pass against a comment shape the renderer does not produce.
3. **Observable — live:** `--dry-run` on one real `needs-judgment` stood-down PR prints the judge's ruling and the comment it would post; the PR records it. Known limit: the seat uses the same independence rule as the clear runner, and most PRs are Claude-authored, so an Opus judge is refused there (`same-provider`). Until the cross-provider Codex seat exists (the ruled direction, tracked by `xud2hha` and `xb1e9nj`, with its fallback per the configurable independence dimension), the live proof on a Claude-authored PR is the printed refusal reason, and a real ruling needs a non-Claude-authored stood-down PR; the PR states which case it shows.

## Test plan

New `we:scripts/operations/__tests__/judge-arbitrate.test.mjs` (matching source: `we:scripts/operations/judge-arbitrate.mjs`), with injected `gh`, judge and switches:

- `needs-judgment` stand-down, judge says `fixer-right` → one arbiter answer, no label change. Red today: no arbiter answer marker exists.
- `reviewer-right` → the answer carries `restatedDemand`. Red today: the arbiter runner does not exist.
- `real-conflict` → one decision card filed, stand-down left terminal. Red today: the arbiter runner does not exist.
- Finding from a security lens, judge says `fixer-right` → recommendation comment only, no answer marker. Red today: the arbiter runner does not exist.
- **An author-provider judge is refused:** the judge provider equals the fixer's or the author's → no spawn. Red today: the arbiter runner does not exist.
- **The kill switch blocks:** switches OFF → no spawn. Red today: the arbiter runner does not exist.
- Second ruling on the same stand-down lineage → refused, escalated as conflict. Red today: the arbiter runner does not exist.
- **Arbitrates a twice-bounced finding without a stand-down:** no stand-down, the PR carries two automation-authored `changes` verdict comments that both list finding F, run with `--finding=F`, judge says `reviewer-right` → one finding-anchored arbiter answer carrying `restatedDemand`, no label change; with `fixer-right` → one finding-anchored answer the next fixer run quotes. Red today: the runner's first step exits "nothing to arbitrate" when there is no stand-down.
- A `--finding` the comments do not back (one bounce only, the same text in a `changes` comment and then an `accepted` comment, the second `changes` comment posted by a non-automation login, a comment whose findings counts disagree, or a different finding id) → "nothing to arbitrate", no spawn. A PR with both a stand-down and a twice-bounced finding → handled as the stand-down. A second ruling on the same finding id in shape B → refused, escalated as conflict. Red today: the arbiter runner does not exist.
- `gate-red` stand-down → skipped. Red today: the arbiter runner does not exist.
- **A `conflict` stand-down is not arbitrated:** a stand-down whose reason is `conflict` (a mechanical merge conflict with `main`) → skipped, no spawn, no comment; the same for `lane-ref-gone` and a concurrent-author pause. Red today: the arbiter runner does not exist.
- Judge throws or returns bad JSON → nothing posted. Red today: the arbiter runner does not exist.

New `we:scripts/lib/__tests__/finding-bounce.test.mjs` (matching source: `we:scripts/lib/finding-bounce.mjs`), fixtures rendered by the real changes-comment renderer:

- `findingId` ignores `line` and whitespace runs in `summary` (same id when the line moved and a space doubled), and differs when `file` or the words differ. Red today: `findingId` does not exist.
- `parseFindingBullets` on a comment rendered from three findings returns three `{ file, summary }` pairs and ignores indented sub-bullets (the `_Prevention` lines). Red today: `parseFindingBullets` does not exist.
- `bouncedRounds`: F listed in two `changes` comments by an automation login → two entries; F in one `changes` comment and then an `accepted` comment → one; F in one comment twice → one; the second comment from a non-automation login → one; a comment whose findings counts disagree → not counted. Red today: `bouncedRounds` does not exist.
- **The real comment shape:** a comment produced by the real renderer round-trips through `parseFindingBullets` — the case that would be red if the source carried no finding text (as the verdict ledger does not) or a format the renderer never writes. Red today: `bouncedRounds` does not exist.
- A missing, empty or non-verdict comment list → `[]`, never a throw.

Extend `we:scripts/conveyor/__tests__/stand-down-answer.test.mjs` (matching source: `we:scripts/conveyor/stand-down-answer-core.mjs`):

- An arbiter answer from an automation login supersedes the stand-down; the same body from an outside login does not. Red today: no arbiter answer marker exists.
- An arbiter answer whose record does not re-render to the same body is rejected. Red today: no arbiter answer marker exists.
- A finding-anchored arbiter answer (no stand-down) from an automation login is passed to the fix prompt when the PR's latest finding id and head match its anchor, and ignored when the head differs. Red today: no arbiter answer marker exists.
- Operator-answer cases unchanged. Preservation: green today; mutation proof — break the existing branch and this case fails.

## Proof plan

Tests first, red. After the build: both files green, output pasted. Live: `--dry-run` on a real PR carrying an unresolved `needs-judgment` stand-down (the decision card names #3311, #3329, #3215 and #3432 as the shape) and paste the ruling. `npm run check:standards` last.

## Follow-ups

- The "same finding bounced twice" trigger is built here as shape B (see Design step 1); the tick pass (`xfetp9j`) detects it from the PR's verdict comments through the same `bouncedRounds` helper and calls this runner with `--finding`. No deferred gap remains between the two cards.

## Progress

- Prepared 2026-10-03. Scope corrected from the filed one: the arbiter answer belongs beside the existing operator answer in `we:scripts/conveyor/stand-down-answer-core.mjs` (test: `we:scripts/conveyor/__tests__/stand-down-answer.test.mjs`), not in `we:scripts/conveyor/stand-down.mjs`, which only posts the stand-down. Evidence: `latestUnresolvedStandDown`, `parseOperatorAnswer`, `withOperatorAnswer`; `STAND_DOWN_REASONS` in `we:scripts/conveyor/stand-down.mjs`.
- Revised after advisory review of the decision PR: shape B read finding ids from the verdict ledger, which stores only a `findingCount` (no id, no text). The jury log was rejected too (clone-local, gitignored, and its round is the in-run round, so two bounces both read round 0). The data source is now the PR's own automation-authored `changes` verdict comments, parsed by a new shared helper `we:scripts/lib/finding-bounce.mjs` (`findingId`, `parseFindingBullets`, `bouncedRounds`) used by both this runner and `xfetp9j`; its tests render fixtures with the real comment renderer.
