---
bornAs: xqux73p
kind: decision
parent: "3383"
status: open
dateOpened: "2026-10-10"
preparedDate: "2026-10-10"
preparedAgainstSha: "75be239bfe71416cb2de79d80d25578d0e70918c"
relatedTo: ["5452", "4601", "4086", "5767", "4609", "3007", "2626", "4282", "5712"]
relatedReport: reports/2026-10-10-event-stream-state-manager.md
tags: [conveyor, daemons, event-driven, state-store, decision-prep]
---

# One event stream and one state manager for all daemons, the operator pages and the tools

Operator ask, 2026-10-10 about 16:30 ET: "we should ideally have a single event stream and state manager for
all", then "File, but have a strong prepare, not your quick feel."

*Prepared 2026-10-10 (session event-stream-decision).* Research topic:
[/research/event-stream-state-manager/](/research/event-stream-state-manager/). Session report:
`we:reports/2026-10-10-event-stream-state-manager.md` (full inventory with file:line, prior art with sources,
an independent Codex design review, and the measured evidence). Each of the 8 forks below carries a **bold**
default, the layer it rules (standard contract or kernel), a `Skeptic:` line and a `Screen:` line. Both the
skeptic and the screen were separate agents that did not write the forks; their findings reshaped the card
(9 drafted forks became 8, and two evidence claims were corrected).

## Digest

Today every consumer builds its own picture of the world by polling GitHub or re-scanning files. There are
**68 `gh pr list` call expressions in 56 non-test files**; only 11 try the shared snapshot first. There are
**three PR-state caches** side by side (the pr-snapshot file, the pr-facts mirror of the webhook Durable
Object, and live `gh` reads), **three host-load samplers**, and **20+ separate append-only JSONL logs**, each
with its own lock, TTL and format. Only the coroner resumes from a saved position, and the one cursor module
built for the PR feed is not wired in WE.

Measured on 2026-10-10 (sources in the report):

- **Ledger shadow: 591 of 593 compares unreadable** across 139 drain runs (09:31–16:24 ET), every one
  `spawnSync git ENOBUFS`. Each read pulls the whole ledger file through `git show` with Node's default 1 MB
  buffer (`we:scripts/lib/git-transport-branch.mjs:213-225`). The brief's 491/493 was the morning figure. *This
  one has a one-line fix (a `maxBuffer`) that does not need this design; it is evidence of the pattern (whole-file
  reads with no cursor), not a reason to build.*
- **operator-queue ENOBUFS** hid all 25 open WE PRs: its own `gh pr list … comments` overflowed the 1 MB buffer
  (fix commit `7ae06dc25`, comment at `we:scripts/operations/operator-queue.mjs:373-377`). It does not use the
  shared snapshot.
- **Fixer passes 1514 / 1771 / 2322 s**; 93 passes today averaging 732 s. Each PR is planned 4 times (fix,
  ci-heal, promote-draft, notes) with no cache between them (`we:backlog/5767-every-daemon-tick-is-schedule-only-async-job-model.md`).
- **Reviewer: 27 restarts since midnight ET** (37 in the UTC day; the brief said 15). The first tick after a
  restart comes 4–9 min later (up to 19.8 min), because the plan and the feed cursor live only in memory
  (`we:scripts/lib/pr-events.mjs:157`).
- **Drain listing**: median 16.4 s, p90 41.3 s, max 171 s per pass; 62 passes fell in the 35–50 s band.
- **WIP sessions feed**: 1,479 full 24 h `sessions` re-scans today over about 3,958 transcripts (5.7 GB).
  Change-to-page delay median 46.6 s, p90 105 s. The publisher averaged about 15% of one core over 3h12m. The
  brief's "56%" is the whole-machine figure in its log, not the publisher.

**The finding that shapes everything below:** most of the parts are already ruled, but per kind and in
separate cards. #5452 (rulings E1–E7) rules one ordered PR event log in the Durable Object. #4601 rules a
portable event-log schema for review and delivery events, Durable Objects as the hosted authority, and local
SQLite as a pending-command queue that is never a second authority. #5767 rules schedule-only ticks over one
shared view. #5712 rules one resource sampler. #4086 (prepared, not ratified) proposes how cross-host claims
work. What is missing is the rule that joins them for **every** kind (sessions, jobs, resources, leases, queue,
judgments, GitHub facts), and the one reader library that replaces the 68 listers and three caches. So this card
does not pick a new database. It decides what "one stream, one state manager" means across kinds.

## Recommended path at a glance

