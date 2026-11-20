---
bornAs: xetg964
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4878-ci-heals-routed-to-antigravity-die-without-an-outcome-so-a-r.md"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "0c1b97d16c505e3fc68a216dbf892aa8c76f4042"
tags: []
---

# Prevention — Add a Must line to the card requiring failure-marker diagnostics to be a structured allow-listed set (e… (from chalbert/web-everything#3440 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4878-ci-heals-routed-to-antigravity-die-without-an-outcome-so-a-r.md (Done when)` — Add a Must line to the card requiring failure-marker diagnostics to be a structured allow-listed set (exit code, signal, quota-hold id, reset time) or redacted, with a named test. Longer term, add a lint or gate that any text written to a PR comment goes through a shared redaction helper.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3440@e1ba0281892ef443ab0f18d0379232760bbdaa88

## Progress

Preparation research, 2026-10-03:

- **Old premise/scope:** the approval asked for a Must line in we:backlog/4878-ci-heals-routed-to-antigravity-die-without-an-outcome-so-a-r.md, citing line 23 and suggesting diagnostic fields including a quota-hold id. The scope named only that card. Line 23 now belongs to implementation progress, not acceptance criteria.
- **Corrected premise/scope:** the target card is resolved, but its Done when section still has no diagnostic-publication Must line or named redaction test. Retain the documentation-only scope and target that heading. Do not reopen the implemented heal story or add a new runtime feature. The requested documentation guard remains undelivered even though runtime protection has landed.
- **Source evidence:** commit `e23f1963f` added structured public failure evidence. In we:scripts/operations/probation-heal-run.mjs:73-78, publicFailureEvidence selects outcome, integer exit code, shaped signal, quota state and reset time; invalid or absent values become unknown. It does not publish a quota-hold id. In we:scripts/operations/probation-heal-run.mjs:120-125, publishHealAttempt passes that projection, not the raw detail, to the comment builder. These are fixed selected fields with shape validation, not a closed enumeration of every string value.
- **Matching tests already exist:** we:scripts/operations/__tests__/probation-heal-run.test.mjs:750-757 tests that unlisted secret shapes never reach the public comment while exit/signal/quota/reset survive. Its next case covers upstream truncation boundaries. In we:scripts/conveyor/ci-heal-mark.mjs:298-301, sanitizeForPublicComment redacts before truncating; we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs:545-599 covers credentials, forged markers and bounded output. These source/test pairs are read-only grounding, not planned edits. No source entry is being added to scope, so no source/test scope expansion is required.

Preparation refresh, 2026-11-20:

- **Old premise/scope → corrected premise/scope:** the existing preparation correctly scoped one missing documentation bullet, but its source and test line citations had drifted. Current inspection confirms the target remains resolved and its Done when section still lacks the bullet (we:backlog/4878-ci-heals-routed-to-antigravity-die-without-an-outcome-so-a-r.md:62-67). Keep the same one-card scope and original goal; the runtime protection is already present, but the requested documentation is not.
- **Current evidence:** the projection and its publication caller are at we:scripts/operations/probation-heal-run.mjs:73-78,120-125; formatter redaction precedes truncation at we:scripts/conveyor/ci-heal-mark.mjs:298-301. Matching cases are at we:scripts/operations/__tests__/probation-heal-run.test.mjs:750-778 and we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs:545-599. Corrected the citations above. Shape validation is not semantic timestamp validation or a closed vocabulary of outcome/quota values.
- **Estimate:** retain story size 3; the touch set is one existing card × approximately one added paragraph (about 5–8 wrapped lines), plus document proof and focused existing regression verification. No source or test file is a planned edit. No defaults, callers, or runtime fail-closed behavior change; the documented missing/invalid-field fallback remains unknown.
- The runner owns preparation stamps and checks. This refresh leaves both existing stamp fields untouched.

## Design

Add the following acceptance requirement under Done when in we:backlog/4878-ci-heals-routed-to-antigravity-die-without-an-outcome-so-a-r.md:

> **Must — failure-marker diagnostics:** CI-heal failure comments publish only the selected, validated structured fields (outcome, exit code, signal, quota state and reset time); absent or invalid fields say unknown. Raw worker output, wrapper logs and arbitrary diagnostic detail must not enter the public comment. The comment formatter must redact before truncating and neutralize forged markers. Verify with “never publishes raw worker or log text: unlisted secret shapes cannot reach the public comment” in we:scripts/operations/__tests__/probation-heal-run.test.mjs and the “PR #3577 review: failure detail is neutralised before it reaches a public bot comment” suite in we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs.

