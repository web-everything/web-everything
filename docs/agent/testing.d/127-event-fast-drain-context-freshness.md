## Event fast-drain context freshness

Local `--only --from-green-event` context may reuse full shared-snapshot rows only through
`cacheOnly: true` (normal TTL/dirty rules, even when stale-ok is configured). A lean live
open inventory owns membership. Its GraphQL pages use the full listing’s query ordering, connection
parser and `assertInventoryComplete` guard; counts must stay stable, unique row count must equal
`totalCount`, and no next page may remain unread. Partial pages, errors, duplicates or count drift
fall back to full listing. Number, head and updatedAt must match before snapshot reuse. Missing
or changed rows and dependency/couple/overlap/card-group components are read fully live.
Unknown inventories or related evidence fall back to the original full listing with one
`fast-drain: context fell back to full listing (...)` diagnostic. The full hydrated listing must
also call `assertInventoryComplete` before hydration or cache reuse; a short fallback throws into
the existing list retry/unreadable path and cannot authorize enqueue. Keep the real CLI regression
where both lean and full pages return one PR against `totalCount: 2`.
Both `WE_FAST_DRAIN_CONTEXT=live`
and `WE_FAST_DRAIN_LISTING=live` restore the original listing. Default-branch hints use a separate
in-process map, round metadata, then a host-wide one-hour atomic cache under
`~/.claude/conveyor/default-branches`. Test processes require an explicit
`WE_DEFAULT_BRANCH_CACHE_DIR`. Neither cache nor parent metadata can authorize merge/enqueue.
Every admission requires a live default-branch read in the child process, with successes retained per repo/process,
after synchronous listing/context pages finish (prestage verifies before enqueue). Failure defers and is evicted
after settlement so later watch passes retry; concurrent callers share each in-flight attempt.
Keep same-reader recovery coverage for synchronous throws, rejected promises and unreadable responses;
the drain verdict must hold after failure and admit after a successful retry.
Live evidence overrides hints and rewrites the cache. Parent round metadata preserves the original
live observation timestamp; a retained branch never receives fresh evidence timestamps. Branch-only
records never count as complete PR listings. Keep branch-change, failure, and read-order probes.
The node:test regression and soak also support the existing Vitest runner; run either through
heavy-admission, with only the affected files.

The shared drain classifier and merge revalidation refuse missing, undefined, null or empty default-branch
evidence; pure callers have the same closed default. Valid-admission fixtures must supply the verified branch
explicitly and include a readable PR base. An unreadable base fails closed globally in this shared authorization
predicate, including full-list fallback; invalid full context rows fall back to full listing before gates.
CLI shims must answer `repo view --json defaultBranchRef --jq .defaultBranchRef.name` separately from
label-memo repository URL reads. The stateful fake reads its configured branch on each invocation and preserves
fault injection for this verb. Prestage cache assertions must use the world fixture's returned `slug`, so the
test reaches the enqueue guard even when its repository identity changes.
