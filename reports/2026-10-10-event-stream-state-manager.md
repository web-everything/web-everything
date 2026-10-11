# One event stream and one state manager: inventory, evidence, prior art and design (2026-10-10)

Session report for the decision card "One event stream and one state manager for all daemons, the operator pages
and the tools" (bornAs xqux73p; it links back here through `relatedReport`). Research topic: `/research/event-stream-state-manager/`. Operator ask, 2026-10-10 about 16:30 ET:
"we should ideally have a single event stream and state manager for all", then "File, but have a strong prepare, not
your quick feel."

Method: three parallel read-only inventories of the code and the live logs, one web prior-art survey with fetched
sources, and one independent Codex design review (read-only, run before the card was written). A skeptic agent and a
separate fresh-context screen agent then attacked the drafted forks. All repo citations are against lane-3 at
`75be239bf`.

## 1. Measured evidence, 2026-10-10

| Claim in the brief | What the logs show | Source |
| --- | --- | --- |
| WIP publisher ~3 h at ~56% CPU re-scanning 24 h of sessions | Re-scanning confirmed: 1,479 full 24 h `sessions` reads today; change-to-page delay median 46.6 s, p90 105 s, max 312 s. The publisher process itself averaged about 15% of one core over 3h12m (28m41s CPU). The "56%" in its log is whole-machine CPU. | `~/Library/Logs/plateau-wip-publisher.log` (from line 114134); `ps` |
| Fixer passes 25–30 min, same PRs re-planned 4x | 93 passes today, mean 732 s; 7 passes over 1,500 s (1514.2 s, 1771.7 s, 2322.1 s; max 2121 s at 07:48Z). Four planners per PR (fix, ci-heal, promote-draft, notes). | `~/workspace/wev-fix-daemon/.conveyor/fix-dispatch-daemon.log` lines 32977, 33210, 33581; `we:backlog/5767-every-daemon-tick-is-schedule-only-async-job-model.md` |
| Reviewer restarted 15x, cold first tick each time | 37 starts in the UTC day, 27 since midnight ET. Start to first tick 2.6–19.8 min, mostly 4–9 min. | `~/workspace/wev-review-daemon/.conveyor/review-daemon.log` (from line 26796) |
| operator-queue ENOBUFS on duplicate GitHub reads | Its own `gh pr list … comments` overflowed Node's 1 MB buffer and hid all 25 open WE PRs. Fixed by commit `7ae06dc25` (#4722) with a 256 MB buffer. No log line kept. | `we:scripts/operations/operator-queue.mjs:371-378` |
| Ledger shadow 491/493 unreadable | Grew to 591 of 593 across 139 drain runs (09:31–16:24 ET): 1 agree, 1 disagree, 591 unreadable. Every bad run: `transport-read-failed`, `spawnSync git ENOBUFS`. | `~/workspace/.operations/runs/` drain-ledger-shadow run records; `we:scripts/lib/verdict-ledger-io.mjs:56-66` |
| Drain re-lists PRs every pass, ~35–50 s | Listing: median 16.4 s, p90 41.3 s, max 171 s; 62 of 405 passes in the 35–50 s band. Listing plus gate reads median 26.6 s; whole pass median 61 s, p90 158 s. | `~/workspace/plateau-app/.drain-daemon/daemon.log` (from line 167061) |

Two of the six failures (operator-queue, ledger shadow) are the same defect: a whole-history read with no cursor
through a fixed-size process buffer. A third (the WIP feed) is the same defect without the crash: it re-reads the
whole window every time. The other three (fixer, reviewer, drain) are the cost of state that lives only in memory or
is re-derived per pass.

## 2. Inventory of what exists

### 2.1 GitHub-facing state

