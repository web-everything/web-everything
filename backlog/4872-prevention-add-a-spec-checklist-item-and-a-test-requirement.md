---
bornAs: xodzat3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/operator-command.mjs", "we:scripts/lib/__tests__/operator-command.test.mjs", "we:scripts/conveyor/ci-auth-diagnosis.mjs", "we:scripts/conveyor/__tests__/ci-auth-diagnosis.test.mjs", "we:docs/agent/backlog-workflow.md"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-19"
preparedAgainstSha: "94fede5cc80cb674227d54ba20d74d09bbbfa8a6"
tags: []
---

# Prevention — Add a spec checklist item and a test requirement that any value interpolated into an operator-facing co… (from chalbert/web-everything#3276 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4545-bad-credentials-smell-names-the-failing-secret-and-repo.md` (historical review citation; see its Design item 4) — Add a spec checklist item and a test requirement that any value interpolated into an operator-facing command is allowlist-validated. A shared `renderOperatorCommand` helper that refuses non-matching tokens would enforce it deterministically.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3276@75925e5b83a1cb18f21174b5211c800f09985c08

## Progress

- **Prior preparation:** scope already named the shared helper, its new test, the diagnosis module and existing test, and the workflow checklist. The earlier filing scoped only the #4545 citation. The prior preparation claimed the inline validators were correct, proposed copying their regexes, and treated all renderer checks as preservation-only. Its historical line-35 citation and follow-up line for the landing command were stale.
- **Current evidence (HEAD 94fede5cc80cb674227d54ba20d74d09bbbfa8a6):** searches of we:scripts/ and we:docs/agent/ find no `renderOperatorCommand` implementation or checklist rule. The rendering site remains we:scripts/conveyor/ci-auth-diagnosis.mjs:213-214; its module-private validators at lines 5 and 7 use JavaScript `$`, which permits a match before a final newline, and `.test` coerces non-string values. The repository pattern also permits an option-shaped leading hyphen. These are reasons to require full-string, string-only command validation rather than copy the regexes unchanged. This is source analysis; delivery must capture the executable regressions below.
- **Corrected premise/scope:** retain the five-file touch set and goal, but make the helper the command-emission boundary and close those cases there. Leave the existing non-command validators local: exporting shared mutable regexes is unnecessary for this MVP and would widen changes into collection/display semantics. The real caller is we:scripts/conveyor/ci-heal-escalation-mark.mjs:130; it appends the renderer output to the escalation comment and needs regression coverage, not a source change. Its existing regression suite is we:scripts/conveyor/__tests__/ci-heal-escalation-mark.test.mjs. The current incident fixture uses `web-everything/web-everything` at we:scripts/conveyor/__tests__/ci-auth-diagnosis.test.mjs:4; `chalbert/web-everything` remains a valid historical slug, not the current fixture default.
- **Size:** retain story size 3. Expected touch set: new we:scripts/lib/operator-command.mjs (~55 lines), new we:scripts/lib/__tests__/operator-command.test.mjs (~100), we:scripts/conveyor/ci-auth-diagnosis.mjs:213-214 (~12), we:scripts/conveyor/__tests__/ci-auth-diagnosis.test.mjs:26 (~55), and we:docs/agent/backlog-workflow.md:45 (~5): approximately 227 changed lines. No `estimatedLoc` for this story. No dependency change identified. Preparation stamps are left to the runner.

## Design

