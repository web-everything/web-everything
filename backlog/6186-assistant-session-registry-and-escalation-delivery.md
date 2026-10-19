---
bornAs: xbrgqq5
kind: story
size: 8
status: open
scope: ["we:scripts/operations/operator-session-bootstrap.mjs", "we:scripts/operations/operator-session-bootstrap-io.mjs", "we:scripts/operations/operator-session-registry.mjs", "we:scripts/operations/operator-session-registry-io.mjs", "we:scripts/operations/escalation-delivery.mjs", "we:scripts/operations/escalation-delivery-io.mjs", "we:scripts/operations/needs-you-feed.mjs", "we:scripts/settings/operator-session.json", "we:scripts/conveyor/needs-you-feed-job.mjs", "we:scripts/operations/__tests__/operator-session-bootstrap.test.mjs", "we:scripts/operations/__tests__/operator-session-bootstrap-io.test.mjs", "we:scripts/operations/__tests__/operator-session-registry.test.mjs", "we:scripts/operations/__tests__/operator-session-registry-io.test.mjs", "we:scripts/operations/__tests__/escalation-delivery.test.mjs", "we:scripts/operations/__tests__/escalation-delivery-io.test.mjs", "we:scripts/operations/__tests__/needs-you-feed.test.mjs", "we:scripts/conveyor/__tests__/needs-you-feed-job.test.mjs"]
dateOpened: "2026-10-17"
preparedDate: "2026-10-18"
preparedAgainstSha: "10abaa04449d0b3393d5e18c5f4615498521efed"
tags: []
---

# Assistant session registry and escalation delivery

Make the operator session bootstrap write a durable registration (session id, account, host, capabilities, quiet policy, heartbeat), refreshed whenever sessions or accounts switch. Daemon escalations go to the needs-you feed plus a direct message to the live registered session, with evidence and a suggested pick. When no live session is registered (stale heartbeat), they fall back to a desktop or phone notification, or to the 07:00 digest during quiet hours. The session acknowledges each item in three steps: received, presented, decided. Operator 2026-10-17: "the assistant will move from handling to being on the receiver end".

## Progress

Preparation investigation, 2026-10-17; no implementation or delivery claim, and no preparation stamp applied.

- **Old premise/scope:** add registration and delivery somewhere under we:scripts/operations/ and we:scripts/conveyor/, with an implied direct-send facility and new quiet-hours fallback. No individual source or test files were named.
- **Corrected premise:** the bootstrap is a read-only plan, not a session lifecycle writer (we:scripts/operations/operator-session-bootstrap.mjs:8; we:scripts/operations/operator-session-bootstrap-io.mjs:9). Its existing transport is a session-created Monitor over a feed, and its acknowledgement is one global publication cursor (we:scripts/operations/needs-you-feed.mjs:138, we:scripts/operations/needs-you-feed.mjs:158). Registration, a targeted receiver, and per-item acknowledgement stages remain undelivered. Bootstrap read-only behavior is asserted in we:scripts/operations/__tests__/needs-you-feed.test.mjs:264 and we:scripts/operations/__tests__/http-adapter.test.mjs:407; do not hide a write inside its injected reader.
- **Transport evidence:** read-only probes of the installed `claude --help` and `claude agents --help` expose listing/attach/resume, but no direct-send command. Resume may create a copy when a session is running; it is not an inbox API. Use the existing Monitor integration as the receiver transport, targeted by registration. Writing to its inbox is an attempt, never proof that the session received or presented the message. No CLI messaging capability is assumed from its name or from mocked tests.
- **Existing owners:** polling and immediate publication already converge on the feed lock (we:scripts/operations/needs-you-feed.mjs:162, we:scripts/operations/needs-you-feed.mjs:202). The supervised job provides the recurring drain (we:scripts/conveyor/needs-you-feed-job.mjs:19). Desktop fallback already has checked delivery (we:scripts/conveyor/branch-sync.mjs:162), and quiet-hours default to 22:00–07:00 America/New_York with emergency exceptions (we:scripts/lib/quiet-hours.mjs:16, we:scripts/lib/quiet-hours.mjs:101). Reuse the queue and digest in we:scripts/lib/quiet-hours-io.mjs; 07:00 means the first drain after configured quiet hours end, not a second hardcoded scheduler.
- **Corrected scope and estimate:** replace the two directory scopes with nine source/config files and eight matching test files listed above. Size **5 → 8**: two new registry modules (~300 lines), two new delivery modules (~320), two bootstrap modules (~100), feed (~120), supervised job (~40), settings (~20), and eight tests (~650 total, with bootstrap coverage split between core and IO), approximately 1,550 changed lines. The additional work is grounded in the current global acknowledgement at we:scripts/operations/needs-you-feed.mjs:138 and read-only bootstrap at we:scripts/operations/operator-session-bootstrap.mjs:10, not just notification formatting. New files are planned; the feed and job test files already exist. As a story this retains `size`, without `estimatedLoc`.

