## Orphan guard settlement

Settlement suppresses only budget holds, never live checks. In each bounded pass, uncached PRs
(including wrapped cursor entries) precede fresh same-head cached PRs; cached PRs run oldest
`at` first with the remaining budget. Visiting a stable-none PR refreshes `at`. A non-stable
plan or unreadable thread deletes its entry and follows the normal action/error path.
Comments alone can introduce an orphan or operator ruling without changing the head.

Keep the cache process-local, with a six-hour TTL, and invalidate on ordinary fix dispatch or
non-none guard results. Expired entries and unknown heads count as uncached. Cache only
explicitly stable none decisions; grace, ownership, draft and real orphan decisions never settle.

Budget-deferred cached PRs appear only in `deferredSettled`: they do not enter the cursor or
hold ordinary fix dispatch. Uncached deferrals remain in `deferred`, retain their cursor and
hold dispatch. Repeated bounded passes must drain uncached holds to zero. A visited cached
PR still produces normal escalation or fail-closed error evidence, which the daemon handles.

The orphan-guard-settles soak break probes bounded hold drainage, cached live reads and age
refresh, unreadable threads, and a later same-head evidence-less orphan reaching escalation.
Its negative fixture removes cache support while preserving cursor and budget behavior.
Unit tests pin uncached-first/oldest-cache ordering and distinct deferral lists. Daemon tests
exercise the production tick result with empty rows and nonzero `newlySettled`/`deferredSettled`
counts through the logger; action rows are not the source of settlement metrics.
