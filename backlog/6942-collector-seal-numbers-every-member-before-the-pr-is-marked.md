---
bornAs: x1mmp60
kind: story
size: 3
parent: "6944"
status: open
blockedBy: ["6941"]
scope: ["we:scripts/operations/card-batch-seal.mjs", "we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/card-batch-extract.mjs", "we:scripts/operations/__tests__/card-batch-seal.test.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs", "we:scripts/operations/__tests__/card-batch-extract.test.mjs"]
scopeRationale: "The numbered backlog paths in Acceptance are disposable fixtures created in temporary test repositories. Scope covers the seal and extraction modules and their tests."
dateOpened: "2026-10-18"
tags: []
---

# Collector seal numbers every member before the PR is marked ready

Per decision 6940 fork 5 (statute backlog-ids-numbered-before-publish): add a number-members seal step after record-sealed and before verify, calling the declared numbering operation once over the whole branch so sibling references resolve together. It fails closed: if numbering fails the batch stays held and never reaches ready.

The `number-members` step must record each member's old->new path map in the batch journal. After numbering, each member carries BOTH `admissionPath` (for the original blob read from `${member.commitSha}:${member.admissionPath}` in `we:scripts/operations/card-batch-extract.mjs:214-218`) and `numberedPath` (for attribution of findings on the renamed card). Member attribution in `we:scripts/operations/card-batch-extract.mjs` (the `cardPath` derivation at lines 199-207) must resolve a member by either path, applying the journal map or following the rename with `git diff-tree -M`. Findings citing the numbered path must still be attributed to the original member. Extraction rebuilds BOTH the standalone card and every surviving batch member at their `numberedPath`, with the numbering operation’s rewritten text taken from the recorded numbering commit, preserving rewritten sibling cross-references. Persist that commit with the path map so extraction can reconstruct the numbered content after restart; never read a numbered path from an original admission commit or emit an admission-path card with stale text.