- **Validation repair:** the prepared scope omitted a matching IO test and assigned both bootstrap modules to one test. Add planned we:scripts/operations/__tests__/operator-session-bootstrap-io.test.mjs to scope and the queued test command. Separate pure operation/formatting coverage from filesystem/CLI coverage: we:scripts/operations/operator-session-bootstrap.mjs:5–13 owns formatting and the read-only operation, while we:scripts/operations/operator-session-bootstrap-io.mjs:9–21 owns snapshot reads and the standalone CLI. This redistributes the existing bootstrap test estimate; size remains 8 and the implementation scope is unchanged.

## Design

### Registration and receiver lifecycle

Add a pure registration/state module at we:scripts/operations/operator-session-registry.mjs and its local filesystem/CLI adapter at we:scripts/operations/operator-session-registry-io.mjs. Store versioned state outside all lane checkouts, beneath the operations home adjacent to the handoff location resolved by we:scripts/operations/handoff-home.mjs. Use a private directory (0700), private records (0600), and the lock/atomic-write helpers in we:scripts/lib/atomic-json-file.mjs; reject symlinks, non-regular records, malformed schemas and paths escaping that directory before invoking those helpers.

A registration contains schema version, session id, opaque account alias (never credentials), host id, feed identity, receiver capability (`monitor-inbox-v1`), quiet-policy snapshot with source, registration generation, registered time, and heartbeat time. Routing identity is the whole tuple, not a display name or session id alone. This is same-OS-user local coordination; account aliases label routing and do not prove provider authentication.

Keep the existing declared bootstrap operation and its GET surface read-only. Extend its plan/formatter to supply a concrete registration command, targeted Monitor command and stage-ack instructions. The standalone bootstrap CLI gets an explicit registration mode requiring session/account identity, which writes the durable record and returns that plan. A fresh session or account switch runs this mode before starting its Monitor. The Monitor runs the new adapter's `listen` verb, proves ownership of the registration generation, emits queued envelopes, and refreshes heartbeat every 30 seconds. Freshness expires at 120 seconds; absent capability, malformed/future heartbeat, wrong host or expired generation makes direct delivery unavailable. These defaults and bounds live in planned we:scripts/settings/operator-session.json, resolved with provenance and exercised by the registry tests.

Only explicit bootstrap registration selects the operator receiver for this host/feed. Repeating the same registration is idempotent; switching identity replaces the active generation atomically. Require the previously observed generation when replacing an existing registration, so racing bootstraps cannot silently steal one another's selection. Heartbeat, listener and acknowledgement calls must match that generation; an old listener cannot resurrect itself. Stop on broken stdout or generation loss. A live listener is transport availability, not proof that the assistant read its output.

### Escalation publication and routing