- **pr-events Worker and Durable Object** (`we:scripts/conveyor/pr-events-worker/`). One SQLite-backed object,
  `idFromName('global')` (`we:scripts/conveyor/pr-events-worker/worker.mjs:52`), tables `events`, `meta`,
  `projection` (`we:scripts/conveyor/pr-events-worker/worker.mjs:18-21`). Append is one transaction: dedupe by
  delivery id, `seq = head + 1`, fold into the projection, prune
  (`we:scripts/conveyor/pr-events-worker/core.mjs:257-268`). Retention: at most 5,000 events or 7 days for
  everything (`we:scripts/conveyor/pr-events-worker/core.mjs:53-54`). Read returns `reset` (no or future cursor),
  `gap` (cursor older than the oldest row) and `more` (`we:scripts/conveyor/pr-events-worker/core.mjs:296-310`).
  `GET /prs` returns the folded projection, `stateCursor` and a partial `coverage`
  (`we:scripts/conveyor/pr-events-worker/core.mjs:284-292`). The bootstrap seeds the projection without moving
  `head` (`we:scripts/conveyor/pr-events-worker/core.mjs:270-282`). Writers: GitHub through an HMAC-verified
  webhook, plus the bootstrap. Readers: `we:scripts/lib/pr-events.mjs` (cursor in memory only, line 157; off
  unless `WE_PR_EVENTS=1`, line 20), the pr-facts mirror, health-watch. It is a wake hint only
  (`we:scripts/lib/pr-events.mjs:12-13`).
- **pr-snapshot** (`we:scripts/lib/pr-snapshot.mjs`, `we:scripts/lib/pr-snapshot-store.mjs`). One file per repo
  under `~/.claude/conveyor/pr-snapshot/` with 16 fields per PR including bodies and comments. Refreshed by the first
  reader to miss, under a file lock (wait 45 s, stale 120 s), TTL 75 s, dirty markers touched by gh-throttle. 11
  readers try it first and list GitHub themselves on a miss.
- **pr-facts mirror** (`we:scripts/lib/pr-facts.mjs`). A per-repo file folded from the Durable Object with the
  Worker's own fold, TTL 120 s, one lock. Read by review-facts, fix-facts and reconcile-pass.
- **Verdict ledger** (`we:scripts/lib/verdict-ledger.mjs`, `we:scripts/lib/verdict-ledger-io.mjs`). Append-only
  JSONL per repo on branch `ops/review-requests` (capabilities shared, total order, push-race retry up to 5) plus a
  home copy. About 8 writers. Every read runs `git fetch` and pulls the whole file through `spawnSync`, which is the
  ENOBUFS failure. Shadow only; no merge gate reads it yet.
- **operator-queue** (`we:scripts/operations/operator-queue.mjs`). Its own `gh pr list --limit 200` with comments, per
  repo; does not use the snapshot.
- **`gh pr list` call sites.** 68 `['pr', 'list']` call expressions in 56 non-test files under `we:scripts/` and
  `we:skills-src/` (grep at `75be239bf`; the first inventory pass estimated about 66). The drain alone has three
  (`we:scripts/merge-ai-prs.mjs:4537`, `:4304`, `:4166`). Only 11 try the shared snapshot first.
- **pr-event-feed** (`we:scripts/lib/pr-event-feed.mjs`). The persisted cursor plus dirty-PR marks in one atomic
  file per role, take / ack at-least-once, full sweep on `gap` / `reset` (lines 17-24, 249-270). Unwired in WE; the
  drain imports it from the WE clone and runs it in shadow (`plateau:tools/drain-daemon/daemon.mjs:189-214`).
- **derivePrState** (`we:scripts/lib/pr-state.mjs:81`): a pure fold, "no callers are switched" (line 10).

### 2.2 Local coordination state

| Mechanism | Store | Single-writer primitive | Durability | Pain |
| --- | --- | --- | --- | --- |
| Daemon job core | one JSON per job under `~/.claude/daemon-jobs/<daemon>/` (`we:scripts/operations/run-store.mjs:125-139`) | `wx` lock plus stale steal (`we:scripts/lib/atomic-json-file.mjs:89-96`) | temp plus rename, no fsync | health-watch scans the whole root |
| Resource sampler | snapshot plus history under the coordination root (`we:scripts/lib/resource-admission.mjs:23-46`) | supervised single job | atomic snapshot | three host samplers side by side (`we:scripts/lib/host-sample.mjs:15-16`, telemetry day files, the sampler) |
| Lane leases | a marker in each lane's git dir (`we:scripts/lib/lane-lease.mjs:22`) | `linkSync` no-clobber (`we:scripts/lane-pool.mjs:744-759`) | — | 14 concurrent scans of about 129 lanes pinned fseventsd (`we:scripts/lane-pool.mjs:204-207`) |
| Queue sidecar | `we:.conveyor/queue.json` (`we:scripts/conveyor/queue-store.mjs:22-34`) | none: last write wins by design (lines 315-325) | rename | — |
| Action-store claims | one file per attempt (`we:scripts/operations/action-store.mjs:13-17`) | fence plus CAS on token and rev (lines 43-55) | `wx` plus fsync | the strongest model in the repo |
| Heavy slots | `mkdir` slot dirs (`we:scripts/readiness/heavy-admission.mjs:15-26`) | mkdir | — | waiters used to time out and break the cap |
| Free-scope registry | one JSON under the coordination root (`we:scripts/operations/free-scope-io.mjs:20`) | path lock | rename | — |
| Prepare-hold, claims | per-checkout JSON (`we:scripts/backlog.mjs:92-94`) | none | plain write | last write wins |
| Telemetry | day files, lock-free `O_APPEND` under `PIPE_BUF` (`we:scripts/operations/telemetry-store.mjs:22-28`) | line size cap | — | — |

