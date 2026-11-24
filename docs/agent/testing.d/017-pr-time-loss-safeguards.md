## PR time-loss safeguards

R125: `measureNonTestLines` excludes pure data from the 300-line budget and reports it separately as
`dataLines`; those files still require review. Built-in data extensions are `.json`, `.yaml`, `.yml`,
and `.csv`, under a `config/` or `data/` directory segment at any depth. Exact `dataPaths` add exceptions
only for those four extensions; `dataExtensions` may select only within that set. Code and markdown
cannot become data exemptions. Absolute paths and paths with empty, `.` or `..` segments always count.
The shared producer admission resolves `prSize` through the shared policy cascade and `scripts/pr-size-settings.json`;
JSON-array env overrides are `WE_PR_SIZE_DATA_EXTENSIONS`, `WE_PR_SIZE_DATA_DIRS`, and `WE_PR_SIZE_DATA_PATHS`.
Invalid present settings at any layer make size unknown, file a split card conservatively and request
extra reviewers without refusing PR creation; only an absent tool settings file uses lower layers and
built-in defaults. Restore valid settings before retrying measurement.
The counter defaults to dependency-free frozen built-ins to preserve the declaration's import safety.
Keep the classification, settings provenance, data accounting, binary/overflow errors, and conservative
rename cases in `scripts/operations/__tests__/open-pr-size-cap.test.mjs`.

`fix.alertAtRoundCap` publishes through the needs-you feed as soon as the notes pass observes exhaustion,
independently of note-comment dedup and quiet-hour desktop delivery. Polling must include `needsPerson`
rows so it does not clear and reopen those events, losing the original idle timestamp.
`fix.resetOnRepeatedFinding` keys full normalised claims by lens and file (not moving line numbers),
requires a trusted completed fix between sightings, and accepts `scope-baseline: <full sha>` only from
an operator comment. Fix-end comments carrying the shared infrastructure-stall marker (including permission
stalls) do not complete a fix. Identity reads full finding text, including multiline continuations, and
binds it to the complete rendered Findings envelope: em dashes and apparent Markdown boundaries inside
summaries must not discard a distinguishing suffix. Source coordinates are ignored only when both the
envelope's total and anchored bullet counts agree with its declared count. Changed scenarios, metadata or companion findings can therefore
conservatively decline a repeat. Keep the coroner's compact display separate from this identity read.
A corrective tree reset preserves published ancestry and replays only whole linear
commits inside the declared scope; unreadable or ambiguous history stands down. Test real Git trees,
untrusted markers, changed lens/text, no intervening fix, and the launcher path for every executor.
A non-main merge fixture must reach history inspection with a valid scope and clean lane, then assert
refusal before `read-tree` or `cherry-pick`, with identical index bytes, HEAD, status and worktree bytes.

`review.carryAcrossIdenticalNetPatch` compares nonempty `git patch-id --stable` outputs for each head's
net diff against its own merge-base with main, then requires equal contribution fingerprints and
byte-identical added/removed lines (including the root manifest). Patch-id alone discards meaningful
whitespace and hunk locations. On an unchanged base, require the full positioned patch, including hunk
headings and context. When bases advance, require identical positioned base-to-base and head-to-head
deltas, ignoring only index blob IDs; unreadable deltas decline the proof. This preserves offset-only
rebases when the upstream edit lands at the same location in both trees, while conservatively declining
overlapping edits. Read raw buffers and refuse lossy UTF-8 decoding before computing equality. Exercise
non-UTF-8 source bytes, indentation, string whitespace, trailing spaces and CRLF through the writers,
as well as a successful offset-only rebase and edits moved between identical functions through both writers.
Changed context can decline this proof without disabling
independent contribution/replay or tree proofs; test those with the setting both on and off.
Human carries bind both Git diffs to the recorded and pinned fingerprints,
then re-read the complete thread and formal reviews through the existing writer. Automated carries use
the same guarded numbering-restamp writer. Keep numbering-only fixtures explicitly on that proof so they
cannot silently reach real Git when the new fallback runs. The tamper-park callback derives numbering-only
mode from missing recorded fingerprints; exercise its production callback with fingerprinted and SHA-only
clearances through the durable writer, including refusals and live holds.
Pass the evidence repository's `cwd` into `proveIdenticalNetPatch` even with a cwd-bound exec wrapper:
the reader supplies a `cwd` option, and an undefined value can otherwise override the wrapper's directory.

Review-held gates belong to review regardless of advisory settings; unrelated failed checks still need
repair. Cancelled test/soak shards, including long-running cancellations, use the existing rerun ledger
once per head before heal. Do not let the stale-CI fallback grant a second rerun after that allowance.
The read-only Actions workflow cannot keep a completed job pending, so its exit-code hold stays intact.

