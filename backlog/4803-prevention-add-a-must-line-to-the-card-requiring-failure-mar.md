---
bornAs: xetg964
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4878-ci-heals-routed-to-antigravity-die-without-an-outcome-so-a-r.md"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "3ccef93f4630a63d688bb1fa28854ded5e026dd9"
tags: []
---

# Prevention — Add a Must line to the card requiring failure-marker diagnostics to be a structured allow-listed set (e… (from chalbert/web-everything#3440 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4878-ci-heals-routed-to-antigravity-die-without-an-outcome-so-a-r.md (Done when)` — Add a Must line to the card requiring failure-marker diagnostics to be a structured allow-listed set (exit code, signal, quota-hold id, reset time) or redacted, with a named test. Longer term, add a lint or gate that any text written to a PR comment goes through a shared redaction helper.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3440@e1ba0281892ef443ab0f18d0379232760bbdaa88

## Progress

Preparation research refreshed, 2026-11-20:

- **Old premise/scope:** the approval asked for a Must line in we:backlog/4878-ci-heals-routed-to-antigravity-die-without-an-outcome-so-a-r.md, citing line 23 and suggesting diagnostic fields including a quota-hold id. The scope named only that card. Line 23 now belongs to implementation progress, not acceptance criteria.
- **Corrected premise/scope:** the target card is resolved, but its Done when section still has no diagnostic-publication Must line or named redaction test. Retain the documentation-only scope and target that heading. Do not reopen the implemented heal story or add a new runtime feature. The requested documentation guard remains undelivered even though runtime protection has landed.
- **Source evidence:** commit `e23f1963f` added structured public failure evidence. In we:scripts/operations/probation-heal-run.mjs:73-78, publicFailureEvidence selects outcome, integer exit code, shaped signal, quota state and reset time; invalid or absent values become unknown. It does not publish a quota-hold id. In we:scripts/operations/probation-heal-run.mjs:118-125, publishHealAttempt passes that projection, not the raw detail, to the comment builder. These are fixed selected fields with shape validation, not a closed enumeration of every string value.
- **Matching tests already exist:** we:scripts/operations/__tests__/probation-heal-run.test.mjs:750-757 tests that unlisted secret shapes never reach the public comment while exit/signal/quota/reset survive. Its next case covers upstream truncation boundaries. In we:scripts/conveyor/ci-heal-mark.mjs:298-300, sanitizeForPublicComment redacts before truncating; we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs:545-601 covers credentials, forged markers and bounded output. These source/test pairs are read-only grounding, not planned edits. No source entry is being added to scope, so no source/test scope expansion is required.

- **Refresh evidence:** the old preparation described all CI-heal comments; the corrected scope is the attempt-accounted failure diagnostic payload projected by we:scripts/operations/probation-heal-run.mjs:125. The generic formatter still accepts redacted free text at we:scripts/conveyor/ci-heal-mark.mjs:349. No policy change to other callers is implied. The target acceptance section remains at we:backlog/4878-ci-heals-routed-to-antigravity-die-without-an-outcome-so-a-r.md:63 and still lacks this Must line. Corrected stale source/test citations above. Retain size 3 and the one-card scope: one file × approximately 2 added lines (one Must bullet plus spacing), with existing regression suites used only as evidence. No defaults, callers, or runtime fail-closed paths change; the documented unknown fallback already exists at we:scripts/operations/probation-heal-run.mjs:74-77.

## Design

Add the following acceptance requirement under Done when in we:backlog/4878-ci-heals-routed-to-antigravity-die-without-an-outcome-so-a-r.md:

> **Must — failure-marker diagnostics:** Attempt-accounted CI-heal failure diagnostics publish only the selected, validated structured fields (outcome, exit code, signal, quota state and reset time); absent or invalid fields say unknown. Raw worker output, wrapper logs and arbitrary diagnostic detail must not enter the public comment. The comment formatter must redact before truncating and neutralize forged markers. Verify with “never publishes raw worker or log text: unlisted secret shapes cannot reach the public comment” in we:scripts/operations/__tests__/probation-heal-run.test.mjs and the “PR #3577 review: failure detail is neutralised before it reaches a public bot comment” suite in we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs.

