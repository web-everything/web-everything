# Operator controls

The operator decision of 2026-10-13 provides manual intervention without a worker.
Start with `node scripts/operations/run.mjs why --pr=N` or `--item=X`, then
preview the suggested control before applying it. Every control is mutating;
`--preview` reads and prints its complete plan with zero mutation effects.

| Op | What it does | Wraps | Undo |
| --- | --- | --- | --- |
| `unpark --item=X` | Clears a builder hold and failure/backoff record; refuses prepare holds | `releaseBuildDispatchHold`, `clearBuildFailure` | Daemon re-parks on next failure; re-hold now with `placeBuildDispatchHold` |
| `unpark --pr=N` | Clears `review:human` subject to the existing ceremony refusals | `review-set-label.mjs --to=clear-human` | Restore human hold through review ceremony |
| `retry-prepare --item=X` | Sets held uncompleted prepare failures to `held:false,retry:true`, releases only prepare holds | Prepare ledger atomic save path; `releaseOwnPrepareHolds` / `releaseBuildDispatchHold` | Daemon re-holds on next failure; restore prepare hold with `placeBuildDispatchHold` |
| `rearm --pr=N` | Requests independent review, preserving human hold | `decideRearm`, `rearm-review.mjs` | Request changes again through review ceremony |
| `refresh --pr=N` | Refreshes onto main once with content-preserving plumbing; records new head for drain | `refreshOntoMain`, `recordRefreshed` | Reviewed git repair to restore previous head |
| `grant-rounds --pr=N --kind=fix\|review --n=1` | Adds audited rounds; **today every grant raises every cap**, because reconcile-core adds the count to all caps | `planRoundExtension`, `github.round-extension` sink | Append-only; no supported revocation |
| `clear-claim --pr=N --kind=fix\|ci-heal` or `--file=path` | Releases stale fix claims; refuses live/unknown sessions; file scope is derived from claims | `readFixDispatchClaim` / `listFixDispatchClaims`, `isClaimSessionLive`, `releaseFixDispatchClaim` | Next eligible tick reacquires; never resurrect the stale owner |

Shared flags: `--repo=owner/repo` defaults to `web-everything/web-everything`;
`--actor`, `--channel`, `--reason` are required. Actor must be a registered
operator login; channel must be nonblank and one line; reason is kept verbatim.
`--preview` defaults to false. Exactly one target is accepted for each control.
Item controls currently support only `web-everything/web-everything`; other repositories
are rejected before reading coordination state or applying a mutation.
`refresh --checkout=path` defaults to the script's repo root. `kind` defaults
to `fix` and `n` to 1. Granting rounds requires the operator's own GitHub credential.
Unpark does not bypass the clearance ceremony's evidence/independence refusals.

Each applied control verifies the mutation before recording an `operator-action`.
PR actions post a comment containing actor, channel, quoted reason, undo and the
JSON marker `<!-- operator-action: {...} -->`. Item actions append a JSON line to
`<coordination root>/operator-actions.jsonl`. Keys include the pre-state, so a
recorded action is not repeated on the same state. Sinks re-read and refuse stale
plans. A mutation whose verification or record fails requires inspection before
retrying; the record is evidence of verified completion, not a transaction journal.

Refresh compares the PR head with main's live GitHub SHA. Preview reads local git
objects without fetching; a missing main object conservatively plans a refresh.
Apply fetches main when that object is missing. If the PR head is not available in
`--checkout`, the ancestry probe refuses rather than guessing.
A prepare retry changes dispatch eligibility once; it does not promise success.
