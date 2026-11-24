## GitHub App daemon fallback probes

Daemon auth uses a 30-minute refresh lookahead (interactive callers keep 10 minutes).
Keep the legacy App cache fresh while it remains the last role fallback; its best-effort
refresh must not change the selected role, applied token provenance, or recorded outcome.
The standalone gh shim recognizes `WE_GH_DAEMON_CALLER` and launchd labels under
`com.we.` / `com.plateau.`. A daemon cache miss gets one synchronous refresh CLI attempt
(90-second timeout), then refuses personal auth by default, including after an App 401.
`gh-app-shim.test.mjs` names this boundary in `bounds on-demand refresh and refuses
after timeout`: intercept the refresh spawn, assert `timeout: 90000`, return
`ETIMEDOUT`, and assert refusal with zero real-gh invocations. No wall-clock wait is needed.
`github-app-auth-env.test.mjs` checks `refreshes legacy after the role applies,
without replacing role outcome` for successful and failed legacy refreshes with minted
and cached role tokens, including
caller/shared status writes and the selected role token's source, installation and SHA-256 hash.
Install the daemon refusal shim before reading keys/caches or refreshing tokens, including
when no App is configured. If installation fails, stop before the daemon tick runs.
The pass daemon and await-verify loop must propagate `GithubAppAuthGuardError` even
though they tolerate transient refresh failures. Replay first-refresh and later-refresh
installation failures with `daemon-gh-guard-refusal` in the daemon soak registry.
Only an inherited `GH_TOKEN` with matching `WE_GH_AUTH_TOKEN_HASH` is trusted as App auth
for github.com. Host flags, repository/URL arguments, `GH_HOST`, `GH_REPO`, and git
remotes or implicit gh configuration naming other hosts refuse by default, even with a fresh public-host App cache;
enterprise credentials and stored logins have no validated provenance here. Conflicting
host hints are handled conservatively. Explicit personal-fallback allows still apply.
Positional repository targets use the same host parser as `-R`, including single-label
`enterprise/owner/repo` and `git@enterprise:owner/repo`; relative REST paths remain public.
Check repository selectors in short-option bundles too (`-cRhost/owner/repo`), and
source repositories in create templates and sync sources. Known content options consume
their attached values; clone destinations and asset paths remain local arguments.
Built-in aliases (including `repo new`) use canonical argument rules. Cover clone `-u`
and repository branch/source option values before classifying positional targets. An
enterprise selector after a boolean bundle must still reach the host parser;
keep the command's boolean shorthands aligned with the supported CLI options.
URL text in bodies, titles, and API fields is content rather than a target host.
Unknown aliases, extension execution, and ambiguous URL-valued options refuse by default;
their command expansion cannot prove which credential gh will select. Short flag arity
must be resolved per command (for example checkout `-q` is boolean, API `-q` consumes jq).
`ghAuth.personalFallback` resolves default → platform → tool →
`WE_GH_AUTH_PERSONAL_FALLBACK`; refusals and explicit allows name the effective source.
The shim file is shared by every caller of a checkout, so it carries only the file policy;
the shim reads `WE_GH_AUTH_PERSONAL_FALLBACK` from each caller at run time. A daemon's shim
directory must be the first `PATH` entry, even when an inherited `PATH` lists it later.
Interactive shells retain their inherited-auth behavior. Dispatched shim settings carry
the daemon marker even for XPC-only parents and when session spawning does not inherit
the parent environment.
Daemon settings construction must throw on a missing binary or failed shim write;
returning no settings would leave the dispatched session outside the refusal boundary.

Exercise these paths with synthetic cache entries, fake gh/refresh executables, isolated
homes and ledgers, and injected minters. Cover `chalbert/web-everything` via `-R`, REST
paths, and a real temporary clone's SSH origin: each selects the worker installation for
canonical owner `web-everything`. Run the touched `gh-app-shim`, `github-app-auth-env`,
`github-app-per-owner-routing`, and `github-auth-policy` suites through heavy admission.

