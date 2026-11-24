## False-finding coroner pass

`coroner-false-findings.mjs` reads PRs updated in the window (including older and closed PRs),
complete comment threads through the shared reader, and the shadow agreement store. It never advances
`WE_CORONER_STATE`; run it before the main extractor when using `--since=last`.
`coroner-extract` also includes it as `errorRates.falseFindings`, feeding daily `perf-snapshot` counts.
`WE_CORONER_NO_FALSE_FINDINGS=1` skips that census in the main extractor.

Confirm or override each rule guess using the ruling reason, the red-team Re-check, and a bounded
live-head probe when needed. Recorded `--cause` on `record-referral-ruling --ruling=not-real` takes
precedence; the writer also preserves the finding lens. Allowed causes are `diff-only-recheck`,
`stale-head-reraise`, `auto-policy-over-not-real`, `card-only-probe`, `config-prose`, `test-nit`, and `other`.
A repeated not-real on another head is a stale hint, not proof the newer finding is false for the same reason.
Report code and card-only separately and keep unknown PR types visible when file reads fail.

Counts describe source events, not unique defects: a fixer stand-down can overlap a ruling.
Unmatched agy findings are separately **unconfirmed**, never proven false by non-agreement alone.
Capped PR discovery and failed reads are explicit; do not present such a census as exhaustive or infer
false-findings / total-findings percentages without a matching denominator.
For each confirmed cause, name a prevention, rank by frequency and mark NEW or COVERED-BY using the
coroner's existing held-card checks. Daily summaries carry cause/lens/seat/PR-type counts plus the
separate shadow count and read completeness.

### Build completion safeguards

Builder, fixer and Codex briefs quote `reviewer-expectations.md` inside a data fence (it is derived
from untrusted PR and CI text). The coroner proposes its concrete examples from recurring findings by PR. `scripts/settings/build.json` overrides the platform's `build` block:
`finalGate` defaults to `full` (whole unit tier plus standards through heavy admission), with `related`
and `none` escape settings. `finalGateStandards` defaults to `always`: non-full gates keep related-test
selection but run standards on every diff, including code-only and card-only changes (scoped where safe),
and disable the local card-only skip, including since-last-green selection. Set it to `selected` to retain
`verify-settings.json` standards selection and card-only skipping. `full` is unchanged by this setting.
`node scripts/verify-lane.mjs --dry-run` prints the default command, reasons and standards decision without
running a gate or writing markers. `selfReview.enabled` defaults true and `selfReview.maxRounds` defaults 2
(0–10). `reviewerExpectations.enabled` defaults true. Sources use the shared policy-cascade formatter.
Environment overrides are `WE_BUILD_FINAL_GATE`, `WE_BUILD_FINAL_GATE_STANDARDS`, `WE_BUILD_SELF_REVIEW_ENABLED`,
`WE_BUILD_SELF_REVIEW_MAX_ROUNDS`, and `WE_BUILD_REVIEWER_EXPECTATIONS_ENABLED`.

The verify cache checks both the requested command (`suites`) and the executed command (`executedGate`).
A child's standards policy can change the execution plan while keeping the requester's stamp. An earlier
green cannot replace that changed plan; legacy markers without `executedGate` require one fresh run.

A green build gets one cheap correctness/security review of its net diff. Each repair resumes the
original builder and re-runs the gate; at most `maxRounds` repairs occur, with a final observation
and remaining notes carried into the PR body. The cheap self-check opens to independent review,
never directly to acceptance. An unavailable review or red repair gate stops publication; neither is a clear verdict. Disabling self-review keeps the existing
conveyor converge path; Codex skips the extra review. `finalGate=none` keeps Codex ungated and
leaves conveyor's existing verification selection in place; `related` requests diff selection.
Codex `--ephemeral` requires self-review disabled, since an ephemeral builder cannot be resumed.
The self-review adapter accepts at most 512 KiB of UTF-8 diff text. An oversized diff skips the
cheap review and repairs, then opens with an explicit incomplete-review note requiring human
review of the full diff. It is never reported as clear. Unknown input and failed reviewers still
stop publication. `build-safeguards.test.mjs` covers oversized ASCII and multibyte diffs, the exact
byte boundary, and **rejects nonzero reviewer exit with clear findings** / **rejects timed-out
reviewer with clear findings**. The unit gate includes these deterministic adapter tests.
Codex repairs reuse the fresh run's routed model, effort, sandbox, cwd, writable roots, network and
temporary-directory configuration. JSONL logs append across repairs; completion reports include
all turns and the latest final message. **uses full by default and resumes the original builder
within the cap** defends the production wiring, and **builds fresh and resumed argv with identical
routed configuration and directory grants** pins configuration parity.

The delivery wrapper's publication guarantees are defended where it publishes: **opens no PR and
settles a failure when the self-review is unavailable** / **…when the repair gate is red**. A diff
that overflows the bounded read gets the same incomplete-review note as an oversized one (**publishes
the incomplete note when the net diff overflows the bounded read, and reads it hardened**). The
builder can write its lane's git config, so every self-review diff read uses the shared lane pins
(`lane-git-hardening.mjs`) with external diff drivers and textconv off (**never runs a
builder-planted external diff, textconv or fsmonitor command**). A clean filter cannot be switched
off, so Codex's worktree read refuses a checkout that defines one (**refuses a checkout that defines
a filter driver before any worktree read runs it**). The reviewer verdict may be bare or in exactly
one fenced block, with prose around either; anything else is invalid, including a second `findings`
object outside the chosen fence (**rejects mixed fenced and unfenced verdicts** and its variants).
Notes reach the PR body as a
code block, with `<`, `>`, `@`, `#`, `GH-` and `://` swapped for look-alikes: no links, images,
issue references, mentions or machine markers. A blank or malformed `WE_BUILD_*` value is unset and
never turns a safeguard off (**%s=%j keeps the standard default**). With default settings a
Claude-executed delivery self-reviews once instead of running converge and parks `review:pending`
(**with default build settings, a Claude-executed delivery self-reviews once, skips converge and parks
review:pending**). That park replaces only the label-on-green fallthrough: a label the escalation score
asks for still wins (**with self-review on, %s parks at least as strictly as without it**), and an
incomplete self-review parks `review:human`. Codex repair-turn failures and a red repair gate reject the
build (**a real codexDirectTask rejects when %s**). A review run never self-reviews, resumes or gates itself (**a review run never
self-reviews, resumes or gates itself**).