This documents the current stronger structured-publication boundary rather than relaxing it to permit arbitrary text merely because a denylist redactor ran. The original quota-hold-id example is not a requirement to invent or expose another field. Preserve the target card's status, historical evidence and existing acceptance criteria.

## MVP

Insert that single Must bullet, including the named existing regression coverage, into the target card. No production code, test implementation, shared documentation or general PR-comment gate changes. Do not claim that the formatter's secret-pattern denylist proves arbitrary text safe.

## Acceptance

- [A1] The target Done when section gains exactly the Design Must bullet, including its five selected fields, unknown fallback, raw-text prohibition, formatter requirements and both named test references. The rest of the target card remains byte-for-byte unchanged, including frontmatter and existing criteria.
- [A1] Executable: run the `python3` document assertion below before and after implementation. It must fail on the missing bullet before the build and pass after insertion; missing headings, duplicate bullets, altered surrounding content, or incomplete wording fail closed. This is the sole changed guarantee; runtime defaults and callers remain unchanged.

## Test plan

Run this exact document assertion from the WE root before editing the target and again after inserting the bullet. It derives the required wording from this card's Design section and compares all other bytes with the target at the implementation checkout's HEAD. Run before committing so that HEAD remains the baseline. No persistent test file is needed.

```sh
python3 - <<'PYASSERT'
from pathlib import Path
import subprocess

def local(ref):
    assert ref.startswith('we:')
    return ref.removeprefix('we:')

plan = Path(local('we:backlog/4803-prevention-add-a-must-line-to-the-card-requiring-failure-mar.md')).read_text()
target = local('we:backlog/4878-ci-heals-routed-to-antigravity-die-without-an-outcome-so-a-r.md')
design = plan.split('## Design\n', 1)[1].split('\n## ', 1)[0]
quoted = [line for line in design.splitlines() if line.startswith('> **Must — failure-marker diagnostics:**')]
assert len(quoted) == 1, 'exactly one designed requirement required'
bullet = '- ' + quoted[0][2:]
current = Path(target).read_text()
baseline = subprocess.check_output(['git', 'show', 'HEAD:' + target], text=True)
section = current.split('## Done when\n', 1)[1].split('\n## ', 1)[0]
assert section.splitlines().count(bullet) == 1, 'missing or duplicate exact Must bullet'
assert current.count(bullet + '\n') == 1
without = current.replace(bullet + '\n', '', 1)
assert without == baseline or without.replace('\n\n\n', '\n\n', 1) == baseline, 'unrelated target edits'
print('A1 passed: exact Must bullet; original card preserved')
PYASSERT
```

As supporting runtime regression evidence, invoke `node` on we:scripts/readiness/heavy-admission.mjs with `run --wait-ms=60000 -- npx vitest run` and the two arguments we:scripts/operations/__tests__/probation-heal-run.test.mjs and we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs, stripping repository prefixes from filesystem arguments. Confirm the named publication and formatter cases execute, including the upstream truncation case adjacent to the publication test. These tests already exist and are not the red/green acceptance proof for the documentation change.

The runner owns preparation checks and stamping. At implementation verification, run `npm run check:standards` through the same heavy-admission command and run `git diff --check`. If admission is busy, use only that single bounded wait, then stop and report. No real PR writes or worker launches are needed.

## Proof plan

Record the before/after document assertion and the focused test results. Review the final target-card diff to show only the Must bullet was added and no status or existing criterion changed. Use the injected publication harness in we:scripts/operations/__tests__/probation-heal-run.test.mjs to demonstrate the actual produced comment excludes hostile raw diagnostics while retaining the selected evidence. Keep documentation proof separate from the already-delivered runtime behavior. Preparation does not insert the bullet into the other card, run a live heal, or claim new runtime protection.

## Follow-ups

- The original longer-term proposal remains separate: inventory PR-comment publication boundaries and scope a lint/gate requiring a shared redaction helper. That broader guard is not delivered by this card; its consumers and exceptions require research before implementation.
- If the selected public fields change later, update the Must line and its named test together. A quota-hold id is not currently a public field and must not be added merely to match the old example.
