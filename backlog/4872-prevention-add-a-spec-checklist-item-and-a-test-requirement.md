---
bornAs: xodzat3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/operator-command.mjs", "we:scripts/lib/__tests__/operator-command.test.mjs", "we:scripts/conveyor/ci-auth-diagnosis.mjs", "we:scripts/conveyor/__tests__/ci-auth-diagnosis.test.mjs", "we:docs/agent/backlog-workflow.md"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-19"
preparedAgainstSha: "e3533f04e8173de2ed6fc57329ae0ac36a14888a"
tags: []
---

# Prevention — Add a spec checklist item and a test requirement that any value interpolated into an operator-facing co… (from chalbert/web-everything#3276 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4545-bad-credentials-smell-names-the-failing-secret-and-repo.md` (historical review origin; its delivery is recorded under Progress) — Add a spec checklist item and a test requirement that any value interpolated into an operator-facing command is allowlist-validated. A shared `renderOperatorCommand` helper that refuses non-matching tokens would enforce it deterministically.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3276@75925e5b83a1cb18f21174b5211c800f09985c08

## Progress

- **Old premise/scope:** the previous preparation proposed a shared command renderer, two exported regular expressions, one diagnosis caller migration and a checklist rule. It described existing inline validation as sufficient, promised refusal of option-shaped tokens, cited an obsolete line 35 in the originating card, and used the historical repository fixture name. The original filing scoped only the originating card; that earlier correction to implementation files remains valid.
- **Current evidence (checkout e3533f04e8173de2ed6fc57329ae0ac36a14888a):** the proposed helper and its test file do not exist. The renderer still interpolates directly at we:scripts/conveyor/ci-auth-diagnosis.mjs:214, guarded by module-private validators at we:scripts/conveyor/ci-auth-diagnosis.mjs:5 and we:scripts/conveyor/ci-auth-diagnosis.mjs:7. Searches of the library and conveyor source found no shared renderOperatorCommand implementation. The checklist insertion point is now we:docs/agent/backlog-workflow.md:45. The real fixture uses web-everything/web-everything at we:scripts/conveyor/__tests__/ci-auth-diagnosis.test.mjs:4; its incident-shaped assertion is at we:scripts/conveyor/__tests__/ci-auth-diagnosis.test.mjs:26.
- **Corrected premise/scope:** this is still undelivered prevention, with a small command-boundary tightening. A direct Node probe of the existing repository regex accepted `--flag/repo`; it rejected trailing newlines for both repository and secret. Thus the old claim that the proposed regex rejects option-shaped repository arguments was false. Require a leading-hyphen rejection for command repository values, retaining the existing non-command validators to avoid unrelated collection/metadata changes. No regex export is needed. Existing valid commands remain unchanged. The five-file scope remains sufficient.
- **Caller evidence:** we:scripts/conveyor/ci-heal-escalation-mark.mjs:56 imports the renderer and we:scripts/conveyor/ci-heal-escalation-mark.mjs:130 appends its output. No signature/default or persisted-state migration is required. Preserve this caller using its existing tests at we:scripts/conveyor/__tests__/ci-heal-escalation-mark.test.mjs. Its source is read-only in this item.
- **Sizing:** retain story size 3: approximately 45 changed lines in we:scripts/lib/operator-command.mjs, 80 in we:scripts/lib/__tests__/operator-command.test.mjs, 12 in we:scripts/conveyor/ci-auth-diagnosis.mjs, 45 in we:scripts/conveyor/__tests__/ci-auth-diagnosis.test.mjs and 5 in we:docs/agent/backlog-workflow.md (about 187 lines across five files). This is a story, so no estimatedLoc field is added. Preparation checks and stamps belong to the runner; no build tests have been claimed as run.

## Design

1. Add we:scripts/lib/operator-command.mjs exporting `renderOperatorCommand(template, values)`. The caller supplies a trusted, nonempty array of literal argv tokens and whole-token slots, for example `['gh', 'secret', 'set', '{secret}', '--repo', '{repo}']`. Templates are developer-authored source, never workflow/log/config input. This is a display-only formatter and never executes a command.
2. Support exactly two slot names: `secret` accepts ASCII letters/underscore followed by ASCII letters/digits/underscore; `repo` accepts two nonempty ASCII letters/digits/underscore/dot/hyphen components separated by one slash, with the complete token forbidden to begin with a hyphen. Require primitive string values and a full-string match; reject whitespace, control characters and shell syntax. Do not coerce objects, trim values or quote rejected values. Valid output is `{ ok: true, command }`, joining tokens with single spaces.
3. Fail closed on missing own-property values, unknown slots (including inherited object names), invalid values, malformed/partial slots, non-array/empty templates, non-string template entries and null/non-object value maps. Return `{ ok: false, refused }` without a command: refused is `secret` or `repo` for a known invalid/missing slot, otherwise the fixed string `template` or `values`. Never include attacker-supplied slot names or values in diagnostics. Ordinary malformed inputs must not throw; arbitrary throwing proxies/getters are outside this source-template/data-map API. Extra unused values are not interpolated or returned.
4. Import the helper into we:scripts/conveyor/ci-auth-diagnosis.mjs. Preserve the resolved-status and exact repositorySecret=true ownership conditions at we:scripts/conveyor/ci-auth-diagnosis.mjs:213, then obtain the rotation command through the helper. Emit the existing command heading/backticks only on success. On helper refusal emit the fixed explanation `Operator rotation command withheld: invalid command token; verify repository and secret metadata.` The operator must verify metadata before constructing a replacement command. Keep existing collection/non-command validators and all other evidence rendering unchanged; the helper refusal itself must not echo input.
5. Beside we:docs/agent/backlog-workflow.md:45 add a checklist item requiring allowlist validation via the shared renderer for dynamic values in operator-facing copy/paste commands, plus a named hostile-value refusal test in the card's test plan. Explicitly include values originating in documentation, configuration, workflow data and logs. Unsupported token kinds require an explicit validated extension before use; no raw-interpolation fallback. This is an authoring checklist, not a repository-wide lint or retrospective migration.