1. Add we:scripts/lib/operator-command.mjs exporting `renderOperatorCommand(template, values)`. This is a pure display formatter, never a shell executor. The caller supplies a fixed, source-owned array such as `['gh', 'secret', 'set', '{secret}', '--repo', '{repo}']`; external docs/config/data must supply only values, never the template. Literal tokens must be nonempty strings without whitespace, braces or shell metacharacters (allow only ASCII letters, digits, underscore, dot, slash and hyphen). Slots occupy a whole token and are exactly `{secret}` or `{repo}`. Refuse empty/non-array templates, non-string entries, malformed/embedded slots and unknown slots. Do not interpolate arbitrary template text.
2. Accept only a non-null, non-array values object with own string properties for the requested slots; refuse missing properties, inherited properties and extra keys. Secret grammar is ASCII letter/underscore followed by ASCII letters/digits/underscores. Repository grammar is two nonempty components separated by one slash, each using ASCII letters/digits/underscore/dot/hyphen, with the whole token forbidden to start with `-`. Enforce a full-string match, including rejection of terminal CR/LF; do not trim or coerce. This retains existing ordinary slugs without inventing a full GitHub naming policy. No exported `TOKEN_KINDS` is needed.
3. Success returns `{ ok: true, command }`, joining tokens with one space. Refusal returns `{ ok: false, refused }`, with only a fixed reason (`template`, `values`, `secret`, or `repo`) and no command or input echo. Unknown slots use `template`. Invalid ordinary JS inputs return refusal rather than throwing; hostile proxies/getters are outside the plain-data contract. No quoting fallback or permissive default is provided.
4. In we:scripts/conveyor/ci-auth-diagnosis.mjs:213, retain the `status === 'resolved'` and `repositorySecret === true` gates, then call the helper and emit the existing rotation line only on success. Keep existing non-command checks and all other diagnostic text intact. Refusal leaves the existing evidence available to the operator without offering a rotation command; no automatic action is added. The default empty diagnosis still emits its heading without a command. The consumer at we:scripts/conveyor/ci-heal-escalation-mark.mjs:130 continues to use the renderer unchanged.
5. Add a checklist item beside the automatic-actor rule in we:docs/agent/backlog-workflow.md:45: every card introducing values into operator-facing commands must name the allowlisted token kinds, use the shared helper for supported kinds, and require hostile-input tests covering shell metacharacters, whitespace/newlines, option-shaped tokens, missing/unknown and non-string values. Unsupported kinds require an explicit validator and test extension before use, never raw interpolation. Inputs from docs, config and data get the same validation. This is an authoring checklist, not a claim that every legacy renderer is migrated or statically enforced.

## MVP

- Deliver the two-kind helper, the one production renderer migration, the workflow checklist, and matching tests in the listed scope.
- Fail closed on malformed templates/values and unsafe command tokens. Preserve ordinary resolved output, evidence-only fallbacks, default invocation, and unresolved/non-repository ownership gates.
- No collection changes, credential writes, template loading from external data, global lint, or bulk migration. Non-command metadata formatting is unchanged.

## Test plan

Use these named tests in new we:scripts/lib/__tests__/operator-command.test.mjs:

- `renders fixed commands with allowlisted string tokens`: exact ordinary command output, both current and historical repository slugs, accepted underscore/dot/hyphen within tokens, and repeated valid slots.
- `refuses unsafe values without coercion or disclosure`: table-driven cases for both slots covering semicolon, command substitution, backtick, spaces/tabs, embedded and terminal LF/CRLF, empty string, leading option token, null/undefined, number, array and object. Assert the exact fixed refusal shape, no command property, and no throw for ordinary input; do not use a vacuous assertion that an empty value is absent from a string.
- `refuses malformed templates and incomplete values`: null/empty/non-array template, non-string token, literal shell syntax, embedded/malformed/unknown slot, null/array values, missing/inherited slot and extra keys. Assert fixed reasons without echoing unknown keys or template text.
- `workflow checklist requires command validation and hostile-input tests`: read we:docs/agent/backlog-workflow.md and assert the dedicated checklist paragraph contains the helper requirement, supported-token validation and hostile-input test requirement. This is an executable check of the requested checklist artifact, not a lint over every renderer.

