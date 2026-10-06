---
bornAs: x2c7uas
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/probation-launcher.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/lib/__tests__/probation-launcher.test.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-06"
preparedAgainstSha: "75c39659a06fefd7ee76fb1af223d53880109a25"
tags: []
---

# Prevention — Add a contract test that feeds an alphanumeric id through parseProposedBlockedBy, validateProposedBlock… (from chalbert/web-everything#3783 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/probation-launcher.mjs:232` — Add a contract test that feeds an alphanumeric id through parseProposedBlockedBy, validateProposedBlockedBy and blockedByGraph. Better, share one backlog-id regex constant with check-standards so the two cannot diverge.
2. `we:scripts/operations/probation-build-run.mjs:571` — Add a runProbationBuild prepare-path test with a fake io whose card body carries a `## Proposed blockedBy changes` section. Assert an abandon on a cyclic proposal and the proposal text in the writePrBody args on a valid one.
3. `we:scripts/operations/probation-build-run.mjs:571` — A contract test that every new runner abandon/fail-closed branch has a named runner-level test, for example a check:standards rule requiring each `abandon(` reason string to appear in a test file.
4. `we:scripts/operations/probation-build-run.mjs:574` — Add a deterministic runProbationBuild integration test with a parsed invalid proposal and a supplied graph, asserting gate-red and no PR creation; ensure removing the validation branch makes that test fail.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3783@2341caec72073913fe88596e654f65bbe854ae36

## Design

Premise holds on current `main` (no commit delivers it; `git log --grep=4705` shows only the JIT-number drain). The gap is real: the proposed-edge path matches digits only, while the repo's two-form id is `NNN` or a provisional `x[0-9a-z]{6}` hash (`we:scripts/check-standards-rules.mjs:663`, `ITEM_REF_RX`).