Keep the needs-you feed as the durable source. Extend we:scripts/operations/needs-you-feed.mjs with versioned escalation envelopes carrying event id, subject identity, producer, timestamp, bounded reason/evidence references, options and suggested pick. Preserve legacy PR events and cursor commands. Support an explicit incident subject key as well as repo/PR/head/kind; #6187 can publish incident evidence without inventing a PR number. Event id includes the publication occurrence, so closing and reopening the same subject is a new ask. Validate complete identity fields before display truncation; long identities must refuse rather than collide. Evidence bodies remain owned by their producer; send bounded, redacted references, not an arbitrary file read or the entire evidence bundle.

Planned we:scripts/operations/escalation-delivery.mjs computes routing and monotonic receipt transitions; we:scripts/operations/escalation-delivery-io.mjs owns durable attempts, targeted inbox writes and the checked desktop adapter. Extend the existing supervised loop in we:scripts/conveyor/needs-you-feed-job.mjs to drain published escalations on every tick, including when the current operator-queue read failed. Both `runOnce` and `publishAttention` therefore reach the same delivery path without changing individual daemon publishers. Existing ordinary feed items remain compatible.

After feed publication, enqueue a direct envelope only for the current fresh capable registration. Record the attempt before advancing the delivery cursor. On missing/stale receiver, failed delivery, or no `received` acknowledgement within 120 seconds, use `notifyDesktopChecked` from we:scripts/conveyor/branch-sync.mjs. Its existing quiet gate holds routine notifications for the digest and preserves emergency breakthroughs. Each delivery drain also calls the existing `flushDigest` with the checked sender, even when there are no new feed events; notification success is required before removing held entries. Direct inbox delivery follows the original brief even during quiet hours; fallback follows the existing quiet policy. Quiet policy is re-read at delivery, not frozen at registration. A held notification is `queued-for-digest`, never `presented` or `decided`.

Drain all committed feed occurrences not yet attempted, using publication order and a durable outbox/cursor transaction. Recover pending attempts after restart even when feed deduplication produces no new line. Recheck generation under lock before enqueue and receipt updates. Do not hold a state lock across an OS notification. Use a bounded attempt lease; an interrupted send is retryable. Delivery is at least once: a crash after emission and before recording success can repeat a notification, but cannot erase the escalation. Deduplicate by event id plus destination generation; account/session switches re-offer undecided items without resetting their event history. A cleared subject stops further prompts but is recorded as cleared, never silently converted to a human decision.

### Three acknowledgements and input boundary

The receiving assistant explicitly acknowledges an event as `received` after reading the Monitor envelope, `presented` after actually showing the evidence/options/pick to the operator, and `decided` only with the operator's recorded choice or a reference to the existing ruling. Stage changes are monotonic, idempotent and generation-scoped. Store actor, account, host, event, stage and time; a new receiver records its own receipt/presentation. Existing decided history survives handoff. A decision receipt records the conversation outcome; it does not authorize a merge, clear a gate or apply the suggested command. The legacy global feed `ack` remains read-position compatibility only and never manufactures stage receipts.

No new HTTP endpoint, port or browser-triggered writer: registration/listening/acks are explicit local CLI verbs. CSRF/origin checks therefore do not apply; keep the read-only operation's HTTP regression. Bound registration/ack JSON input at 8 KiB and envelopes at 16 KiB, reject overflow before parsing, and bound strings/arrays. Rate-limit mutations per host/feed to 60 per minute, stored independently of registration generation; listener heartbeats are coalesced to one per 30 seconds. At most one direct attempt per event/generation and one confirmed fallback per event; failed fallback retries no more than once per existing feed tick. Reject replayed backward stages, foreign generations and reset/delete commands. No register or account-switch action may erase acknowledgements, clear pending deliveries or reset rate counters. Return explicit failure on unreadable/corrupt state, preserving bytes; never treat it as an empty registry with successful delivery.

## MVP

**Must**