| Fork | Recommended default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 — the shared stream | **(a) One sequenced stream per tenant for every shared kind, reachable from any host over outbound HTTPS; the store is picked by name and the default adapter is the existing pr-events Durable Object. Host-local kinds stay in a per-host journal with the same envelope.** | (b) A SQLite hub on the Mac as the authority | High |
| 2 — the state manager | **(a) Contract: list at `seq`, watch from `seq`, relist on `gap`/`reset`, durable cursor per consumer, level-triggered reconcile. Kernel: one informer library per process with a per-host cache, written compare-and-replace on `seq`.** | (b) An always-on local state daemon every tool calls | Med-high |
| 3 — event envelope | **(a) One versioned envelope for every kind; `schemaVersion` with upcasting on read; producer identity stamped from the credential, never trusted from the body** | (b) Each producer keeps its own shape | High |
| 4 — writer of record | **(a) Exactly one authority per kind. An authority moves to the stream only with a tested restore (#4601) and by statute PR. Judgments stay on the git ledger and are mirrored into the stream until then.** | (b) Any daemon publishes the state it derived | High |
| 5 — leases, claims, slots | **(a) Stay atomic primitives with a conditional write. The stream gets display-only observations; no acting consumer reads them for ownership.** | (b) Ownership derived by folding events | High |
| 6 — how GitHub facts enter | **(a) Contract: every projection change is an event that moves `seq` and names its source. Kernel: webhooks, one budgeted reconciler, a redeliver sweep; per-PR live probes before a write stay.** | (b) Each consumer falls back to its own `gh` listing | High |
| 7 — failure posture | **(a) Stale is visible and bounded: pages show age and watermark; ruled per-kind postures apply; producers buffer in a bounded outbox; live pre-write and pre-land reads are exempt.** | (b) Every consumer falls back to its own full scan | Med-high |
| 8 — cutover rule | **(a) No permanent dual read path: each consumer cuts over behind off / shadow / on, the flip changes the default, and the old reader is deleted after a soak window.** | (b) Keep the old reader forever as a fallback | High |

## Supported by default (not forks)

- **Retention and compaction are settings, per class (a config dimension).** E3 already rules "facts compact,
  judgments kept forever". Platform defaults, each overridable through the policy cascade: GitHub facts 7 days
  plus the current per-key snapshot; judgments forever; action-requested and worker events 30 days; job lifecycle
  30 days; resource samples 24 h raw on the host plus 30-day rollups; session activity 7 days (scrubbed). Dedupe
  receipts and unresolved actions outlive normal expiry. A cursor older than the retained range gets `gap` and
  relists. **Prerequisite, not a setting yet:** today the Durable Object prunes every kind at one 5,000-event /
  7-day cap on each append (`we:scripts/conveyor/pr-events-worker/core.mjs:53-54`, `:266`), and delivery dedupe
  (`we:scripts/conveyor/pr-events-worker/worker.mjs:29`) only sees rows that still exist. Per-class retention and
  durable dedupe receipts are the first slice, before any non-GitHub kind is appended.
- **Every knob resolves through the policy cascade** (`we:scripts/lib/policy-cascade.mjs`; agent memory 151):
  standard default (Ship Evermore), then the Platform Forever preference, then the tool override. That covers
  retention per class, re-sync and resync intervals, the GitHub call budget, each consumer's off / shadow / on
  mode and soak window, outbox bounds, and the store chosen by name (the `verdictLedger.store` registry pattern,
  `we:docs/agent/platform-decisions.md#verdict-ledger-pr-state-store`).
- **Placement.** The envelope schema, the kind registry and the replay / conformance vectors are definitions:
  they belong to the delivery standard (#5407's protocol home; #4609 "standard in WE; engine in Frontier UI").
  The informer library and store adapters are kernel, whose home is Frontier UI per #4601 ("generic store/fold
  implementations belong to Frontier UI"). Their interim home is `we:scripts/lib/`, the same exception every
  conveyor module lives under today until #2446 moves the engine. Hosting, credentials and the per-company
  Durable Object belong to Plateau. Vendor calls stay in each adapter's IO shell
  (`#state-lives-where-its-nature-dictates`, 2026-08-17 extension).
- **Local SQLite is allowed as a cache or outbox, never as an authority** (#4601's ruling for the review
  ledger, applied here as supporting context). It is opt-in. The default local cache is an atomic JSON snapshot.
  The repo pins Node 22 and the running Node is v22.1.0, where `node:sqlite` does not exist (it arrived in 22.5
  and is a release candidate only from 25.7), so SQLite here means the `better-sqlite3` native dependency. It
  waits for measured need (`#native-first-baseline`).
- **"Ready to land" stays a wake.** `#event-driven-land-is-wake-only` is untouched: the drain is the only writer
  to `main` and re-derives every gate live.
- **Raw transcripts and raw samples never enter the shared stream.** A host collector reads transcripts
  incrementally (by byte offset; the coroner's resume-from-last-run cursor,
  `we:scripts/operations/coroner-extract.mjs:893-908`, is the time-bound precedent) and publishes scrubbed
  session events. The resource sampler (#5712) publishes the changes that matter for admission, not every 10 s
  sample.
- **The ledger read fix is not credited to this design.** The 591/593 ENOBUFS is fixed by giving the transport
  read a buffer and, better, reading by commit range from a checkpoint. That fix stands alone and should ship
  before any of this.

## Fork 1 — The shared stream

*Layer: contract (one order, reachable from any host) plus a kernel default (the adapter).*

*Fork-existence: real either/or. One store has to hold the order for the shared kinds. A Mac-hosted authority
and a cloud-hosted authority cannot both be the sequencer without a second ordering and a merge between them.*

Crux: the pr-events Durable Object is already a single-threaded SQLite sequencer with a transactional append, a
`seq` head, delivery dedupe, a projection table and `cursor` / `gap` / `reset` read semantics
(`we:scripts/conveyor/pr-events-worker/worker.mjs:16-44`, `we:scripts/conveyor/pr-events-worker/core.mjs:244-310`).
Today it holds only GitHub facts and is used only as a wake hint (`we:scripts/lib/pr-events.mjs:12-13`).

- **(a) One sequenced stream per tenant for every shared kind, reachable from any host; store by name, default
  adapter the existing Durable Object (default).** Shared kinds: GitHub facts, mirrored judgments, action
  requests, worker start/finish, job lifecycle, claim observations, session summaries, admission-relevant
  resource changes. Host-local kinds (raw samples, transcript offsets, process liveness) stay in a per-host
  journal with the same envelope. Producers append over authenticated outbound HTTPS; consumers read with a
  cursor. Rules that come with it:
  - **No kind whose only durable copy is the stream is authoritative until #4601's tested restore passes.**
    Action requests are declared re-derivable: the E5 re-decide rebuilds them from the projection, so losing
    them only delays work.
  - **Append permission is per type.** CI and VM credentials may append only observational types. Judgment,
    action and lease types are appended only by the bridge, decider and lease identities. A `pull_request`
    workflow never receives a stream token.
  - Rollout (Mac first; long-poll before WebSocket push) is slice order, not part of the ruling.
- (b) A SQLite WAL hub on the Mac as the authority, with the Durable Object only as GitHub ingress.
  *Rejected:* VMs and CI cannot reach a laptop, laptop sleep stops every host, and SQLite WAL is single-host by
  design. It would also be the second authority #4601 rules out for the ledger.
- (c) Append-only JSONL files per kind with cursors (today's pattern, made general). *Rejected:* no single
  order, no cross-host reads, and torn or interleaved writes past `PIPE_BUF`.
- (d) The git transport for everything. *Rejected:* push contention, second-scale round trips, whole-file reads.
  The statute calls this home a waiting room, not a destination.
- (e) One physical store for literally everything, raw samples and process liveness included. *Rejected:* a
  remote store cannot see whether a process on this machine is alive (`#state-lives-where-its-nature-dictates`,
  2026-08-17 extension).
- *Not a rejected branch:* an embedded broker (NATS JetStream, Redis Streams) is a legitimate adapter behind
  the same name registry. It is not the default because the Durable Object is already deployed and a broker
  needs a listener reachable from VMs and CI.

```js
// Fork 1 (a): any producer, any shared kind, through the store adapter's IO shell.
// producer.role / producer.host are stamped by the sequencer from the credential (Fork 3).
await stream.append({
  type: 'job.finished', schemaVersion: 1,
  subject: { kind: 'job', id: 'review-daemon/9f2c' },
  occurredAt: '2026-10-10T20:31:07Z', causationId: 'evt-118422',
  idempotencyKey: 'review-daemon/9f2c:finished',
  data: { outcome: 'succeeded', durationMs: 412000 },
}); // → { seq: 118431, duplicate: false }
```

Skeptic: SURVIVES-WITH-AMENDMENT. Attack: the default made action requests live only in a store with no tested
restore, and one shared prune cap would push GitHub facts and their dedupe receipts out. Amendments folded in:
the no-authority-before-restore rule, action requests declared re-derivable, per-class retention as a
prerequisite slice, and per-type append permission (the skeptic's CI-credential attack). The cross-host fork was
merged in here because its rejected branch was this fork's (b). #4601 was downgraded from authority to supporting
context (it ruled the review-ledger store, not every kind).
Screen: flagged(impl) on the draft, which ruled "grow the Durable Object". Fix applied: the ruling is the
guarantee (one order per tenant, cross-host, store by name); the Durable Object is the default adapter, and a
broker is an allowed adapter instead of a branch rejected on cost.

## Fork 2 — The state manager

*Layer: contract (the read rules) plus kernel (where the projection lives on a host).*

*Fork-existence: real either/or for the kernel half. A per-process library with a shared disk cache and a
central local daemon that every tool must call cannot both be the read path; the second makes one process a
dependency of every page and tool. The contract half is a forced invariant: a consumer without a relist path
breaks once retention prunes.*

Crux: this is the Kubernetes informer pattern, and the daemons are controllers. A client lists at a version,
watches from it, relists on `410 Gone`, pushes keys onto a deduplicating queue and reconciles against current
state (kubernetes.io API concepts; client-go sample-controller). The repo already has the cursor half:
`we:scripts/lib/pr-event-feed.mjs` persists the cursor and dirty marks in one atomic file per role, with take /
ack and a full sweep on `gap` or `reset` (lines 17-24, 249-270, 293). It is unwired in WE, and the drain runs
it in shadow (`plateau:tools/drain-daemon/daemon.mjs:189-214`). The server half exists for PRs only (`GET /prs`,
`we:scripts/conveyor/pr-events-worker/core.mjs:284-292`).

- **(a) Contract: list at `seq`, watch from `seq`, relist on `gap` or `reset`, a durable cursor per consumer,
  handlers only mark keys dirty, reconcile reads current state, a resync period as a setting. These go into the
  standard as conformance vectors. Kernel: one informer library per process, with a per-host projection cache on
  disk (default).** The cache is an atomic snapshot per kind and host, **written compare-and-replace on `seq`**
  (never replace a snapshot with a lower `seq`), so a restarted reviewer starts warm instead of after 4–9 minutes.
  The fold for each kind is written once and shared (the #2641 one-fold rule). The informer **backs** #5767's
  "one shared view" (pr-snapshot plus pr-facts); it does not replace that ruling. Supporting context:
  `#delivery-decider-under-fixed-settings` rule 4 already prefers "a library each daemon calls … not a central
  daemon".
- (b) An always-on local state daemon that every tool queries over localhost. *Rejected:* a new single point of
  failure on the laptop that every page and CLI depends on, unreachable from VMs and CI. The per-host cache gives
  the same "fold once" saving without that dependency.
- (c) Each consumer folds the raw log itself, with no shared projection. *Rejected:* today's duplication one
  layer down; it breaks the #2641 one-fold rule.
- (d) Replay from `seq 0` on every start. *Rejected:* start time grows with history and fails once retention
  prunes.

```js
// Fork 2 (a): a consumer is a controller
const prs = informer({ kind: 'pr', role: 'review', cache: hostCache('pr') });
prs.onDirty(async (key) => reconcileReview(key, prs.get(key)));  // level-triggered
await prs.start(); // warm from cache → list at seq if stale → watch; gap/reset → relist
```

Skeptic: SURVIVES-WITH-AMENDMENT. Attacks: every process writing the cache contradicted "one cache writer"
(a lower `seq` could overwrite a higher one), and the fork quietly replaced #5767's shared view. Amendments folded
in: compare-and-replace on `seq`, and "backs, does not replace" #5767.
Screen: flagged(impl) on the draft, which mixed the read rules with the library-vs-daemon choice. Fix applied:
the contract half (standard, conformance vectors) and the kernel half are now named separately.

## Fork 3 — The event envelope

*Layer: contract.*

*Fork-existence: forced invariant. The excluded branch, an untyped shape per producer, is broken: a reader cannot
tell a new shape from a corrupt one, and #5461's replay fixtures cannot be written against it. What is new here
is widening #4601's schema (ruled for review and delivery events) to every kind.*

- **(a) One versioned envelope for every kind (default).** Fields: `type`, `schemaVersion`, `eventId`,
  `subject {kind, id}`, `producer {role, host, run}`, `occurredAt` (producer clock, information only),
  `receivedAt` and `seq` (assigned by the sequencer), `causationId`, `correlationId`, `idempotencyKey`, `data`.
  **The sequencer stamps `producer.role` and `producer.host` from the authenticated credential and rejects a body
  that disagrees.** Stored events are never rewritten. A shape change bumps `schemaVersion` and gets a pure
  upcaster tested by the conformance fixtures; a change in meaning gets a new `type`. An unknown version on a type
  that drives a decision holds that subject visibly. Kinds and types are a registry, so adding a kind is not a
  standard change.
- (b) Each producer keeps its own shape (today, 20+ formats). *Rejected:* see the justification.
- (c) A new type name for every revision (`pr.opened.v2`). *Rejected as the general rule:* it multiplies handlers
  and does not settle compatibility. It stays available when the meaning changes.

Skeptic: SURVIVES-WITH-AMENDMENT. Attack: classification (largely settled by #4601 and E4) and security (the
draft let the client declare its own producer). Amendment folded in: producer identity is stamped from the
credential. Kept as a forced-invariant fork because widening to every kind and the identity rule are new.
Screen: clear. The envelope is the cross-boundary contract, and both questions found merit, not ordering.

## Fork 4 — The writer of record for each kind

*Layer: contract (one authority per kind; how an authority moves).*

*Fork-existence: forced invariant. The excluded branch, any daemon publishing the state it derived, is broken:
competing authorities are the label-race class #3007 closes.*

- **(a) Exactly one authority per kind. An authority moves into the stream only after a tested restore (#4601)
  and by a statute PR (default).** For judgments this settles the E3 / F2 question on merit, not timing: the git
  ledger is the authority now, its end state is the hosted stream (the statute calls the git branch "a waiting
  room, not a destination"), and the move waits for the tested restore because an authority that cannot be
  restored can lose verdicts. Until then judgments are **mirrored** into the stream (as #5456 already plans): the
  mirror carries the ledger commit and offset, readers expose a ledger watermark, and a gap between the ledger
  head and the mirror reads as unreadable for gate purposes, never as "no verdict". The mirror reads by commit
  range from a checkpoint, never the whole file. Every reader keeps calling one `derivePrState`. The current
  mapping of each kind to its authority is in Context; it is kernel configuration, not part of the ruling.
- (b) Any daemon publishes the state it derived. *Rejected:* see the justification.
- (c) Move judgments into the stream now, before a tested restore. *Rejected:* an authority without a tested
  restore can lose rows; the 2026-08-20 statute extension records six verdicts lost from an ephemeral CI writer.

Skeptic: SURVIVES-WITH-AMENDMENT. Attacks: the draft claimed the mirror would remove today's ENOBUFS failures
(false: it would read through the same `git show` path with the same 1 MB default), and it cited
`#verdict-ledger-pr-state-store` F3's 7-day window, which governs merge authority, not where the ledger lives.
Amendments folded in: the ENOBUFS claim is withdrawn and the fix listed separately; the mirror reads by commit
range; the F3 citation is dropped. The statute-overlap check found no collision once the end state is read from
the waiting-room clause.
Screen: flagged(prio) on the draft, whose rejected branch was "not yet". Fix applied: the fork now rules the end
state and the restore invariant on merit; the mirror and the flip date are slices.

## Fork 5 — Leases, claims and admission slots

*Layer: contract.*

*Fork-existence: forced invariant. The excluded branch, ownership worked out by folding events, is broken: two
consumers can both act before either sees the other's event. Ownership needs a conditional write, not an
observation. The rule stands on its own; how it relates to the open cross-host decision is in Context.*

- **(a) Leases, claims and slots stay atomic primitives with a conditional write; the stream gets display-only
  observations (default).** No acting consumer reads a lease observation to decide ownership. Release semantics
  follow the ratified #5767 O15 (a claim whose owner cannot be confirmed gone is quarantined, never released on
  TTL). The observations let pages and the coroner see leases without scanning about 129 lanes. The existing
  primitives are listed in Context.
- (b) Ownership derived by folding events. *Rejected:* see the justification.

Skeptic: SURVIVES. Attack: classification (the excluded branch is one the open cross-host decision also
excludes) and a collision between that decision's TTL release and #5767 O15. Kept as a fork because the
cross-host decision is not ratified; the release rule follows the ratified #5767 O15, and observations are
display-only.
Screen: clear. Single-writer guarantees are observable. Host mechanism citations moved to Context.

## Fork 6 — How GitHub facts enter

*Layer: contract (projection changes are events) plus kernel (who talks to GitHub).*

*Fork-existence: forced invariant. Webhooks alone are broken: GitHub does not redeliver failed deliveries on its
own (GitHub docs, handling failed webhook deliveries). Per-consumer listing is broken in practice: 68 call
expressions, two ENOBUFS failures today and the 2026-09-26/27 GraphQL exhaustion.*

- **(a) Contract: every change to a projection is an event that moves `seq` and names its source; facts carry
  their GitHub revision. Kernel: webhooks, plus one budgeted reconciler, plus a redeliver sweep (default).** The
  reconciler is E5's batched re-sync (#5458), a job on the job core with a lease and a health smell. Its
  corrections move `seq` but are tagged `source: reconcile` and **do not touch the feed-health clocks**, so a
  dead webhook still looks dead (the reason today's bootstrap avoids moving `head`,
  `we:scripts/conveyor/pr-events-worker/core.mjs:270-282`). A sweep lists failed deliveries through the REST API
  and asks for redelivery. **Listing** GitHub moves to the informer; **per-PR live probes before a write** (the
  drain's pre-land gate, #5767's probe-fence-act) stay allowed and required. Intervals and the call budget are
  settings. This replaces #4282's "fall back to `gh` when the feed is stale" clause.
- (b) Each consumer falls back to its own `gh` listing when the feed looks stale (#4282 as written). *Rejected:*
  in an outage it turns about 10 consumers into a polling storm.

Skeptic: SURVIVES-WITH-AMENDMENT. Attacks: "no other process lists GitHub" overreached into the live pre-write
reads that #4282, #5767 and the land statute require, and moving `seq` on reconcile would mask a dead webhook.
Amendments folded in: the live-probe carve-out, `source: reconcile` without touching the health clocks, and
#4282's clause named as replaced.
Screen: flagged(impl) on the draft. Fix applied: the observable rule (projection changes move `seq`) is separated
from the kernel's ingestion setup.

## Fork 7 — Failure posture

*Layer: contract (what a consumer may assume in an outage).*

*Fork-existence: real either/or. When the stream is unreachable, consumers either fall back to their own scans or
hold and show staleness. Both cannot be the rule; the first is what turns an outage into the 2026-09-27 landing
freeze.*

- **(a) Stale is visible and bounded (default).** Read-only pages and tools show the last projection with its
  age and watermark. Ruled per-kind postures apply as written (#5712: a stale resource snapshot holds heavy kinds
  and admits light kinds). Acting consumers whose decision needs fresh authority hold with a reason. **Live
  pre-write and pre-land reads are exempt**: the drain still re-derives every gate
  (`#event-driven-land-is-wake-only` clause 1). Producers buffer in a bounded local outbox and keep event ids
  across retries; when it fills, kinds that carry authority block, and observational kinds drop the oldest with
  a loud alert. Only the reconciler lists GitHub, within budget. Invariants that come with it:
  - **Unreadable is never empty** (already statute, `#verdict-ledger-pr-state-store` F4), for every kind.
  - **Order by `seq`, never by clock.** Durations use the monotonic clock (the job core already compares the two
    to detect sleep, `we:scripts/lib/daemon-jobs.mjs:39-42`).
  - **Atomic append**: event, projection update and dedupe receipt in one transaction (as today,
    `we:scripts/conveyor/pr-events-worker/core.mjs:257-268`). A local journal tolerates a torn last line.
  - **Corruption** is quarantined and rebuilt from the authorities: GitHub (relist), the git ledger (re-mirror),
    the harness files (re-collect).
- (b) Every consumer falls back to its own full scan. *Rejected:* see the justification.

Skeptic: SURVIVES-WITH-AMENDMENT. Attacks: "only the reconciler reads GitHub" collided with the land statute's
live re-derive; "acting consumers hold" overrode #5712's ruled posture; the outbox had no overflow rule.
Amendments folded in: the live-read exemption, ruled postures win, and the overflow rule.
Screen: clear.

## Fork 8 — Cutover rule

*Layer: kernel.*

*Fork-existence: forced invariant. The excluded branch, keeping the old reader forever as a fallback, is broken:
it keeps all 68 listers alive and makes Fork 7 (b)'s outage storm permanent.*

- **(a) No permanent dual read path (default).** Each consumer cuts over behind its off / shadow / on setting
  (shadow logs the difference from its old read). The flip PR changes the default to `on`; the old reader is
  deleted in a follow-up PR after a soak window (a setting), and until then `off` still means the old reader, so
  rollback stays a setting change. This is the pattern #5454 and the delivery decider (#4998) already use. The
  order of consumers is the slice plan, not this ruling; the plan's own rule is blast radius first (a read-only
  consumer's fault costs a wrong page, an acting consumer's a wrong action), and acting consumers follow #5452
  and #5767.
- (b) Keep the old reader forever as a fallback. *Rejected:* see the justification.
- (c) Cut every consumer over at once. *Rejected:* no shadow evidence, and one fault hits every consumer.

Skeptic: SURVIVES-WITH-AMENDMENT. Attacks: the mode is a config knob (already listed as a setting), and
"delete the old reader in the flip PR" left `off` with nothing to run. Amendment folded in: delete after a soak
window, so rollback stays a setting.
Screen: flagged(impl, prio) on the draft, which named a consumer order as the default. Fix applied: the fork now
rules only the no-permanent-dual-path invariant, marked kernel; the order moved to the slice plan.

---

## Context

### What exists today (inventory, grounded)

| Mechanism | Stores | Writers → readers | Consistency | Pain |
| --- | --- | --- | --- | --- |
| pr-events Durable Object | events, meta, projection tables (`we:scripts/conveyor/pr-events-worker/worker.mjs:18-21`) | GitHub webhook (HMAC) and bootstrap → `we:scripts/lib/pr-events.mjs`, pr-facts mirror, health-watch | single-threaded sequencer, monotonic `seq` | wake-only; cursor in memory; off unless `WE_PR_EVENTS=1` |
| pr-snapshot | full open-PR list per repo under `~/.claude/conveyor/pr-snapshot/` (`we:scripts/lib/pr-snapshot-store.mjs:15-16`) | first reader to miss → 11 readers | lock, last write wins, TTL 75 s | the 2026-09-27 freeze; only 11 listers use it |
| pr-facts mirror | per-repo file folded from the Durable Object (`we:scripts/lib/pr-facts.mjs:59-68`) | any reader (lock) → review / fix | TTL 120 s | a third PR cache |
| verdict ledger | JSONL on `ops/review-requests` plus a home copy (`we:scripts/lib/verdict-ledger-io.mjs:28-37`) | ~8 writers → drain shadow, pr-status, mirror | push-race retry, whole-file read | 591/593 ENOBUFS today |
| operator-queue | computed buckets | own `gh pr list` (`we:scripts/operations/operator-queue.mjs:371-378`) | live | ENOBUFS hid 25 PRs |
| daemon job core | one JSON per job under `~/.claude/daemon-jobs/` (`we:scripts/operations/run-store.mjs:125-139`) | tick and child → reattach, health-watch | `wx` lock and rename | health-watch scans the whole root |
| resource sampler | an atomic snapshot plus history logs (`we:scripts/lib/resource-admission.mjs:23-46`) | one sampler → admission (shadow) | atomic snapshot, `freshUntil` | three host samplers in parallel |
| lane leases | a lease marker per lane (`we:scripts/lib/lane-lease.mjs:22`) | `linkSync` no-clobber create (`we:scripts/lane-pool.mjs:744-759`) → about 20 modules | conditional create | 14 scans of 129 lanes pinned fseventsd |
| queue sidecar | `we:.conveyor/queue.json` (`we:scripts/conveyor/queue-store.mjs:22-34`) | CLI, prune pass → about 25 readers | rename, no lock, last write wins (lines 315-325) | by design |
| action-store claims | one file per attempt (`we:scripts/operations/action-store.mjs:13-17`) | host-local pid lease plus a rev-checked transition (lines 43-55) → fix dispatch | `wx` plus fsync on create | host-local only |
| heavy slots | `mkdir` slot dirs (`we:scripts/readiness/heavy-admission.mjs:15-26`; `we:scripts/readiness/file-locks.mjs:220-230`) | gate runs → queue op | mkdir atomicity | past cap breaks |
| sessions / WIP | harness files; `createAgentActivityReader` (`we:scripts/operations/agent-activity-io.mjs:331`) | every reader re-derives → WIP, live-state, sessions | no index, no cursor (lines 24-27) | 1,479 full re-scans today |
| coroner | resume-from-last-run time cursor (`we:scripts/operations/coroner-extract.mjs:893-908`) | coroner → operator | the only resume point | — |

### Current authority per kind (kernel configuration under Fork 4)

| Kind | Authority today | How it reaches the stream |
| --- | --- | --- |
| GitHub facts | GitHub | Webhook ingress plus the reconciler (Fork 6) |
| Judgments | The git ledger (`#verdict-ledger-pr-state-store`) | Mirrored with ledger commit and offset (#5456) |
| Action requests | The single decider (#5454), re-derivable | Direct append |
| Worker / job lifecycle | The executor that owns the run (`we:scripts/lib/daemon-jobs-runtime.mjs`) | Append after the record transition |
| Leases, claims, slots | Their primitive (Fork 5) | Display-only observation |
| Resource state | One sampler per host (#5712) | Host journal; admission-relevant changes shared |
| Session / agent activity | The Claude harness files | Host collector by byte offset; scrubbed summaries |
| Operator intent (cleared queue) | `we:scripts/conveyor/queue-store.mjs` until #2742 fires | Observation after each write |

### Relation to #4086 (open, prepared)

#4086 decides how a second host is fenced and what a cross-host claim must guarantee. This card does not depend
on its outcome: Fork 1 only requires that producers and consumers on any host reach one sequencer, and Fork 5 keeps
ownership in conditional-write primitives whatever backend #4086 picks for cross-host claims. If #4086 is ratified
with a TTL release rule, the reconciliation with #5767 O15 belongs to #4086.

### Prior art (sources in the report and the research topic)

- **Kubernetes informers** — list plus watch from `resourceVersion`, `410 Gone` then relist, a shared informer
  cache per process, deduplicating work queues, level-triggered reconcile, periodic resync, one writer with
  optimistic concurrency, Lease objects. Fork 2's model.
- **Event sourcing / CQRS** (Fowler; Greg Young on versioning) — upcast on read, never rewrite (Fork 3). GitHub
  stays the truth for GitHub facts.
- **SQLite WAL** — many readers, one writer, one host only (Fork 1 (b)).
- **NATS JetStream / Redis Streams** — durable consumers and KV watch built in; a new service (Fork 1 adapter note).
- **Litestream / LiteFS** — async single-writer replication: backup, not shared writes.
- **Cloudflare Durable Objects** — single-threaded, strongly consistent, SQLite storage, WebSocket hibernation.
- **Git as a database** — non-fast-forward contention, secondary rate limits (Fork 1 (d)).
- **Nomad / Consul blocking queries, Temporal, GitHub Actions runners** — long-poll with an index and jitter;
  outbound-only agents; deterministic replay.
- **GitHub webhooks** — no automatic redelivery, 3-day redelivery window, `X-GitHub-Delivery` dedupe (Fork 6).

### Independent review (Codex, read-only)

A separate Codex review reached the same defaults for Forks 1 and 3–7 without seeing this card, and added three
points now folded in: projection changes must move `seq` (Fork 6), the ledger mirror needs a checkpoint and
watermark (Fork 4), and "the performance goal is collect once, update incrementally, decide once per changed
input; a new store alone cannot deliver that" (Fork 2).

### Cost and risk (rough sizes, by slice)

| Slice | Size | Existing card |
| --- | --- | --- |
| Ledger transport read: buffer plus read by commit range (stands alone, first) | 1 | new |
| Durable Object: per-class retention, durable dedupe receipts, typed appends with per-type permission | 3 | widens #5453 |
| Envelope schema, kind registry, conformance vectors (incl. the informer read rules) | 3 | widens #4609, #5461 |
| Durable Object: list-at-`seq` per kind; reconcile events tagged by source | 3 | new |
| Informer library generalised from `we:scripts/lib/pr-event-feed.mjs`, host cache CAS on `seq` | 5 | widens 5501 |
| Read-only consumers: operator-queue, pr-snapshot readers | 3 | widens #4282 |
| Sessions collector by byte offset; WIP sessions feed on the informer | 5 | new |
| Job core and sampler publish lifecycle and admission changes | 2 | widens #5712 |
| Reconciler, budget, redeliver sweep | 3 | #5458 plus new sweep |
| Ledger mirror with checkpoint and watermark | 3 | #5456 |
| Retire the remaining `gh pr list` call sites, in batches | 8 | new |

About 39 points, about half already filed. What breaks during migration: two caches can disagree while a
consumer is in shadow (by design, logged); a stream outage before Fork 7 lands stalls only shadow consumers; the
WIP page shows a stale age until its collector is warm; GraphQL spend rises briefly while old listers and the
reconciler both run; every new appender needs a credential, so a missing token shows as a stale kind, not an
error elsewhere.

### Review jury (provisional — pre-registered #2638)

Care level: `high`. This jury binds against the item's predicted scope and is re-checked against the real diff at PR open.

| juror | lens | grounding method | pre-registered expectation |
| --- | --- | --- | --- |
| correctness#1 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. |
| correctness#2 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. |
| security#1 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. |
| security#2 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. |
| simplicity#1 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| simplicity#2 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| standards-conformance#1 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| standards-conformance#2 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| claim-accuracy#1 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |
| claim-accuracy#2 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |

Predicted touch-set of the work this decision authorizes: `we:scripts/conveyor/pr-events-worker/`,
`we:scripts/lib/`, `we:scripts/operations/`, `we:skills-src/conveyor/`, `we:docs/agent/platform-decisions.md`,
`plateau:tools/drain-daemon/`, `plateau:src/wip/`.

## Acceptance

- [A1] **Executable** — n/a: a decision. Done when each fork has a dated operator ruling recorded here and the
  ruling is codified in `we:docs/agent/platform-decisions.md` (an extension of
  `#state-lives-where-its-nature-dictates`), with #4282's fallback clause amended in the same PR.

## Non-goals

- [N1] No new database technology beyond what #4601 ruled.
- [N2] Does not reopen `#event-driven-land-is-wake-only`, #4086's host fencing, or #5767's tick shape.
- [N3] No build. Slices are carved at ratification.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — event `data` is stored and never interpreted; only typed fields drive a decision; producer identity comes from the credential (Fork 3).
2. **Truncated reads** — a cut-off page or listing never advances a cursor or replaces a projection; `gap` relists (Fork 2).
3. **Shared state files** — one sequencer per stream; the host cache is compare-and-replace on `seq`; leases stay conditional writes (Forks 1, 2, 5).
4. **Fail closed** — unreadable is never empty; acting consumers hold on stale authority; live pre-land reads stay (Fork 7).
5. **Identity scoping** — subjects are `{kind, id}` per tenant and repo; action keys include the head commit (Fork 3).
6. **State over time** — retention per class as settings; judgments kept forever (Supported by default).
7. **Who wrote it** — every event carries a producer stamped by the sequencer; appends are permitted per type (Forks 1, 3).
