## Red-team re-check evidence

Recovery distinguishes a policy-clear from a completed seat and a failed execution. A trusted
acceptance re-stamp at the live head can carry only the policy-clear of its preceding trusted
acceptance record. A newer result on another revision, including one posted after the live-head
re-stamp, or missing/untrusted source acceptance
refuses carry; recovery never searches older revisions for a convenient clear.
Stored-review recovery passes explicit `storedReviewPolicyClear` authority only after its acceptance/hold guards; ordinary job settlement still refuses contradictory `not-owed` results. The stored-context tests in `red-team-skip-outcome.test.mjs` require acceptance, a bound read and no guard/cap deferral.
Both carry and stored clear pass formal reviews into `latestAcceptRecord`; unreadable reviews
refuse publication and require operator inspection. A standing formal CHANGES_REQUESTED blocks both.
Stored clear (null status or finished/not-owed) requires a trusted acceptance record whose SHA is
the live head, alongside the matching stored read, no seats, and no deferral. An accepted label
alone cannot establish that boundary; keep real accept comments in R100 clear-success fixtures.
One non-completed seat with finished/ran permits one fresh retry under the daemon cooldown;
two failed seats retain the refusal and require operator inspection. Completed seats retain
result/effects-only resume. Preserve the failed status through queued admission so the shared
seat guard can independently recheck the same bound. The R100 regressions in
`review-red-team-on-skip`, `drain-red-team-evidence`, and `review-job-red-team-only` cover these paths.

The post-accept re-check reads a separate, self-contained checkout pinned to `read.netBasis.rev`,
never the released review lane's current HEAD or the red-team probe's working tree. Its Claude
juror uses `judge-spawn.mjs` with `Read`, `Glob`, and `Grep` only, in an independent lane-shaped
scratch directory; cleanup runs after success or failure. A configured provider unable to honor
that tool allow-list fails the re-check rather than silently dropping repository access.
`review-red-team.test.mjs` pins this with **rejects incompatible providers when repository reads
are enabled**, parameterized over Codex and Antigravity, with a tool-free twin and zero spawns
on refusal.
The mandate requires reading cited files and callers and reporting repo-relative `filesRead`
per claim. A negative answer with no files read, missing answer, unavailable context, or failed
re-check is `unverifiable`, not `not confirmed`. That outcome and the files read survive evidence
storage and comment retries; only confirmed findings count as misses.
Model-reported paths pass the same secret scrub and strict ASCII path policy before evidence
storage and comment rendering, including legacy retries. Unsafe entries are discarded whole;
the policy checks at most 100 entries of at most 600 characters each, deduplicating valid paths.
While the pinned clone exists, paths must resolve to regular files inside it; missing files,
Git metadata, and symlinks escaping the clone are discarded. This validates reported evidence;
it does not prove a tool actually read the file or confine the tool's filesystem access.
Re-check reasons use a fixed vocabulary (`demonstrated break`, `relevant code refutes claim`,
`insufficient evidence`); unknown text becomes `reason withheld`. Enforce this in the answer
schema, parser, and publication paths, including completion of saved speculative passes and
legacy comment retries. Pattern-based secret scrubbing cannot safely publish arbitrary text
from a juror with filesystem access. Regression coverage: **withholds unrecognized re-check
reasons at every publication sink**. Filesystem read confinement remains separate work.
Provider failure text can contain raw juror output too: re-check statuses use fixed values
(`ok`, `pending`, `not-needed`, `error`), including saved-pass completion and legacy retries.
Regression coverage: **withholds raw juror errors and legacy re-check statuses from stored and
public evidence**.
Regression coverage: **scrubs unsafe filesRead at the comment and evidence sinks**,
**scrubs filesRead when completing speculative evidence and retrying legacy rows**, and
**the production re-check uses an independent pinned lane and cleans it**.
For evidence leak assertions, inspect nested string values directly: JSON property names can
match unsafe inputs such as `"file"`, while serialization can hide control characters by escaping them.

`redTeam.recheckReadsRepo` and `redTeam.skipCardOnly` default to true. The cascade is standard
→ platform (`delivery-platform-preferences.json`'s `redTeam` block) → tool
(`scripts/settings/red-team.json`'s `redTeam` block) → environment
(`WE_RED_TEAM_RECHECK_READS_REPO`, `WE_RED_TEAM_SKIP_CARD_ONLY`; true/false, on/off, 1/0).
Effective values and sources are logged before probes. Card-only detection reuses
`ci-card-only.mjs#isCardOnlyDiff` on the net changed-file list plus `netRenameSources` (both
rename and copy sources); unknown/empty destination lists or malformed source lists do not skip.
Moves into or out of `backlog/` probe whenever either side is code; card-to-card moves still skip.
Regression coverage: **includes rename sources before deciding to skip probes**, covering both
sequential and speculative paths. The speculative fingerprint also includes rename sources.
Replay derives rename/copy sources from diff headers using the review reader's existing parser;
**replay retains rename/copy sources so code moved into backlog still probes** pins that wiring.
The sequential and speculative paths skip before budget reservation and record the reason
`red team skipped: card-only`. Setting `recheckReadsRepo=false` restores a tool-free re-check;
negative answers without file reads remain unverifiable.

Red-team cap deferrals retain the reservation provider's daily-cap reason when the operator's
routing chain is exhausted; a roster provider outside that chain is never a fallback. Explicit
operator cap env values survive launcher settings overlays that omit caps (or contain invalid caps)
and the speculative spawn. A valid settings cap takes precedence, including lowering to zero;
an own provider cap still takes precedence over the legacy Codex fallback. The
reservation union includes today's scorecards and outstanding ledger IDs, so a scorecard-only
availability snapshot can still lose the reservation race. Regressions live in
`review-extra-seats.test.mjs`, `review-job.test.mjs`, and the behavior-probed
`red-team-reservation-route-exhaustion` soak break.
Named coverage: **launch cap precedence matrix** crosses valid, invalid and absent parent/overlay
values for each cap key; **settings overlay can lower a cap to zero through both the job and
speculative launch** pins the wiring. **default settings resolver forwards the passed** and
**default settings resolver refuses failed shim setup** exercise dispatch without replacing its
resolver, including both daemon markers. **logs each resolved provider cap and its source** covers
explicit caps, defaults, legacy caps and routing controls; **retains codex daily-cap denial** also
asserts the deferral log. **counts the union of scorecards and outstanding reservation IDs**
asserts overlap deduplication and denial at the combined cap for every provider;
**defers red team when the scorecard and outstanding ledger union exhausts codex capacity**
reaches that accounting through speculative routing without a reservation stub.