Seal resume is decided from the journal, not only from the persisted step. `planSeal` in `we:scripts/operations/card-batch-seal.mjs` today slices the step list after the persisted `seal.step`, so inserting `number-members` would let a batch already mid-seal skip it. If any member lacks a recorded `numberedPath` (a batch sealed before this change, at persisted step `verify`, `remove-hold` or `ready`, or any other step after `number-members`), `planSeal` restarts at `number-members`, then continues `verify`, `remove-hold`, `ready`, `label-on-green`. A batch whose members all carry `numberedPath` resumes at the persisted step as today. A member that already carries `numberedPath` is never numbered again on that restart (6943's exactly-once rule), and a numbering failure there holds the batch as any numbering failure does. `sealFailure` still plans `held`, and a `label-on-green` archive is not relaunched (6941), so neither goes through this check.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/operations/__tests__/card-batch-seal.test.mjs we:scripts/operations/__tests__/card-batch-seal-io.test.mjs we:scripts/operations/__tests__/card-batch-extract.test.mjs` fails before this item lands and passes after. Planned cases:
  - `seal steps run record-sealed, number-members, verify, remove-hold, ready, label-on-green` (we:scripts/operations/__tests__/card-batch-seal.test.mjs).
  - `legacy mid-seal batch at verify, remove-hold or ready is renumbered before it proceeds` (we:scripts/operations/__tests__/card-batch-seal.test.mjs) — for each of the three persisted steps `verify`, `remove-hold` and `ready`, with members that carry no `numberedPath`, `planSeal` returns steps starting with `number-members` and continuing `verify`, `remove-hold`, `ready`, `label-on-green`. Control: members that all carry `numberedPath` at persisted step `ready` return only `label-on-green`.
  - `numbers all siblings in one pass so cross-references resolve` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — two members that name each other both carry the new numbers.
  - `findings on a numbered member's new path are attributed to that member` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — admit a fixture card with provisional id xabc123 plus a sibling, assign that member number 6500 at seal, and assert that the batch journal records its old->new path map. Reconstruct the members through `we:scripts/operations/card-batch-extract.mjs`'s production attribution path from the original admission commits and the persisted seal journal, rather than supplying a hand-corrected `cardPath` in the fixture. Run `attributeFindings` with a finding citing the member's numbered fixture path (use repo-relative paths in the fixture); it must return `extract` for that member, not `hold`, and retain the sibling in `survivors`. Also check that a finding citing its admission path still resolves to the same member.
  - `extracting a numbered member rebuilds both PRs` (we:scripts/operations/__tests__/card-batch-extract.test.mjs) — admit xabc123 and a sibling whose texts reference each other, then run the production seal numbering path to produce `we:backlog/6500-card.md` and `we:backlog/6501-sibling.md`. Reload the persisted journal (including both paths and the recorded numbering commit) and reconstruct members through production extraction, without hand-corrected paths or content. Attribute a finding on `we:backlog/6500-card.md`, then run the production extract build over that journal through both rebuilt commits. Assert there is no blob-read failure; the standalone commit's diff against its parent adds exactly that member at `we:backlog/6500-card.md`, with the numbering operation's rewritten text and reference to `we:backlog/6501-sibling.md`, and adds neither the sibling nor any admission path. Assert the surviving batch commit retains only the sibling at `we:backlog/6501-sibling.md`, with its rewritten text and cross-reference to `we:backlog/6500-card.md` intact, and contains neither the extracted member nor either admission path. Inspect both commits' trees and blobs, not just `attributeFindings` or a mocked build result.
  - `numbering failure retains the hold and never reaches ready` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs).
  - `seal step changes card text only through the numbering operation` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — with the numbering operation stubbed to rename files only, every member's content is byte-identical after `number-members` except for the lines that operation rewrote; the seal step itself edits no card text.
  - `members are numbered through the batch repo's own operation` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — a batch for a sibling repo calls that repo's declared numbering operation with that repo's checkout, never WE's, and a WE batch calls WE's.
  - `partial numbering output retains the hold` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — the numbering operation exits 0 but numbers 7 of 8 members (one keeps its hash name): the step counts as failed, the batch stays held, and verify and ready never run.
  - `crash after the numbering push and before the head is recorded resumes without head-mismatch` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — fault injection: the numbering commit is on the remote but `headSha` is still the pre-numbering head; the next run adopts the numbered head (or re-records it) and continues to verify, never refusing `head-mismatch` and never numbering twice.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No change to the numbering operation itself or to the land-time uniqueness check (statute backlog-ids-numbered-before-publish rule 1).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — card bodies are rewritten only by the declared numbering operation; the seal step does no text substitution of its own (case `seal step changes card text only through the numbering operation`).
2. **Truncated reads** — numbering output that does not cover every member counts as a failure; the batch stays held (case `partial numbering output retains the hold`).
3. **Shared state files** — the step runs under the seal lease on the collector branch; the rewritten head is recorded before verify runs on it (case `crash after the numbering push and before the head is recorded resumes without head-mismatch`).
4. **Fail closed** — any numbering failure keeps the batch held and never reaches ready (case `numbering failure retains the hold and never reaches ready`).
5. **Identity scoping** — numbers are allocated per repo through the declared operation (case `members are numbered through the batch repo's own operation`).
6. **State over time** — the resume point comes from the journal, not only the persisted step: a batch persisted mid-seal before this change (at `verify`, `remove-hold` or `ready`, members without `numberedPath`) restarts at `number-members` instead of skipping it (case `legacy mid-seal batch at verify, remove-hold or ready is renumbered before it proceeds`), and a re-run after a timeout must not renumber (6943's case `timeout during number-members then resume leaves each member numbered exactly once`). 6941's resume of an open `sealed/` archive at step `ready` goes through the same journal check.
7. **Who wrote it** — the numbering commit is not an admit commit; if the batch is later closed, 6941 surfaces it through the PR link.