Drain CLI fixtures with fake `gh` binaries use `scripts/__tests__/fixtures/daemon-app-env.mjs`
to seed fresh synthetic App caches under their disposable home. Keep personal fallback refused:
the real guard and per-owner routing must still run before listing, freeze, or merge assertions.
Each fixture invocation also needs a fresh throttle ledger, even when it reuses a home:
fake merges consume the real per-minute write budget and can make later scenarios wait.
The synthetic CLI fixture gives fake writes a larger budget: a three-repo drain provisions
42 labels before merging, exceeding the production budget of 40. Keep accounting and the
auth guard enabled. App-enabled soak worlds must use numeric installation IDs in their
owner map and rotate both the legacy and per-installation caches together; otherwise the
guard cannot route the refreshed token and an expiry probe becomes an unrelated auth refusal.
On an App-token rejection, keep gh's original stderr before the daemon refusal diagnostic,
so callers that read the first error line still report GitHub's actual cause.
The simulator binds its synthetic `sim-token-1` to matching App-token provenance; its fake
GitHub still owns revocation checks. Never enable personal fallback globally in test setup.

### Adoption evidence and compact terminal output

The adoption matrix is read-only evidence and fails closed. Logged revisions must be full object IDs; probes
use a sanitized Git environment (no inherited `GIT_DIR`-style variables, `GIT_NO_LAZY_FETCH`,
`GIT_NO_REPLACE_OBJECTS`, no prompts), run only at a verified repository root, and treat a shallow or unreadable history as
unknown, never as a definitive "no". Corrupt log lines, bad timestamps or refs, unreadable logs or settings, and gaps in
clone discovery mark the snapshot incomplete. Reads are bounded (1 MiB log tail, 50 refs, 20 clones, 500 Git calls) and
omissions are reported as truncation. Clone paths must be absolute. The drain target is the code clone from the
prototype-load settings, not the plist's data clone; tests inject those settings. Matrix and PR table cells strip
Cc/Cf controls and are width-capped; table mode keeps the truncated-listing warning.


Recovery retries must spend their allowance in the head-bound red-team status before the model call.
Keep `retryCount` when writing running/finished statuses: a failed scorecard append is not evidence
that no model ran. Exercise both review-job admission and the shared runner with an append failure,
then verify that a later planner and admission pass refuse another call even after cooldown.
Cross spent counts (1 and greater), bare/object `ran` and `resumed` results, and zero/one/multiple
seat rows in planner and shared-runner regressions. An empty store must never restore a spent retry;
the shared `redTeamStatusWithoutRun` predicate must reject it before placeholder classification.

Policy-clear carry must bind the source acceptance and policy-clear SHA to the trusted re-stamp's
declared `from`, with its `to` equal to the live head. Reuse numbering-carry's `restampRecord` parser.
Keep a three-head regression: acceptance A, acceptance B, clear B, re-stamp A-to-C must not publish
or sync labels; changing only the declared source to B permits carry. Missing or malformed provenance
must also refuse carry. Never infer the declared source from comment order alone.

Retry admission uses an exclusive-create `<status-basename>.retry-1` marker before the model call.
An existing marker refuses with `retry already admitted`; never roll back another worker's status
or remove the marker on failure. Inspect the head-bound evidence before operator recovery.
Interleave two admissions after both read the old status and assert exactly one model call.

### Red-team disposition precedence

`red-team-disposition.test.mjs` pins all ranked pairs in both temporal and input
orders, alongside shared-reader regressions for carry, repost, per-key blocks and
legacy holds. Keep the oracle independent of `DISPOSITION_PRECEDENCE`.
The pure resolver consumes validated live rulings; the thread adapter owns trust,
head/result binding, carry eligibility and ceremony validity. Compatibility notes
beside the table are deliberate: later indexed gate holds retire older releases,
unindexed legacy holds do not. Operator blocks outrank clear-human regardless of
recency; recency breaks ties only within a rank. Clear-human clears only keys
the block does not name. A `NOT sent back` line is an ordinary hold even
inside an operator-block record. Preserve these fixtures when changing liveness;
rank alone cannot describe the historical wire protocol.