Extend we:scripts/conveyor/__tests__/ci-auth-diagnosis.test.mjs with `rotation renderer refuses unsafe command tokens`: call the real renderer with a resolved repository-owned diagnosis and terminal-newline secret/repo, a valid-looking one-element array, and an option-shaped repo such as `--owner/repo`. Those cases expose the current inline-validation gap. Include ordinary hostile strings as preservation cases. Add `rotation renderer preserves valid output and evidence-only defaults`: exact clean output plus empty diagnosis, unresolved status, absent/false ownership, and valid evidence retained when command validation fails. Retain the current incident regression and collection tests. Run the existing caller suite we:scripts/conveyor/__tests__/ci-heal-escalation-mark.test.mjs to verify comment composition; do not claim deleting helper validation necessarily breaks tests still guarded by older inline checks.

## Acceptance

Each executable criterion below is a build requirement, not a claim that preparation ran future tests. The queued focused command in Proof plan runs all named tests.

- [A1] **Executable** — `renders fixed commands with allowlisted string tokens` in we:scripts/lib/__tests__/operator-command.test.mjs fails before (missing helper) and passes after, proving the success contract and unchanged ordinary command spelling.
- [A2] **Executable** — `refuses unsafe values without coercion or disclosure` and `refuses malformed templates and incomplete values` in we:scripts/lib/__tests__/operator-command.test.mjs fail before (missing helper) and pass after, proving the fail-closed value/template contract, fixed refusal result and no permissive default.
- [A3] **Executable** — `rotation renderer refuses unsafe command tokens` in we:scripts/conveyor/__tests__/ci-auth-diagnosis.test.mjs fails before on terminal newline, array coercion and option-shaped repo, and passes after. Together with `rotation renderer preserves valid output and evidence-only defaults` and the existing we:scripts/conveyor/__tests__/ci-heal-escalation-mark.test.mjs suite, the queued command proves the migrated caller boundary while preserving empty/default, unresolved and ownership fallbacks. Preservation assertions are expected green before and after; the unsafe-token assertion supplies this criterion's red signal.
- [A4] **Executable** — `workflow checklist requires command validation and hostile-input tests` in we:scripts/lib/__tests__/operator-command.test.mjs fails before on the absent paragraph and passes after. Isolate this document test from the not-yet-created helper import (use a dynamic import inside helper tests) so its red result proves the missing checklist itself.

## Proof plan

1. During delivery, add the named tests first and capture their failures before adding the helper/refactor/checklist. Capture the renderer's newline, coercion and option-token failures separately from the missing-module failures. Use sanitized fixtures; no GitHub access, credential operations or shell execution of rendered commands is required.
2. From the WE root, use this exact queued focused command. Prefixes remain on authored path references; shell parameter expansion removes the repository marker only when passing local filesystem arguments. Keep proof logs in `$TMPDIR`.

```sh
queue=we:scripts/readiness/heavy-admission.mjs
helperTest=we:scripts/lib/__tests__/operator-command.test.mjs
diagnosisTest=we:scripts/conveyor/__tests__/ci-auth-diagnosis.test.mjs
callerTest=we:scripts/conveyor/__tests__/ci-heal-escalation-mark.test.mjs
node "${queue#we:}" run --wait-ms=60000 -- npx vitest run "${helperTest#we:}" "${diagnosisTest#we:}" "${callerTest#we:}"
```

3. After implementation, rerun that focused command once and retain the green output with the exact clean-render fixture assertion. If admission stays busy after its single bounded wait, stop and report; do not poll. Then run the queued standards command below. Preparation itself changes only this card; the runner owns preparation stamping and checks.

```sh
queue=we:scripts/readiness/heavy-admission.mjs
node "${queue#we:}" run --wait-ms=60000 -- npm run check:standards
```

## Follow-ups

- Consider a lint for ad-hoc operator-command interpolation, separately from this authoring checklist.
- Assess other renderers individually: we:scripts/pr-land.mjs:969 emits the label instruction; we:scripts/workflows/review-parked-prs.mjs:607 emits repository/label list instructions and we:scripts/workflows/review-parked-prs.mjs:843 emits clone/checkout instructions. Their labels, PR numbers and compound shell templates require separate contracts and tests; this card does not authorize those migrations or assume SHA support is needed.
- Add quoting or additional token kinds only when a concrete caller requires them and supplies matching refusal tests.
