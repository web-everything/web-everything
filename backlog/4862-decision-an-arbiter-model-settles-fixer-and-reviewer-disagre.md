---
bornAs: xne1udi
kind: decision
status: resolved
dateOpened: "2026-10-02"
dateResolved: "2026-10-03"
codifiedIn: "docs/agent/platform-decisions.md#independent-judge-clears-review-human-outside-protected-list"
tags: []
---

# Decision: an arbiter model settles fixer and reviewer disagreements before they reach the operator

Operator, 2026-10-02 ("sounds good"). Today a fixer that finds a review demand wrong, contradictory or impossible stands down and the PR stops until the operator answers (four cases this week: #3311, #3329, #3215, #3432), though most needed a judgment call, not the operator. Proposal to prepare: an arbiter step between fixer and operator. Trigger: a fixer stand-down or objection on a finding, or the same finding bounced twice. Arbiter: an independent strong model (proposed Opus; never the PR reviewer or fixer), read-only tools, reads the finding, the objection, the code and the ratified rules. It decides one of: (1) fixer right: record a finding ruling (not-real, or card) so the PR proceeds; (2) reviewer right: restate the demand precisely for the fixer; (3) real conflict (against a card, a ratified rule, or a scope change): file a decision card and escalate to the operator with a recommendation. Limits to rule on: it never approves a PR and never clears review:human; it never overrides a security finding or a mandatory reviewer block alone (recommend only); every ruling is a PR comment with its reasoning and a decision-log record, and is reversible. Open questions for the prepare: the override boundary (proposed: advisory and correctness findings yes, security and blocks recommend only) and the model (proposed Opus, rare and narrow).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

## Ruling

Operator, 2026-10-03 (settled in chat), verbatim:

- "I'd be happy to be more lenient on some human acceptance and replace and external judge for now"
- On the three options offered — A: judge clears by category; B: the judge replaces the human sign-off except on a protected list; C: the judge clears only after an N-hour wait — the operator chose **B now**: "Waiting is a nice option, but I would not use it just right now I think, my judgement will become more important once it's closer to a release but we are a while back"
- On the protected list, and on using the same judge for this decision (4862): "Ok"

Settled design:

1. An independent judge may clear the human sign-off (`review:human`) once the reviewers accept and only the human gate remains.
2. The judge is a strong model (Opus) from a different provider/actor than the PR's author. It is never the author or a reviewer of that PR.
3. The protected list always stays human: changes to merge/approval logic (the review gate, drain/merge authority, the review-set-label clear paths), credentials and secrets, and anything that weakens a security check.
4. Every judge clearance is logged with its reasoning in a durable record on the PR. The operator gets one daily digest of judge clearances.
5. A kill switch turns the judge off without a PR.
6. An "N-hour wait before the judge may clear" switch exists but defaults OFF, kept for later, near a release.
7. The same judge also serves this card: it is the arbiter that settles fixer/reviewer disagreements (the three outcomes and the limits proposed above stand). This answers the card's open questions: the arbiter model is that same independent judge, and its override boundary is the protected list plus "never overrides a security finding or a mandatory reviewer block alone".

What this changes from the proposal above: the proposal said the arbiter "never clears review:human". The ruling reverses that for PRs outside the protected list — the same judge may now clear it, under rules 1–6.

Codified in the statute layer at `we:docs/agent/platform-decisions.md#independent-judge-clears-review-human-outside-protected-list`. Build: epic `5060` and its stories `5062` (decision core), `5063` (switches), `5072` (judge seat runner), `5074` (ledger and digest), `5073` (arbiter), `5075` (conveyor pass).