`finalGate` changes the default of every `verify-lane.mjs` mode, including `request` and the
dispatched verify child, so a lane's marker means the same gate however it was requested. Only
`full` replaces the default selection; an explicit `--gate` always wins (**finalGate=%s runs the
whole unit tier only when full**). The full gate is still the default gate: its clean green feeds the
green ledger and the marker keeps the diff's changed files (**a default verify under finalGate=full
records the green ledger and the changed files**). Codex resolves its gate from the same policy
(**a real codexDirectTask with WE_BUILD_FINAL_GATE %s runs the policy gate**); `full` and `related`
need `scripts/verify-lane.mjs`, so a sibling-repo `--dir` without it gets the named failed outcome
`gate-unavailable` (**%s gate in a checkout without verify-lane is a named unavailable failure**),
refused before any Codex spend (**refuses --gate=%s in a checkout without verify-lane before any Codex
spend**), and must pass `--gate=standards` or `--gate=none`; a plateau-app worker brief does that
itself. A dispatched verify child also recognizes a default gate the requester stamped under the
other `finalGate` (**a child under finalGate=%2$s recognizes a default gate stamped under %1$s**). Briefs that append the checklist (fix, ci-heal, the dispatch
tick, the delivery v2 brief and its resume prompts, Codex) do it through `appendBuildRequirements`,
which appends it once and never to a brief that already has it (**brief composers carry the
checklist exactly once**); `worker-brief.mjs` places it inside its own template. Codex callers opt out of self-review with
`--no-self-review` (or `selfReview: false`). With `--json`, a completed run exits 0 and the report
carries its result, so machine callers keep their contract; text mode exits 1 on a failed run or red
gate.

### Review seat timing

Review-pr run records retain `seatTimings` per attempt: seat, lens, provider, model,
ISO `startedAt`/`finishedAt`, verdict and findingsCount. Parallel seats persist at launch
and settlement, before declared-order reduction; retries retain separate start instants.
Extra-seat groups share their model call's instants. The speculative red team retains its
model call times through finish/discard, excluding sink wait and the subsequent re-check.
A cancelled call has no observed finish. `node scripts/operations/review-seat-timing.mjs`
reads the existing runs folder without migration or writes; `OPERATION_RUNS_DIR` overrides
it. `--since=<iso>` selects runs by earliest seat start. Incomplete runs are shown but
excluded from median, nearest-rank p90 and the >5-minute early-change share denominator.
Legacy runs without seat observations are omitted; absent times are never reconstructed.

### Scope-only prepare re-validation

The builder may send an individually dispatched `prepare-stale` card through a light
re-validation before full preparation, only when the hold says scope changed (age
holds still require full preparation). `prepare.lightRevalidate` defaults to true;
`prepare.lightRevalidateMaxDiffLines` defaults to 400. Both use the prepare policy
cascade and source logger, with `WE_PREPARE_LIGHT_REVALIDATE` and
`WE_PREPARE_LIGHT_REVALIDATE_MAX_DIFF_LINES` environment overrides.

The prepare runner supplies the existing card sections and the scope diff from
`preparedAgainstSha` to the pinned main base to Codex sol at low effort. The worker
must return JSON `{ "verdict": "still-valid" | "needs-reprepare", "reason": "one line" }`
and leave the checkout unchanged. Only `still-valid` allows the runner to append
`revalidated: <reason>` and refresh the sanctioned stamp. Missing evidence, invalid
answers, disabled policy, and diffs above the cap use full preparation. A worker
that changes files, HEAD, or hooks is refused. The worker runs in Codex's `--review`
read-only sandbox with no network; that sandbox is the guard for edits deep inside
collapsed ignored directories such as node_modules. As a second check, a fingerprint of
the gitignored entries git lists (content for files up to 1 MiB, mode/size/mtime for
collapsed directories, so only adding or removing a direct child shows there) is
compared after the run. A change escalates for a human because a discard does not
restore ignored files.
Re-stamps use the existing verified
card-only prepare PR lane; the builder waits for the stamp to land on main before
building. Light candidates are excluded from grouped prepares so each verdict
covers exactly the card and diff inspected. No direct write to main is permitted.

Regression coverage must pair dispatch eligibility with age-stale and policy-disabled
false cases, and exercise light candidates in both group-lead and group-member positions.
Drive each read-only refusal guard independently (card text, HEAD, hooks, ignored files, and numstat),
asserting discard and no stamp, commit, or PR. A failed stamp after `still-valid` must
retry full preparation with the original dispatched provider, model, and effort; the
result's scorecard and PR attribution follow whichever worker completed preparation.
The light worker bypasses the router, so it applies the router's admission itself: a
critical miss on its exact provider/model/prepare triple, an active provider quota hold,
or an unreadable trial history skips it for full preparation by the dispatched worker.
Prompt evidence uses the shared `fenceUntrusted` helper and `FENCED_DATA_RULE`; test
closing-tag injection in both the card and diff, including mixed case and whitespace.