This documents the current stronger structured-publication boundary rather than relaxing it to permit arbitrary text merely because a denylist redactor ran. The original quota-hold-id example is not a requirement to invent or expose another field. Preserve the target card's status, historical evidence and existing acceptance criteria.

## MVP

Insert that single Must bullet, including the named existing regression coverage, into the target card. No production code, test implementation, shared documentation or general PR-comment gate changes. Do not claim that the formatter's secret-pattern denylist proves arbitrary text safe.

## Acceptance

- [A1] The target Done when section contains exactly the Must bullet in Design, including all five selected fields, unknown fallback, raw-text prohibition, formatter requirements and both named tests. Every other byte of the target card, including frontmatter and existing criteria, is preserved.
- [A1] Executable: run the `python3` document assertion below against the captured pre-build target. It fails before the insertion and passes after; it also fails if the bullet is incomplete, duplicated, outside Done when, or any other target content changes. Existing runtime tests are supporting evidence, not a red-to-green claim for this documentation change.

## Test plan

Before the build, capture the target's bytes in a task-local scratch file under `$TMPDIR`, export its path as `CARD4803_BASELINE`, and retain it through verification. Run this exact read-only assertion from the WE root before and after inserting the bullet. Repository prefixes in the script are removed only when opening local files:

```python
# Execute with python3 via a heredoc; CARD4803_BASELINE holds the pre-build bytes.
import os
from pathlib import Path

def repo_path(reference):
    assert reference.startswith("we:")
    return Path(reference.removeprefix("we:"))

source = repo_path("we:backlog/4803-prevention-add-a-must-line-to-the-card-requiring-failure-mar.md").read_text()
quote = next(line for line in source.splitlines() if line.startswith("> **Must — failure-marker diagnostics:**"))
bullet = "- " + quote.removeprefix("> ") + "\n"
target = repo_path("we:backlog/4878-ci-heals-routed-to-antigravity-die-without-an-outcome-so-a-r.md").read_bytes()
baseline = Path(os.environ["CARD4803_BASELINE"]).read_bytes()
text = target.decode()
section = text.split("## Done when\n", 1)[1].split("\n## ", 1)[0]
assert section.count(bullet) == 1, "A1: exact Must bullet missing or duplicated"
assert target.count(bullet.encode()) == 1, "A1: duplicate bullet outside acceptance"
assert target.replace(bullet.encode(), b"", 1) == baseline, "A1: unrelated target changes"
print("A1 passed")
```

Insert only that bullet line, preserving existing blank lines, so removing it reproduces the captured baseline exactly. Missing baseline, unreadable target, absent heading, or missing Design quote makes the assertion fail rather than silently accepting incomplete evidence.

For supporting runtime evidence, invoke `node` with we:scripts/readiness/heavy-admission.mjs and arguments `run -- npx vitest run`, followed by we:scripts/operations/__tests__/probation-heal-run.test.mjs and we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs (strip repository prefixes only at invocation). Confirm the named publication, truncation and formatter cases execute. Run `npm run check:standards` through the same heavy-admission queue and run `git diff --check`. If admission is busy, wait once using its supported bounded-wait option, then stop and report if still unavailable. No new test file, real PR write, or worker launch is needed.

## Proof plan

Record the before/after document assertion and the focused test results. Review the final target-card diff to show only the Must bullet was added and no status or existing criterion changed. Use the injected publication harness in we:scripts/operations/__tests__/probation-heal-run.test.mjs to demonstrate the actual produced comment excludes hostile raw diagnostics while retaining the selected evidence. Keep documentation proof separate from the already-delivered runtime behavior. Preparation does not insert the bullet into the other card, run a live heal, or claim new runtime protection.

## Follow-ups

- The original longer-term proposal remains separate: inventory PR-comment publication boundaries and scope a lint/gate requiring a shared redaction helper. That broader guard is not delivered by this card; its consumers and exceptions require research before implementation.
- If the selected public fields change later, update the Must line and its named test together. A quota-hold id is not currently a public field and must not be added merely to match the old example.
