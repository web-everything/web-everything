---
kind: decision
status: open
dateOpened: "2026-10-02"
tags: []
---

# Decision: an arbiter model settles fixer and reviewer disagreements before they reach the operator

Operator, 2026-10-02 ("sounds good"). Today a fixer that finds a review demand wrong, contradictory or impossible stands down and the PR stops until the operator answers (four cases this week: #3311, #3329, #3215, #3432), though most needed a judgment call, not the operator. Proposal to prepare: an arbiter step between fixer and operator. Trigger: a fixer stand-down or objection on a finding, or the same finding bounced twice. Arbiter: an independent strong model (proposed Opus; never the PR reviewer or fixer), read-only tools, reads the finding, the objection, the code and the ratified rules. It decides one of: (1) fixer right: record a finding ruling (not-real, or card) so the PR proceeds; (2) reviewer right: restate the demand precisely for the fixer; (3) real conflict (against a card, a ratified rule, or a scope change): file a decision card and escalate to the operator with a recommendation. Limits to rule on: it never approves a PR and never clears review:human; it never overrides a security finding or a mandatory reviewer block alone (recommend only); every ruling is a PR comment with its reasoning and a decision-log record, and is reversible. Open questions for the prepare: the override boundary (proposed: advisory and correctness findings yes, security and blocks recommend only) and the model (proposed Opus, rare and narrow).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
