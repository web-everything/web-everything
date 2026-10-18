---
bornAs: x9qibqz
kind: story
size: 5
parent: "3007"
status: open
scope: ["we:scripts/lib/pr-merge-gate.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/settings/ledger.json", "we:scripts/lib/__tests__/ledger-authority.test.mjs"]
scopeRationale: "Creates we:scripts/settings/ledger.json for the per-fact ledger authority cascade settings."
dateOpened: "2026-10-17"
tags: []
---

# Gradual ledger authority per fact type and PR class

TOP PRIORITY (operator 2026-10-17). Settings ledger.authority.<fact> for fact in {redTeamResult, carry, ruling, approval}, each labels|both|ledger, plus ledger.authority.prClass (cards-only|low-risk|all). Every value is a cascade setting with its source logged; each fact type is promoted on its own agreement measure. Promotion order: redTeamResult, then carry, then ruling, then approval; cards-only PRs first. Depends on the drain honouring mergeGate.reviewAuthority. The A1 test plan maps each setting value and guarantee to a named case and assertion.

Precedence: mergeGate.reviewAuthority=labels (including its absent/invalid fallback) overrides any per-fact promotion. Global both requires labels AND ledger to clear regardless of per-fact settings; global ledger permits per-fact authority only within the selected PR class and readiness gates. Missing settings file, missing fact key, absent prClass, invalid fact value or unknown prClass grants no per-fact ledger authority for the affected selection: resolve to labels, while retaining both vetoes if global authority is both. Tests: 'global labels overrides per-fact ledger', 'global both retains label veto', 'global both retains ledger veto', 'global ledger respects per-fact and class limits', 'missing authority settings default to labels', 'invalid fact value fails closed to labels', 'invalid prClass falls back to labels'.

PR classes: cards-only requires a nonempty, complete changed-path list whose paths (including both ends of renames) are all backlog cards; low-risk includes cards-only plus PRs positively classified by the existing risk policy (`we:scripts/lib/pre-pr-review.mjs#classifyPrRisk`); all includes all classifiable PRs. Mixed cards/code never counts as cards-only; mixed or unclassifiable PRs fall back to labels when eligibility cannot be established. Tests: 'prClass cards-only excludes code and mixed PRs', 'prClass low-risk requires positive classification', 'prClass all admits classifiable PRs', 'mixed or unclassifiable PRs fall back to labels'.

Must: missing, errored, empty or partial authoritative ledger evidence holds and never contributes agreement toward promotion; configuration fallback cannot turn a failed ledger read into permission. Test: 'partial read and missing ledger evidence hold without agreement'.

Must: docs, config, data, cards, code and mixed PRs keep all independent merge safety checks; PR-class eligibility never exempts a hold. Test: 'per-fact authority preserves safety gates for every input kind'.

## Acceptance

- [A1] **Executable** — npx vitest run we:scripts/lib/__tests__/ledger-authority.test.mjs fails before and passes after. Every named case and observable assertion below belongs to A1. These are planned implementation tests, not tests delivered by this backlog-only PR.

### Test plan (A1)

Every row is owned by `we:scripts/lib/__tests__/ledger-authority.test.mjs`; precedence and safety cases also exercise the merge-gate caller using the resolved settings.

