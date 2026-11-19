---
bornAs: xamy1gk
kind: story
size: 3
status: open
scope: ["we:scripts/lib/probation-launcher.mjs", "we:scripts/lib/__tests__/probation-launcher.test.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "fb6c76988b0daba1f16e4f895934716da9222e21"
tags: []
---

# Standalone prepare runs are discarded as card tampering without naming the key, and the allowed prepare keys are too narrow

The historical #3996/#4003 prepare failures exposed two problems: legitimate corrections were rejected, and rejection destroyed the work without identifying the offending fields. The authorization half is now implemented: `PREPARE_OWNED_FRONTMATTER_KEYS` permits scope, size, estimatedLoc and preparation stamps (we:scripts/lib/probation-launcher.mjs:219). Direct blockedBy edits remain forbidden under the ruling below. The remaining work is actionable before/after diagnostics and preservation of rejected prepare evidence. The current worker check still emits a generic refusal (we:scripts/operations/probation-build-run.mjs:543), and `abandon` resets the lane (we:scripts/operations/probation-build-run.mjs:354).

## Design

Add a structured frontmatter comparison beside the boolean guard in we:scripts/lib/probation-launcher.mjs. Return all disallowed top-level keys with before/after values, explicitly distinguishing absent keys from null values. Include additions and deletions and multiline values. Missing, malformed or ambiguous frontmatter must produce an explicit unreadable-evidence violation in prepare mode, never an empty successful comparison. Keep the existing boolean API and its claim-owned default compatible; prepare callers explicitly pass the existing prepare-owned keys. Do not broaden the allowlist or grant lifecycle ownership.

Use the structured result at both the post-worker and post-stamp prepare checks in we:scripts/operations/probation-build-run.mjs:543 and we:scripts/operations/probation-build-run.mjs:719. A path-envelope violation remains distinct from a field violation. Before cleanup on a prepare field rejection, capture the worker diff and raw before/after card evidence through an injected IO operation. Write a uniquely named, private evidence directory outside the lane using the existing salvage-root resolver in we:scripts/lib/lane-salvage.mjs:61; include item, base SHA, phase and violations in a manifest. Capture the diff with external diff/textconv disabled and argv-based execution. Treat evidence as inert data, never as a patch to apply automatically.

Only discard after evidence persistence succeeds. Return and log the retained location and structured violations, and carry retention metadata into the scorecard/settled result. Keep `resultDiscarded` truthful about the lane reset, with a separate evidence-retained indicator. If capture or persistence fails, escalate with the failure reason and lane location, skip destructive cleanup, and explicitly require operator recovery; never stamp further, commit, push or open a PR. Sanitize/redact displayed values using existing output protections; preserve raw evidence privately rather than printing it. Retention applies to prepare field refusals, not every unrelated abandonment.

Standalone and builder-dispatched requests enter the same `runProbationBuild` prepare branch. Batch preparation delegates each member to that function (we:scripts/operations/prepare-batch.mjs:29); include the evidence locator in rejection detail so the existing batch drop-reason propagation retains it. No second authorization policy or independent builder implementation is needed.

## MVP

Implement the comparison, two prepare call-site diagnostics, evidence writer and failure fallback in the two scoped source files. Extend their matching test files. Preserve the ratified size/blockedBy behavior, normal build-mode rejection, hook-security handling and the existing repair limit. Do not introduce automatic edge application, replay rejected work, or change successful prepare publication.

## Acceptance

Each named test below is to be added to the indicated file and must fail on the pre-build implementation and pass after the change; existing green policy tests remain regression checks.

- [A1] Executable — `prepare violations identify every added changed and removed key` in we:scripts/lib/__tests__/probation-launcher.test.mjs asserts complete before/after diagnostics, absent-versus-null, multiline values, LF/CRLF, and exclusion of the five permitted keys.
- [A2] Executable — `prepare unreadable frontmatter is an explicit violation` in we:scripts/lib/__tests__/probation-launcher.test.mjs covers missing cards, missing delimiters, malformed content and duplicate keys. Retain the existing boolean default behavior for non-prepare callers.
- [A3] Executable — `prepare rejection retains evidence before discard at both checkpoints` in we:scripts/operations/__tests__/probation-build-run.test.mjs parameterizes post-worker and post-stamp rejection, verifies every field/value in the result, retained patch/raw cards, write-before-reset ordering, truthful scorecard metadata and no publication. Exercise ordinary and builder-style runId/effectKey arguments and prepareCommitOnly used by batches.
- [A4] Executable — `prepare evidence failure preserves the lane and escalates` in we:scripts/operations/__tests__/probation-build-run.test.mjs injects diff-read and artifact-write errors, asserting no discard or publication and an explicit recovery location/reason. Unreadable card evidence also refuses without silently succeeding.
- [A5] Executable — `prepare retention uses real private artifacts without publishing untrusted values` in we:scripts/operations/__tests__/probation-build-run.test.mjs uses a temporary git repository and injected salvage root to verify patch survival after reset, unique artifacts across two attempts, private permissions, inert control/shell text and sanitized diagnostics. Existing allowed scope/size/estimatedLoc and forbidden blockedBy/status/lifecycle assertions remain intact alongside these new evidence assertions.

## Test plan

Run only we:scripts/lib/__tests__/probation-launcher.test.mjs and we:scripts/operations/__tests__/probation-build-run.test.mjs through we:scripts/readiness/heavy-admission.mjs with a single bounded wait. Before implementation, add the named tests and record their expected failures; afterwards run the same files. Use injected IO for failure sequencing and a temporary repository for the actual artifact writer. Keep ordinary build rejection assertions and the existing missing/resolved/cyclic blockedBy proposal cases. No external model, GitHub or production lane is necessary for deterministic coverage.

## Proof plan

Attach the focused red/green test output and one hermetic end-to-end prepare rejection result with its manifest and retained diff. Verify the diff can be inspected after lane cleanup, forbidden fields never reach a commit, and artifact failure leaves recoverable work. Replay representative #3996/#4003 corrections in fixtures (scope/size plus proposed dependency edges), rather than mutating those historical cards or claiming their current contents recreate the old failure. A live authorized runner smoke test may supplement this proof, but is not a prerequisite for preparation.

## Edge cases

Unknown keys, deleted keys, malformed or deleted cards, multiline values and CRLF need explicit comparison coverage. An artifact failure must not fall through the outer catch into destructive abandonment. A post-stamp violation needs the same retained evidence as a post-worker violation. Existing hook restoration/quarantine precedes any new git-based capture. Path-only envelope violations retain their separate refusal reason.

## Follow-ups

General retention for non-prepare failures and automated artifact cleanup are separate work. The independent parked-PR reviewer remains the confirmation actor for proposed blockedBy changes; this item neither applies those edges nor changes review policy.

## Progress

- Preparation research: the old premise allowed only scope and preparation stamps and suggested directly widening blockedBy. Corrected premise: size and estimatedLoc are already allowed (we:scripts/lib/probation-launcher.mjs:219); blockedBy proposal validation already runs (we:scripts/operations/probation-build-run.mjs:724). The operator ruling below settles the policy, so no unresolved policy choice remains.
- The remaining defect is observed in the generic refusal at we:scripts/operations/probation-build-run.mjs:543 and reset path at we:scripts/operations/probation-build-run.mjs:354, implemented by we:scripts/operations/probation-build-run.mjs:1110. The post-stamp envelope check at we:scripts/operations/probation-build-run.mjs:719 also lacks field diagnostics. This is partial delivery, not already-done.
- Old scope: two source files and only the runner test. Corrected scope: same source files plus both matching tests; the missing helper test is we:scripts/lib/__tests__/probation-launcher.test.mjs, whose existing authorization cases begin at line 265. Existing prepare refusal coverage is at we:scripts/operations/__tests__/probation-build-run.test.mjs:1466. Batch delegates to the common runner at we:scripts/operations/prepare-batch.mjs:29, so no new batch policy is scoped.
- Size remains 3. Touch-set estimate: helper approximately 70 changed lines, runner approximately 100, helper tests approximately 80, runner tests approximately 150 (about 400 total). This is a story, so no estimatedLoc field is added. No lifecycle or dependency frontmatter changes are proposed. Runner owns checks and stamping; this preparation does not stamp or execute a live prepare.

## Operator ruling — 2026-10-03 (ratified, verbatim)

No ruling operation exists for a non-decision card (checked `we:scripts/operations/` and the `we:scripts/backlog.mjs` verbs), so the ruling is recorded here in the body; no lifecycle field was touched.

Question: may a prepare worker change a card's `size` and `blockedBy`?

1. Operator answer: "Seems that it would need to be"
2. Operator refinement: "Blocked by, maybe with a confirmation from another agent?"

Resulting rule:
- `size`: the prepare worker may change it directly, grounded in file:line evidence and stated in `## Progress`. Implemented by adding `size` to `PREPARE_OWNED_FRONTMATTER_KEYS` (we:scripts/lib/probation-launcher.mjs).
- `blockedBy`: the worker may only PROPOSE edge changes in a `## Proposed blockedBy changes` section (add/remove, with file:line grounds); the frontmatter stays unchanged, and a direct `blockedBy:` edit is still refused as tamper. Confirmation mechanism: the parked prepare PR's independent review is the second actor (a different session from the preparer); the runner lists the proposed edges in the PR body. No existing juror pattern was reused because the review already is an independent actor. An add may never target a resolved or missing card or create a cycle (`validateProposedBlockedBy`, the same rules as check:standards "6d-ter"); the runner refuses the run otherwise.