- Explicit bootstrap registration plus a targeted, heartbeating Monitor receiver survives restart and account/session replacement. The read-only bootstrap operation remains read-only.
- Every committed escalation remains in the needs-you feed and is offered to the selected live receiver with evidence and a suggested pick. Lack of confirmed receipt invokes checked desktop fallback or the existing quiet-hours digest; no silent loss on transport errors.
- All three acknowledgement stages are durable per item and attributable; legacy cursor acknowledgement cannot masquerade as a decision.
- Invalid identity, corrupt/truncated state, failed writes and oversized input refuse the affected mutation. Source text, docs, configuration, data, titles and evidence are all untrusted display data; none becomes executable shell text or authority to bypass gates.
- Bounded input, persistent throttling, generation checks and no reset verb apply at the actual CLI boundary. Production wiring remains ungraduated until the real Monitor receipt proof below passes.

**Could / already-designed follow-ups:** phone transport and additional assistant receiver adapters. Desktop satisfies the brief's “desktop or phone”; new transports must implement the same identity, receipt and fallback contract. No change to escalation classification, human decision policy or incident evidence generation.

## Test plan

- **Bootstrap:** planned we:scripts/operations/__tests__/operator-session-bootstrap.test.mjs covers the pure operation and formatter, including returned receiver commands and read-only collection. Planned we:scripts/operations/__tests__/operator-session-bootstrap-io.test.mjs covers snapshot reads and real isolated CLI registration, missing identity refusal, repeated bootstrap and account switch. Retain existing read-only assertions in we:scripts/operations/__tests__/needs-you-feed.test.mjs and run we:scripts/operations/__tests__/http-adapter.test.mjs unchanged.
- **Registry/settings:** planned we:scripts/operations/__tests__/operator-session-registry.test.mjs covers identity tuple, generation CAS, future/stale heartbeat, settings bounds/provenance and clock boundaries. Planned we:scripts/operations/__tests__/operator-session-registry-io.test.mjs uses isolated files and child processes for concurrent register/heartbeat/ack, restart, permissions, symlink rejection, corrupt/oversized input and persistent rate limits across switches. Assert refusal preserves existing bytes and does not reset history.
- **Delivery core:** planned we:scripts/operations/__tests__/escalation-delivery.test.mjs covers live/stale/unavailable receiver, lost receipt timeout, account handoff, cleared/reopened subjects, monotonic stages, duplicate/out-of-order/foreign receipts, quiet boundary/DST/toggle and emergency fallback. Inject time; never wait two real minutes in unit tests.
- **Delivery IO:** planned we:scripts/operations/__tests__/escalation-delivery-io.test.mjs exercises real temporary inbox/outbox files and listener subprocess stdout, broken output, bounded JSON parsing, concurrent drains and crash points before/after send/cursor writes. A failed notifier remains retryable; a quiet hold is not receipt; truncated records remain pending with visible error. OS notifications are stubbed here, never sent to the operator by unit tests.
- **Feed/job integration:** extend we:scripts/operations/__tests__/needs-you-feed.test.mjs for legacy compatibility, incident identities, evidence bounds, publication occurrences, incomplete snapshots and immediate/polled publication converging. Extend we:scripts/conveyor/__tests__/needs-you-feed-job.test.mjs to show drain after producer failure, lease loss, restart catch-up and next-tick digest flush even without a new event. Reuse existing quiet-hours tests at we:scripts/lib/__tests__/quiet-hours.test.mjs as regression coverage.
- **Executable acceptance:** the new bootstrap → publish → listener → three receipts → restart scenario must fail against the pre-change implementation and pass after it lands. Run the affected tests and standards check through the host queue. The shell below strips repository locus prefixes only at execution time:

```bash
queue=we:scripts/readiness/heavy-admission.mjs
tests=(
  we:scripts/operations/__tests__/operator-session-bootstrap.test.mjs
  we:scripts/operations/__tests__/operator-session-bootstrap-io.test.mjs
  we:scripts/operations/__tests__/operator-session-registry.test.mjs
  we:scripts/operations/__tests__/operator-session-registry-io.test.mjs
  we:scripts/operations/__tests__/escalation-delivery.test.mjs
  we:scripts/operations/__tests__/escalation-delivery-io.test.mjs
  we:scripts/operations/__tests__/needs-you-feed.test.mjs
  we:scripts/conveyor/__tests__/needs-you-feed-job.test.mjs
  we:scripts/operations/__tests__/http-adapter.test.mjs
  we:scripts/lib/__tests__/quiet-hours.test.mjs
)
node "${queue#we:}" run -- npx vitest run "${tests[@]#we:}"
node "${queue#we:}" run -- npm run check:standards
```

## Proof plan

1. Before production enablement, use an isolated operations state root and a real operator test session with the existing Monitor facility. Register its actual session/account/host, start the emitted listener command, publish one bounded escalation, and retain feed event, generation, receiver output and explicit `received` acknowledgement. A file write or successful child process alone does not pass.
2. Have that session present the evidence and pick, then record `presented`; after the operator supplies a choice, record `decided`. Confirm restart replay preserves all three stages and does not ask again. Keep timestamps and redacted identity evidence; never claim presentation from transport success.
3. Switch to a second session/account, leave the first listener alive, publish another event, and verify only the new generation can receive/ack it. Kill or disconnect the receiver and verify receipt timeout reaches the checked desktop fallback. Exercise quiet mode with an isolated digest directory, then cross configured quiet end and observe the single digest; retain the event if notification delivery fails.
4. Observe a real daemon escalation through the supervised feed job and real receiver. Following we:docs/agent/prototype-based-dev.md, keep this integration parked until that path completes; record PASS/FAIL for feed durability, correct destination, three-stage evidence, fallback and restart recovery. Use a separate observer during the later implementation proof; this preparation does not launch sessions or send notifications.

## Follow-ups

- Phone adapter: use a configured destination and checked provider receipt, preserve the same event id/deduplication and quiet gate. Do not infer phone credentials or expose local state over HTTP in this MVP.
- Additional assistant/remote-host adapters: advertise capability only after a real receipt probe. No background `resume` as a substitute for sending to the selected live conversation. If Monitor cannot deliver to the real operator session, the integration remains ungraduated; choosing a different product transport requires a follow-up decision, not a mocked success.
- #6187 supplies richer bounded incident evidence/options; this card supplies the envelope and routing contract and does not depend on that producer landing first. No blockedBy changes are proposed.

## Non-goals

No autonomous decision-making, automatic execution of suggested picks, changes to human review/merge authority, new incident triage, provider credential storage, phone service provisioning, or fleet-wide receiver election.

## Edge cases this change must handle

1. **Untrusted text:** sanitize and bound all display fields; explicit evidence references only, no shell evaluation or authority from message content.
2. **Truncated reads:** reject incomplete JSON and oversized records; preserve pending events and prior state, report the failed read.
3. **Shared state files:** lock read/modify/write transactions, atomic private files, attempt leases and generation checks; exercise concurrent child processes.
4. **Fail closed:** refuse invalid registration/receipts; failed direct delivery retains the feed event and attempts the established fallback, never claiming acknowledgement.
5. **Identity scoping:** session/account/host/feed/generation must match; no wildcard recipients or cross-account receipt reuse.
6. **State over time:** stale/future heartbeat, restart, DST, cleared/reopened asks and account replacement retain durable history; legacy cursor state is not a decision.
7. **Who wrote it:** preserve producer provenance and receipt actor separately; local account aliases are routing labels, not authenticated human approvals.

revalidated: The diff only changes red-team ruling reason text; the preparation already covers bounded untrusted display fields and feed compatibility, so no design, scope, or proof-plan revision is needed.