## MVP

- Must provide the display-only shared helper and fail-closed contract in Design, with only secret/repo kinds.
- Must route the existing rotation command through it, preserving clean output and ownership gating. The only intentional output change is withholding invalid command tokens with the fixed verification message, including option-shaped repository tokens previously accepted inline.
- Must validate dynamic data regardless of source (documentation, configuration, workflow or logs); trusted literal template tokens are the only bypass and may not be populated from external data.
- Must add the checklist and executable regressions below. No new settings, execution behavior, persisted-state format or default collector behavior.

## Acceptance

- [A1] Executable — test `renders the supported rotation template without executing` in we:scripts/lib/__tests__/operator-command.test.mjs exercises the exact valid command and stable result shape. It fails before implementation because the helper module is absent and passes afterward.
- [A2] Executable — parameterized test `refuses invalid tokens and malformed inputs without echo or throw` in we:scripts/lib/__tests__/operator-command.test.mjs covers every refusal in Design, both slot kinds, non-string values and extra unused values. It fails on the missing helper before implementation and passes afterward; removing validation must turn hostile-token cases red.
- [A3] Executable — test `withholds an option-shaped repository and requests metadata verification` in we:scripts/conveyor/__tests__/ci-auth-diagnosis.test.mjs calls the actual renderer with resolved status, repositorySecret=true, secret FUI_READ_TOKEN and repo --flag/repo. Before the build it renders a rotation command; afterward it emits no command and the fixed fallback. Test `honors helper refusal and preserves ownership gates` mocks the helper to refuse otherwise-valid input, asserts no command, and verifies unresolved/absent/false ownership never produces one. This fails before migration because the helper is not consulted. Pair these with the existing incident-shaped regression and escalation caller tests to preserve clean output/defaults.
- [A4] Executable — test `authoring checklist requires validation and hostile-input tests for every data source` in we:scripts/lib/__tests__/operator-command.test.mjs reads we:docs/agent/backlog-workflow.md relative to the test module and asserts the dedicated checklist paragraph names renderOperatorCommand, hostile-value refusal tests, documentation, configuration, workflow data and logs, and disallows raw fallback. That paragraph is absent before the build and present afterward.

## Test plan

- For A1/A2, add we:scripts/lib/__tests__/operator-command.test.mjs. Exercise semicolon, command substitution, backtick, newline, tab, space, empty string and option-shaped values in both slots; also null, undefined, numbers, arrays and plain objects. Pin repo `--flag/repo` separately from the trivially invalid slashless `--flag`. Include unknown/inherited slot names, missing/inherited values, malformed slots, invalid template/map shapes and unused hostile values. Assert refusal results exactly, rather than asserting absence of an empty string. Verify valid dotted/hyphenated repository names remain accepted when the token does not begin with a hyphen.
- For A3, extend we:scripts/conveyor/__tests__/ci-auth-diagnosis.test.mjs with the new red repository case, direct hostile-secret/repo preservation cases and a helper-refusal seam using an isolated module mock restored after the test. Prove the actual helper is called for the clean eligible case; preserve missing/default diagnosis and ownership gating. Removing helper validation must fail A2 even if the diagnosis layer has additional guards.
- For A4, keep the small documentation-contract assertion in the new helper test file; avoid exact full-paragraph snapshots. Existing we:scripts/conveyor/__tests__/ci-heal-escalation-mark.test.mjs is a read-only regression target for the downstream comment caller.
- Execute only these three test files through the host heavy-admission queue. Command paths below carry repository prefixes for attribution; remove the leading `we:` from each path when executing from the WE root: `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/operator-command.test.mjs we:scripts/conveyor/__tests__/ci-auth-diagnosis.test.mjs we:scripts/conveyor/__tests__/ci-heal-escalation-mark.test.mjs`. If busy, use the queue's own wait option once, then stop/report rather than polling.

## Proof plan

1. During delivery, add the A1–A4 tests before implementing. Capture queued RED output: missing helper, existing option-shaped command, missing helper invocation and missing checklist. Do not mislabel preservation cases as new red regressions.
2. Capture the clean renderer output using the existing incident-shaped fixture with web-everything/web-everything before and after migration; require byte-identical output. Store scratch captures under the task's TMPDIR. Capture the invalid repository before/after separately: old command versus withheld command with metadata-verification explanation. Never execute a displayed rotation command or contact GitHub for this proof.
3. Run the same queued targeted tests after implementation and retain GREEN output. Temporarily remove token validation and force the caller to ignore helper refusal in separate local mutations; A2 and A3 respectively must fail. Restore the implementation before final checks.
4. Run `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards` (strip the repository prefix as above) during delivery. Record any queue refusal or unrelated failure honestly. The preparation runner owns this card's checks and stamping; the worker changes only the card.

## Follow-ups

- A lint for ad-hoc operator-command interpolation needs its own scope and false-positive analysis.
- Consider migration of label commands at we:scripts/pr-land.mjs:969 and we:scripts/pr-land.mjs:970, and review instructions at we:scripts/workflows/review-parked-prs.mjs:607 and we:scripts/workflows/review-parked-prs.mjs:843. These involve label and PR-number kinds beyond this MVP; do not claim that those sites already conform or need a SHA kind without inspecting the eventual touch set.
- Add quoting/free-form value support only against a concrete consumer need and an independently specified safety contract. This item refuses unsupported dynamic token kinds.
