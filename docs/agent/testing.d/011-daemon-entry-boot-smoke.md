## Daemon entry boot smoke

Rebuild candidates must also work with the old live daemon's smoke environment: it exports
`WE_SMOKE_LIVE_CLONE` and `LANE_POOL_ROOT`, but may omit `LANE_POOL_CANONICAL_ORIGIN`.
The canonical-origin CLI fixture covers the named candidate's verified Git owner under a fake pool;
forged markers, lane owners and unreadable ownership must retain the explicit-origin refusal.
The candidate-env fixture also checks that configured local origins are anchored to the live root before
export, so changing to the candidate directory preserves the destination; explicit env values keep precedence.
The inherited origin applies only without `--reference`, `--repo` or `--pool`; those selectors resolve
their own primary. The CLI fixture exercises recovery against separate local bare repositories and
checks that cross-pool release never publishes another pool's work to the inherited origin, including
when that pool's primary is missing or has no origin.

Boot each entry in a fresh child to preserve cold import graphs. `rebuildSmoke.bootConcurrency`
(default 3) bounds initial boots; after those children drain, `rebuildSmoke.bootSignalRetries`
(default 1; zero disables) retries only SIGTRAP/SIGSEGV/SIGABRT/SIGBUS/SIGILL deaths, serially.
Exit failures and `ok:false` never receive this retry. Both settings use the policy cascade via
`scripts/settings/rebuild-smoke.json`, with env overrides `WE_SMOKE_BOOT_CONCURRENCY` and
`WE_SMOKE_BOOT_SIGNAL_RETRIES`; log effective values and sources. Env integers are strict
digits; empty is unset. `rebuildSmoke.bootMinChildMs` (default 10000; env
`WE_SMOKE_BOOT_MIN_CHILD_MS`) uses the same cascade and source log. Each boot asks for a
per-call floor of `min(daemonBootMs, bootMinChildMs)`; less shared rebuild budget means the
existing budget refusal, never a doomed short child. Live smoke tracks that same floor when
marking budget interruptions. Only an all-timeout boot failure set at the full requested caps
counts as env-timeout (caps at least `MIN_OWN_CAP_MS`, each attempt's measured `elapsedMs`
at least `min(minElapsedMs, cap * 0.9)`; aggregate row time cannot substitute for entry timing).
An import failure already reported on child stdout remains `import failed` even when a pending
timer keeps the child alive until a timeout kills it.
Mixed import failures, crashes, budget slices and missing entry evidence remain code failures.

Smoke diagnostics never carry raw child stderr or stdout (operator decision, PR 5460). A boot or
dispatch smoke failure detail, held state, self-sync alert and PR comment carry only an
allow-listed summary (`daemon-boot-smoke.mjs#pickSmokeDiagnostics`): entry name, signal, exit
code, attempts, launch start time, session/transcript presence, and an error class. The class is
the first line matching `^[A-Z][A-Za-z]*Error:` that is not inside a quote opened on an earlier
line, cut to 80 chars, with its quoted text (ASCII, typographic, guillemet and fullwidth) replaced
by `<…>`: one cleanly bounded string in place, any other shape (several quotes, an unterminated
or glued-on one) from the first quote to the end, because V8's JSON parse messages copy input
with unescaped quotes. Control/format characters are dropped and token shapes redacted; a bare
`Error:` line has none, and unparsable child output gets a fixed class. The raw output's last 30 lines go only to a new owner-only (0600) file under
`<daemon state dir>/smoke-diagnostics` (0700, newest 500 kept), and the summary names its path.
Culprit attribution reads typed repo-relative `files` the boot check extracts from the raw text
in-process (`sourceFilesIn`), never the text itself.
A transcript denial is counted, never quoted. Test with sentinel words that are not
secret-shaped, so only the design can keep them out of every sink.
Cover retry recovery, exhausted retries, non-signal refusal and concurrency with injected children;
exercise diagnostic propagation through a real-git rebuild fixture. Run these suites through heavy admission.