Plus 20+ other append-only JSONL logs in `we:scripts/lib/` and `we:scripts/conveyor/`, each with its own format. No
SQLite, LMDB, Redis or NATS anywhere at runtime. No `fs.watch`: every daemon polls. The running Node is v22.1.0
(the repo's nvm pin is 22), where `node:sqlite` does not exist.

### 2.3 Sessions, coroner, WIP, reviewer, fixer

- **Sessions.** The Claude harness writes one state record per job under `~/.claude/jobs/` (609 today) and
  transcripts under `~/.claude/projects/` (about 3,958 top-level transcripts, 5.7 GB). `createAgentActivityReader`
  (`we:scripts/operations/agent-activity-io.mjs:331`) reads every job record with no age bound and, with `all:true`,
  stats every transcript and tail-reads the recent ones. Its header says it is not incremental (lines 24-27). Every
  reader re-derives the same view.
- **Coroner** (`we:scripts/operations/coroner-extract.mjs`). The only incremental cursor in the set: it saves
  `lastEnd` and `--since last` resumes (lines 893-908).
- **WIP publisher** (plateau-app, launchd). Shared sources go through a machine-wide lock and cache; the sessions feed
  does not, and runs the full 24 h `sessions` command on every change in the watched directories, with a 30 s
  backstop.
- **Reviewer** (`we:skills-src/conveyor/review-daemon.mjs`). Each 120 s tick does its own `gh pr list` and
  `claude agents --json` (line 289). Nothing about the plan survives a restart.
- **Fixer** (`we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs`). Four planners per PR per pass, no planning
  cache between them.

### 2.4 Already ruled, per kind

| Card or anchor | What it already rules |
| --- | --- |
| #5452 (E1–E7, 2026-10-08) | One ordered PR event log in the Durable Object holding facts, verdicts, worker events and action requests; one decider; per-role executors with cursors; safety re-sync. |
| #4601 (2026-09-30) | One portable event-log-plus-outbox schema; Durable Objects as hosted authority; Postgres self-hosted; local SQLite only for development and pending commands, never a second authority; tested restore before hosted authority. |
| `#verdict-ledger-pr-state-store` (2026-10-05) | Judgments on the git ledger, GitHub facts in the Durable Object, joined at read time by `derivePrState`; unreadable is never empty. |
| `#state-lives-where-its-nature-dictates` | State placed by its nature; shared stores behind a vendor seam; the git branch is a waiting room, not a destination. |
| `#event-driven-land-is-wake-only` | One drain writes `main`; events only wake it. |
| #4086 (prepared) | Host fencing; cross-host claims as one CAS authority per key with a fencing token. |
| #5767 (2026-10-10) | Every tick schedule-only, reading one shared view. |
| #5712 (2026-10-09) | One resource sampler and one admission library. |

The gap: nothing joins these for every kind, and nothing replaces the 68 listers and the three PR caches with one
reader.

## 3. Prior art (sources fetched 2026-10-10 unless marked)

1. **Kubernetes informers and controllers.** List, then watch from the returned `resourceVersion`; a compacted
   version returns `410 Gone` and the client clears its cache and relists. etcd keeps about 5 minutes of history by
   default. A SharedIndexInformer gives the controllers in a process one cache and one watch; handlers only enqueue
   keys onto a deduplicating, rate-limited queue; reconcile is level-triggered against the cache; a resync period
   replays the cache. Only the apiserver writes etcd; updates use `resourceVersion` for optimistic concurrency; Lease
   objects do leader election.
   https://kubernetes.io/docs/reference/using-api/api-concepts/ ·
   https://github.com/kubernetes/sample-controller/blob/master/docs/controller-client-go.md ·
   https://kubernetes.io/docs/concepts/architecture/leases/ ·
   https://etcd.io/docs/v3.5/op-guide/maintenance/#history-compaction-v3-api-key-value-database
   *Lesson:* the daemons are controllers. List, watch from `seq`, relist on gap, mark keys dirty, reconcile on
   current state, keep a slow resync, one writer.
2. **Event sourcing and CQRS.** The log is the truth and state is a projection; snapshots bound replay; old events
   are upcast on read and never edited. https://martinfowler.com/eaaDev/EventSourcing.html ·
   https://martinfowler.com/bliki/CQRS.html · https://leanpub.com/esversioning (not re-fetched)
   *Lesson:* version every type from day one. GitHub stays the authority for GitHub facts; our log records what we
   observed and what we decided.
3. **SQLite WAL and node:sqlite.** Readers do not block the writer, one writer at a time, and WAL does not work over
   a network filesystem; a reader that never releases starves checkpoints. `node:sqlite` arrived in 22.5, unflagged
   but experimental in 22.13 / 23.4, release candidate only in 25.7. https://sqlite.org/wal.html ·
   https://nodejs.org/api/sqlite.html · transactional outbox: https://microservices.io/patterns/data/transactional-outbox.html
   *Lesson:* a good single-host cache or outbox; not a cross-host authority.
4. **Append-only JSONL.** POSIX makes only pipe writes up to `PIPE_BUF` atomic; `O_APPEND` does not promise a large
   write lands whole; a crash can leave a torn last line.
   https://pubs.opengroup.org/onlinepubs/9799919799/functions/write.html
5. **NATS JetStream and Redis Streams.** Durable consumers with their own cursor; JetStream KV watch delivers current
   values then changes, with compare-and-set on revision; Redis consumer groups keep a pending list until `XACK`.
   https://docs.nats.io/nats-concepts/jetstream/key-value-store · https://docs.nats.io/nats-concepts/jetstream/consumers ·
   https://redis.io/docs/latest/develop/data-types/streams/
   *Lesson:* the right primitives, but a new always-on service with a listener reachable from VMs and CI.
6. **Litestream and LiteFS.** Async WAL shipping to object storage; FUSE primary with async replicas. Disaster
   recovery and read replicas, not shared writes. https://litestream.io/how-it-works/ ·
   https://fly.io/docs/litefs/how-it-works/
7. **Cloudflare.** A Durable Object is single-threaded and strongly consistent with SQLite storage; WebSocket
   hibernation keeps clients connected while the object sleeps; Queues are at-least-once; D1 replicas are async with
   session bookmarks. https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ ·
   https://developers.cloudflare.com/durable-objects/best-practices/websockets/ ·
   https://developers.cloudflare.com/queues/reference/delivery-guarantees/ ·
   https://developers.cloudflare.com/d1/best-practices/read-replication/
   *Lesson:* the existing object is already the apiserver-plus-etcd role for anything multi-host; its `seq` is the
   `resourceVersion`.
8. **Git as a database.** Every write is a commit and a push; concurrent pushes are non-fast-forward; secondary rate
   limits apply to content creation. https://git-scm.com/docs/git-notes ·
   https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
9. **Orchestrators.** Nomad and Consul blocking queries return the last index, wait up to minutes with jitter, and
   a return is not a guarantee of change. Temporal rebuilds workflow state by deterministic replay of a per-workflow
   history. GitHub Actions runners and Buildkite agents only connect outbound.
   https://developer.hashicorp.com/nomad/api-docs#blocking-queries ·
   https://developer.hashicorp.com/consul/api-docs/features/blocking · https://docs.temporal.io/workflow-execution/event ·
   https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners
10. **GitHub webhooks.** Respond within 10 s; GitHub does not automatically redeliver failed deliveries; manual or
    API redelivery is possible for 3 days; `X-GitHub-Delivery` stays the same on redelivery. GraphQL: 5,000 points
    an hour per user; App installations up to 12,500; secondary limits per minute and concurrency.
    https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks ·
    https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries ·
    https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api

### Comparison

| Option | Consistency | Multi-host | Ops cost | Fits laptop + VMs + CI |
| --- | --- | --- | --- | --- |
| Durable Object sequencer, long-poll then WebSocket | strong, one writer per object | yes, outbound HTTPS | very low, already deployed | yes |
| Local SQLite WAL plus outbox | strong, one writer | one host | very low | laptop only; good as cache |
| JSONL append logs | weak (torn lines, interleaving) | no | lowest | single-writer audit only |
| NATS JetStream | strong per stream, CAS | yes | medium (binary, auth, tunnel) | works; more than needed |
| Redis Streams | strong on one node | yes | medium | more than needed |
| Litestream / LiteFS | async replicas | read replicas | medium | backup only |
| D1 with sessions | sequential within a session | yes | low | a store, not a sequencer |
| Git refs | strong, push contention | yes | high latency | no, for events |
| Per-daemon polling (today) | eventual, N times the API cost | yes | hidden in rate limits | keep one reconciler only |

## 4. Independent review (Codex, read-only, before the card was written)

Codex was given the problem, the rulings already in force and the ten fork questions, and inspected the repo
itself. Its defaults: extend the Durable Object for delivery coordination, not every byte (raw transcripts and
high-frequency samples stay outside); a versioned envelope with deterministic upcasting; a cross-host protocol now,
deployed incrementally; one authority per kind, with the git ledger bridged into the stream through a durable
checkpoint; webhooks plus one periodic reconciling re-list; durable cursors plus snapshot-and-watch recovery,
reusing `we:scripts/lib/pr-event-feed.mjs`; retention per class; read surfaces before executors, never fixer
first; explicit degradation, never "unreadable as empty"; leases stay atomic primitives. Corrections it raised:
the API uses `cursor`, not `after`; the bootstrap changes the projection without advancing the log, so
reconciliation must become an observable revision; and "the performance goal is collect once, update
incrementally, decide once per changed input; a new store alone cannot deliver that." All three are folded into
the card. Codex and this session agree on every default; the session's own reading of the code reached the same
place before the Codex answer arrived, except the bootstrap point, which only Codex caught.

## 5. Design synthesis

The operator's "one stream and one state manager" is right as an outcome but wrong if read as "one physical
store for every byte". Three facts force the shape:

1. **A remote store cannot see local process liveness**, and 10-second samples or raw transcripts do not belong
   in a shared order. So host-local kinds keep a per-host journal in the same envelope.
2. **Single-writer invariants need a conditional write**, not an observation. So leases, claims and slots stay
   CAS primitives and publish observations.
3. **The judgment authority cannot move before a tested restore** (#4601) and a clean agreement window
   (`#verdict-ledger-pr-state-store` F3). The git branch is a waiting room by statute, so the end state is the
   hosted stream; until then the ledger is bridged, not moved.

What is genuinely one: one envelope, one sequenced stream for shared kinds, one informer library with durable
cursors and a warm host cache, one reconciler talking to GitHub, one fold per kind. Those remove the measured
failures: no whole-history reads (ENOBUFS x2), no full re-scans (WIP), no cold restarts (reviewer), no per-pass
re-listing (drain, 68 call sites), and a single planned view per PR (fixer, with #5767).

One correction the skeptic forced: the ledger ENOBUFS (591/593) is not fixed by mirroring the ledger into the
stream, because a mirror would read through the same `git show` path
(`we:scripts/lib/git-transport-branch.mjs:213-225`, `execFileSync` with the default 1 MB buffer). It needs its own
small fix (a buffer, then reads by commit range from a checkpoint) and should ship first, independent of this
design. It stays in the evidence as an instance of the pattern, not as a reason to build.

## 6. Skeptic and screen

Both were run by separate agents that had not written the forks. The screen asked only the two framing questions
(implementation detail vs standard, merit vs prioritisation). It flagged five forks for mixing kernel detail into
rules a standard would carry, and three for ordering dressed as a fork. The card was restructured in response:
every fork now says which layer it rules (standard contract or kernel), the cross-host fork was folded into the
store fork, the writer-of-record fork now rules the end state on merit instead of timing, and build order moved
out of the forks into the slice plan. The skeptic attacked each default on classification, merit, statute overlap
and citation scope; its verdicts and the amendments it forced are recorded on the card, one `Skeptic:` line per
fork.