- `we:scripts/lib/probation-launcher.mjs:228` — `parseProposedBlockedBy` bullet regex uses `(\d+)`, so `- add 4705 — …` is silently dropped (no violation, no edge).
- `we:scripts/operations/probation-build-run.mjs:744-758` — `realIo().blockedByGraph` keys cards by `/^(\d+)-.*\.md$/`, so hash-named cards are absent from the graph; a proposal against one would read "does not resolve".
- `we:scripts/operations/probation-build-run.mjs:571-577` — the prepare branch parses the proposal, loads the graph, calls `validateProposedBlockedBy`, and abandons `gate-red` on violations; `writePrBody` (`:617`) receives `proposedEdges`. None of this has a runner-level test.
- Mechanism: export ONE id-pattern constant (`BACKLOG_ID_SOURCE = '\\d{1,5}|x[0-9a-z]{6}'`, exactly the shape of `ITEM_REF_RX` minus its `#`; `we:scripts/lib/citation-check.mjs:79` `HASH_SLUG` is also `{6}`, while its `:107`/`:168` use `{6,7}` for file-name globs — the constant follows the `{6}` id form) from `we:scripts/lib/probation-launcher.mjs`; use it in the parser regex and in the `blockedByGraph` filename regex. Add the tests below. `ITEM_REF_RX` is a non-exported const in `we:scripts/check-standards-rules.mjs:663` (outside this card's scope), so the contract test reads that file's text, extracts the `ITEM_REF_RX` literal, and asserts it equals `#(?:` + constant + `)\b`; exporting it is a Follow-up.

## MVP

Musts only:
1. Shared id constant used by `parseProposedBlockedBy` and `blockedByGraph`; alphanumeric ids parse and enter the graph.
2. Launcher contract test: alphanumeric id through `parseProposedBlockedBy`, `validateProposedBlockedBy`, graph walk (incl. a cycle through a hash id).
3. Runner prepare-path tests (cyclic proposal → `gate-red` abandon; valid proposal → text in `writePrBody` args; invalid proposal + supplied graph → gate-red and no `openPr`).

Out of scope (Follow-ups): the check:standards rule requiring every `abandon(` reason string to appear in a test (item 3 of the card); rewriting `ITEM_REF_RX` itself.

## Test plan

In `we:scripts/lib/__tests__/probation-launcher.test.mjs`:
- `parses alphanumeric ids` — asserts `- add 4705 — …` yields target `4705`. RED today: `\d+` drops the line, result `[]`.
- `validates and walks a graph with hash ids` — builds the edges by feeding card TEXT through `parseProposedBlockedBy` (not hand-built edges, which the id-agnostic validator already accepts), graph with `4705`; the resulting add closes a cycle and reports `cycle`. RED today: the parser emits no edge, so no cycle is reported.
- `ignores ids outside the proposal section` — an `- add 4705` bullet under another `##` heading and an `4705` token in prose yield no edge (non-code-input Must). Characterization, green today; mutation proof: loosen the section-scoped regex to scan the whole card and this test fails.
- `id constant matches ITEM_REF_RX` — the extracted `ITEM_REF_RX` literal equals `#(?:` + constant + `)\b`; samples `4705`, `4705` accepted, `x2c7uasq` (7 chars) rejected. RED today: the constant does not exist.

In `we:scripts/operations/__tests__/probation-build-run.test.mjs` (build on `prepareIo`, `:798`; append the proposal section to `postWorkerRaw`, set `io.blockedByGraph = () => new Map(...)` — `fakeIo` defines neither — and override `io.writePrBody` to capture its args, since the fake drops them; `self` is `4291`). The two runner tests below use numeric ids and are CHARACTERIZATION tests (green today) guarded by the mutation check, not RED:
- `abandons gate-red on a cyclic proposal` — card body carries `## Proposed blockedBy changes` adding a cycle edge, `io.blockedByGraph` supplied; asserts outcome `gate-red`, detail `blockedBy cycle`, no `openPr`/`prBody` call. RED if the validation branch (`:577`) is removed (mutation check).
- `passes a valid proposal to writePrBody` — preservation (green today): asserts `proposedEdges` in the args equals the parsed edge and PR opens; mutation proof: drop `proposedEdges` from the `writePrBody` call (`:617`) and this test fails.
- `realIo().blockedByGraph includes hash-named cards` — temp backlog dir holding a hash-named card file (`we:backlog/4705-foo.md` shape); asserts the key is present. RED today: regex `\d+` skips it.

## Proof plan

- `npx vitest run probation-launcher probation-build-run` — before (tests added, constant not yet used): exactly four cases fail — parser alphanumeric, hash-id cycle, `blockedByGraph` hash-card, id-constant/`ITEM_REF_RX`; after: all green.
- Live probe: `node -e` importing `parseProposedBlockedBy` from the launcher module with a card containing `- add 4705 — r (we:a:1)`; before prints `[]`, after prints one edge.
- Mutation check: temporarily delete the `bad.length` abandon at `we:scripts/operations/probation-build-run.mjs:577`; the cyclic-proposal test must fail; restore.

## Follow-ups

- A check:standards rule: every `abandon(` reason string in `we:scripts/operations/probation-build-run.mjs` must appear in a test file (card item 3).
- Export `ITEM_REF_RX` from `we:scripts/check-standards-rules.mjs` so the contract test can import it instead of reading source text.
- Derive `ITEM_REF_RX`, `we:scripts/lib/citation-check.mjs` and the launcher regexes all from one shared id module.

## Done when

1. **Executable** — `npx vitest run probation-launcher probation-build-run` fails before this item lands (alphanumeric-id and cyclic-proposal cases) and passes after.
2. **Must (refuse on error)** — a proposal naming an unknown, resolved, self, or cyclic target (numeric or hash id) still abandons `gate-red` with no PR opened.
3. **Must (non-code inputs)** — card-body prose, config and data lines outside the `## Proposed blockedBy changes` section are still ignored by the parser.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