| Named case | Observable assertion |
| --- | --- |
| 'each ledger.authority.<fact> resolves via cascade with source logged' | Parameterize redTeamResult, carry, ruling and approval with distinct cascade overrides; each resolves independently and logs its actual source. Missing/invalid values log the labels fallback and default source. |
| 'fact labels preserves label authority' | For each of the four facts under global ledger, labels mode follows labels despite contrary ledger evidence. |
| 'fact both requires labels and ledger clear' | For each fact under global ledger, either-side hold refuses; only two complete clear inputs pass. |
| 'fact ledger follows complete ledger evidence' | For each fact under global ledger, ledger mode follows ledger clear/hold despite contrary review labels. |
| 'missing authority settings default to labels' | Under global ledger, missing `we:scripts/settings/ledger.json`, absent authority object, each missing fact key and absent prClass separately retain label authority and a label hold. |
| 'invalid fact value fails closed to labels' | Under global ledger, each fact's unknown strings and malformed types resolve to labels and preserve a label hold. |
| 'prClass resolves via cascade with source logged' | Distinct default/platform/tool overrides resolve the class selector and log its actual source, including default fallback. |
| 'prClass cards-only excludes code and mixed PRs' | Nonempty all-card changes qualify; any code path, including a rename source outside backlog, prevents cards-only eligibility and retains label authority. |
| 'prClass low-risk requires positive classification' | Cards-only and positively classified low-risk PRs qualify; ordinary/high-risk code does not. |
| 'prClass all admits classifiable PRs' | Cards, low-risk and ordinary code PRs qualify, subject to fact readiness and global authority. |
| 'invalid prClass falls back to labels' | Unknown strings and malformed selector types retain label authority rather than broadening to all. |
| 'mixed or unclassifiable PRs fall back to labels' | Mixed cards/code is excluded in cards-only mode; empty/missing/partial paths or indeterminate risk retain labels in every selector mode. |
| 'global labels overrides per-fact ledger' | Cross all four facts and all selectors with per-fact both/ledger: global labels, absent global key and invalid global value follow labels in both disagreement directions; a ledger hold cannot block clear labels, and a clear ledger cannot clear a label hold. |
| 'global both retains label veto' | Per-fact ledger and a clear ledger cannot override a label hold when global authority is both. |
| 'global both retains ledger veto' | Cross every per-fact value, absent/invalid fact or class config and out-of-class PRs with global both: a ledger hold or unavailable ledger evidence refuses even when labels clear. |
| 'global ledger respects per-fact and class limits' | Global ledger cannot promote a fact configured labels or a PR outside the selected class. |
| 'promotion gated per fact agreement measure' | Below-threshold, missing, unknown or stale evidence for one fact blocks its promotion despite other facts meeting the seven-day bar. |
| 'promotion order redTeamResult, carry, ruling, approval enforced' | Skipping an earlier fact or widening beyond cards-only before the required readiness bar is rejected; eligible ordered progression succeeds. |
| 'partial read and missing ledger evidence hold without agreement' | In both/ledger selections, missing file/row, empty-on-error, thrown read, page/buffer-limit hits and partial last rows yield unknown, hold and no agreement/promotion credit. |
| 'missing authoritative label evidence holds' | Missing, errored or partial label input refuses in labels/both selections. |
| 'per-fact authority preserves safety gates for every input kind' | Cross docs/config/data/cards/code/mixed PRs with existing independent CI/conflict/CodeQL/red-main and other safety holds: none is bypassed. |
| 'other PR or head evidence cannot grant authority' | Other-PR and stale-head rows, both clear and hold, leave current-head decisions and readiness unchanged; they cannot clear a hold, grant readiness or contaminate complete clear evidence. |
| 'per-fact evaluation uses existing append-only ledger files' | Repeated evaluation preserves existing bytes, creates no shared writer/file and confines any writes to existing ledger appends. |
| 'scoring change resets clock and appears in digest' | Scoring-version change invalidates the old seven-day window and emits a digest notice; unchanged scoring preserves the window. |
| 'authority evaluation does not promote settings' | Evaluation leaves fact/class settings bytes and promotion state unchanged; actual promotion requires a separate settings change. |

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not promote any fact type itself; each promotion is a separate settings change. A1: 'authority evaluation does not promote settings'.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads internal ledger rows and settings only.
2. **Truncated reads** — unknown, ledger hold, never agree or promotion credit. A1: 'partial read and missing ledger evidence hold without agreement', 'mixed or unclassifiable PRs fall back to labels'.
3. **Shared state files** — existing-file appends only, no new shared writer. A1: 'per-fact evaluation uses existing append-only ledger files'.
4. **Fail closed** — missing/invalid config retains labels; unavailable authoritative evidence holds. A1: 'missing authority settings default to labels', 'invalid fact value fails closed to labels', 'invalid prClass falls back to labels', 'partial read and missing ledger evidence hold without agreement', 'missing authoritative label evidence holds'.
5. **Identity scoping** — rows keyed by PR and head. A1: 'other PR or head evidence cannot grant authority'.
6. **State over time** — scoring changes reset the seven-day clock and appear in the digest. A1: 'scoring change resets clock and appears in digest'.
7. **Who wrote it** — fact and prClass values carry their cascade source in the log. A1: 'each ledger.authority.<fact> resolves via cascade with source logged', 'prClass resolves via cascade with source logged'.
