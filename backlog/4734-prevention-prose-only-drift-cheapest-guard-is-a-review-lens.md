---
bornAs: x6hepxj
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:backlog/3372-verify-lane-runs-the-full-suite-instead-of-the-diff-driven-s.md", "we:scripts/lib/verify-lane-gate.mjs", "we:scripts/conveyor/verify-dispatch.mjs", "we:scripts/lib/__tests__/verify-lane-gate.test.mjs", "we:scripts/conveyor/__tests__/verify-dispatch.test.mjs", "we:scripts/verify-lane.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/lib/verify-marker-write.mjs", "we:scripts/lib/__tests__/verify-marker-write.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "cb057cf7c6104547c15892aed25af90cb14d8219"
tags: []
---

# Prevention — explicit-gate shell spelling and concurrent verification marker writes

Preserve the approval-prevention goal from chalbert/web-everything#3414: make card claims match test assertions, refuse shell-encoded forbidden gate flags, and prevent an older verification from overwriting a newer request.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3414@097e398e8df1458a20ce412163545e288fccb4c5

## Progress

- Original premise/scope: a prose-only review lens, gate validation at `we:scripts/lib/verify-lane-gate.mjs:440`, and ownership coordination in the dispatcher alone; size 3 with five scoped files. The original shortened test reference did not name the actual test directory.
- Corrected premise: the validator is now `explicitGateRefusal` at `we:scripts/lib/verify-lane-gate.mjs:806–827`. It splits whitespace and tests only tokens beginning with a literal hyphen; quoted/escaped flags can evade it. The acceptance table at `we:scripts/lib/__tests__/verify-lane-gate.test.mjs:759–802` even accepts quoted paths. The correction deliberately narrows this explicit-gate grammar, including that positive fixture; it does not change default gate generation.
- Caller evidence: `we:scripts/verify-lane.mjs:452–462` applies the validator only when the default is blocked, absent the existing policy-full/resolved-gate exemptions. Existing CLI tests at `we:scripts/__tests__/verify-lane.test.mjs:1467–1512` cover plain refusals, terminal-red dispatched children, and a docs-only exemption. Preserve those boundaries and extend the encoded-input cases.
- Corrected concurrency scope: `we:scripts/conveyor/verify-dispatch.mjs:375–393` reads ownership then atomically renames a result, with no exclusion covering both operations. Tests at `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs:758–876` install newer requests before the read, not during the read/write interval. `we:scripts/verify-lane.mjs:190–196` is the other production marker writer; its terminal ownership read at line 1194 also precedes its write at line 1220. Both writers must participate. Add a shared writer and matching tests; do not mistake atomic rename for conditional update.
- Prose evidence: the old line-80 citation in `we:backlog/3372-verify-lane-runs-the-full-suite-instead-of-the-diff-driven-s.md` is historical narrative, not a test assertion. Its Done when still mentions a full-suite fallback although its Follow-ups supersede that. The review lens already exists at `we:docs/agent/delivery-loop.md:256–260`: compare claims to named tests and mutate the guarded behavior. Reuse it; do not add a purported automated semantic-proof gate.
- Size 3 → 5: nine scoped files, approximately 20 lines of historical-card correction, 25 validator lines, 60 dispatcher integration lines, 80 CLI integration lines, 70 shared-writer lines, and approximately 50 + 90 + 90 + 100 test lines respectively (about 585 changed lines). The increase reflects the previously omitted writer/caller and deterministic concurrency coverage, not a new feature. The existing lock primitive at `we:scripts/lib/ledger-append-lock.mjs:32–84` can be composed without changing that file.
- Preparation is source inspection only; no runtime/test success is claimed. The runner owns stamps and validation.

## Design

Use the strict-token option already requested by the original prevention finding. Split explicit gates on literal `&&`; accept only horizontal ASCII whitespace between tokens and tokens made of `[A-Za-z0-9_./@=,-]`, except the fixed `check:standards` command word. Reject quotes, backslash, dollar, braces, glob characters, tilde, control characters and other shell punctuation before flag checks, in every segment including the standards segment. Retain the current allowed command forms and vitest flag allowlist. Reject empty segments. A refusal explains that an unquoted safe-path affected-test command or CI is required; paths requiring shell quoting use CI rather than silently escaping the guard. Generated default commands remain outside this explicit-input grammar.

Introduce `we:scripts/lib/verify-marker-write.mjs` (planned): one synchronous transaction over the resolved real git directory. Compose `withLedgerAppendLock` from `we:scripts/lib/ledger-append-lock.mjs`, using a marker-specific key and that git directory as the lock root so all processes addressing the same marker contend regardless of temporary-directory settings. Retain its bounded 120-second wait and dead-owner handling. Read the current marker, check ownership, construct the replacement and rename a unique temporary sibling while holding the lock. Always release in finally; remove temporary files on failure. Inject lock/IO seams for deterministic tests; never hold the lock during a gate or admission wait.

Route every production write in `we:scripts/verify-lane.mjs` and `recordKilledVerification` in `we:scripts/conveyor/verify-dispatch.mjs` through the transaction. New requests intentionally replace current state under the lock. Child start/refusal/completion and killed-run settlement conditionally replace only their captured request/run identity; preserve existing dispatcher runId and legacy identity matching. Move terminal ownership reads inside the transaction rather than wrapping only rename. Capture the full existing request identity before child restamping; a newer request with the same SHA/gate/tree must still survive. Standalone runs retain their own start identity for completion. Missing, corrupt or unreadable ownership evidence never authorizes conditional settlement.

Lock timeout or IO failure must leave the existing marker intact, emit a visible infrastructure/refusal diagnostic, and return failure rather than writing unlocked or reporting green. The operator fallback is to inspect the holder/IO error and explicitly retry after recovery; do not automatically redispatch or reset the marker. Keep marker schema and reader contracts unchanged.

Update the historical card's acceptance to label the original fallback as superseded and point to the current blocked-selection assertions. Apply the existing review lens to a claim-to-assertion table in the build evidence: prose about local coverage must not claim exhaustive CI coverage. No new reviewer infrastructure is needed.

## MVP

Must ship the strict explicit-input grammar, both writer integrations, shared transaction, deterministic interleaving/error tests, and the historical prose correction together. Keep selection defaults, full-policy exemptions, local-versus-CI authority, allowed safe flags, marker fields and existing run identity semantics unchanged except that terminal writes cannot claim a newer same-SHA request.

Could later replace the restricted string grammar with structured argv, supporting paths with spaces without shell interpretation. That is not required to close these bypasses.

## Acceptance

The named tests below are planned additions to the stated files. Each is a red-before/green-after regression; retain existing positive and boundary tests alongside them.

- [A1] Executable — `we:scripts/lib/__tests__/verify-lane-gate.test.mjs`, test `4734 rejects encoded forbidden flags in every segment`: table every currently blocked flag in single/double quotes, backslash spelling, ANSI-C quote spelling, variable expansion and brace/glob/tilde spellings. Assert refusal, while safe bare targets, --run, --bail and the standards suffix remain accepted. Include the formerly accepted quoted-target fixture as an intentional refusal.
- [A2] Executable — `we:scripts/__tests__/verify-lane.test.mjs`, test `4734 encoded gate cannot execute or stamp green`: request and dispatched-child callers refuse encoded gates after a blocked selection; request writes nothing, owned child records terminal red, neither launches the gate. Cover source, config, data and docs-to-config transitions and preserve the existing nonblocked docs-only exemption. This changes explicit input acceptance, not the selection default or exemption policy.
- [A3] Executable — `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs`, test `4734 newer request survives settlement interleaving`: suspend settlement after its ownership read, attempt the real shared request writer, finish settlement and release the lock; assert the later request is the final record. Also commit the newer request first and assert stale settlement makes no write. Use equal SHA/suites/tree with distinct request identity so SHA-only checks cannot pass.
- [A4] Executable — `we:scripts/__tests__/verify-lane.test.mjs`, test `4734 stale child cannot finish or refuse over newer same-SHA request`: exercise start, refusal and terminal-completion paths using persisted legacy and runId markers; assert a newer request's bytes survive and the stale child does not report a successful write. The test must use production writer entry points, not a copied ownership predicate.
- [A5] Executable — `we:scripts/lib/__tests__/verify-marker-write.test.mjs`, test `4734 transaction fails closed and releases ownership`: inject contention through the full wait bound, unreadable/corrupt/missing conditional evidence, write/rename failure and callback exceptions. Assert no unlocked write or success, visible error/fallback, unchanged existing bytes and released ownership/temp cleanup. The missing shared module makes this red before implementation. Include successful serialized writes and relocated git-directory aliases.
- [A6] Executable — `we:scripts/lib/__tests__/verify-lane-gate.test.mjs`, test `4734 historical acceptance states blocked local fallback`: a narrowly scoped documentation regression reads the corrected Done when section in `we:backlog/3372-verify-lane-runs-the-full-suite-instead-of-the-diff-driven-s.md`, requires an explicit supersession pointer, and pairs it with a sensitive-diff resolver assertion of blocked/no command. The current historical acceptance fails that assertion. This pins this known drift only; the general semantic review remains the human lens.

## Test plan

Implement the named regressions before the fixes. Commands below are specified from the WE checkout; to keep every path repository-qualified here, define C(file) as `node` running `we:scripts/readiness/heavy-admission.mjs` with arguments `run -- npx vitest run` followed by the file's repository-relative path (strip only its leading `we:`).

Run C(`we:scripts/lib/__tests__/verify-lane-gate.test.mjs`) for A1/A6; C(`we:scripts/__tests__/verify-lane.test.mjs`) for A2/A4; C(`we:scripts/conveyor/__tests__/verify-dispatch.test.mjs`) for A3; C(`we:scripts/lib/__tests__/verify-marker-write.test.mjs`) for A5. Existing tests in those files cover the retained behavior. Never invoke the full suite. Use temporary repositories under the task temporary directory, injected IO barriers and fake clocks; concurrency proof must not depend on timed sleeps. A blocked queue gets one bounded queue wait, then a reported stop.

## Proof plan

Record red-before and green-after output for A1–A6, plus the exact claim-to-assertion mapping. For A3 record ordering of ownership read, competing request attempt, settlement commit, lock release and request commit; assert final bytes. Mutation-check that removing token rejection, transaction exclusion or conditional identity validation makes the corresponding test fail. Inspect both production callers for any raw marker write bypass and verify the scoped historical wording against the resolver assertions. The runner performs the queued standards check and independent parked review; this preparation neither stamps nor claims those checks passed.

## Follow-ups

Structured argv execution could replace the restricted explicit string grammar in a separate change, with compatibility tests for quoted/space-containing paths. Broad property-based shell-equivalence generation is unnecessary for this MVP because shell metacharacters are rejected outright. General prose correctness remains a review obligation under `we:docs/agent/delivery-loop.md`; A6 only pins the specific historical claim. No dependency-edge change is proposed.
