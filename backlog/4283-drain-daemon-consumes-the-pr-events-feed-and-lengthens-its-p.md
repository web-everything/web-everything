---
bornAs: xmhyk6a
kind: story
size: 3
parent: "5452"
status: open
dateOpened: "2026-09-27"
tags: []
locus: plateau-app
relatedTo: ["2743", "3070"]
scope: ["we:scripts/lib/pr-event-feed-settings.json", "we:scripts/lib/__tests__/pr-event-feed.test.mjs", "plateau-app:tools/drain-daemon/daemon.mjs", "plateau-app:tools/drain-daemon/lib.mjs", "plateau-app:tools/drain-daemon/lib.test.mjs"]
---

# Drain daemon consumes the PR-events feed and lengthens its poll when healthy

The drain already consumes the persisted dirty-PR feed directly and lengthens healthy sleeps to five minutes. Finish the requested ten-minute safety-net cadence on that existing consumer, and bound recovery when feed health deteriorates during an already-started long sleep. Keep events as wake hints: the drain still owns the lease, rechecks landing gates live and preserves dependency ordering. The remaining settings, sleep integration and regression work is size 3; do not install a second withPrEvents consumer.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/pr-event-feed.test.mjs`: add a regression reading the checked-in drain role settings and asserting mode `on`, 5-second feed polls and `healthyIntervalSec: 600`; it fails against the current 300-second setting and passes after the change.
- [A2] In the drain library tests, inject clock and feed-health changes: healthy/on waits 600 seconds, off/shadow/stale/unreachable retains the configured base delay (60 seconds in the fixture), and a transition away from healthy interrupts/recomputes an existing long wait within one feed poll plus the base interval. Existing failure backoff must never be shortened.
- [A3] A dirty PR wakes an idle drain within one feed poll; repeated marks during a running pass coalesce into one follow-up, survive restart, and are acknowledged only for the processed snapshot. Pause, foreign lease and red-main backoff prevent a feed wake from launching a pass. Exercise the daemon wiring with fake consumer/child boundaries, not only the interval helper.
- [A4] Record an isolated feed-to-drain replay showing event receipt, first eligible pass and gate recheck; report observed latency and forwarding failures rather than reusing historical p50 claims. No production activation or merge is required for this proof.

## Non-goals

- [N1] No new webhook endpoint, review-daemon forwarder, merge authority or drain lock; do not replace the existing cursor/dirty store.
- [N2] No automatic landing based solely on feed payloads and no blanket throttling rewrite.

## Edge cases this change must handle

1. **Untrusted text** — Feed repository, PR and cause text remains data; never interpolate it into shell commands or treat it as a landing instruction.
2. **Truncated reads** — Follow paged feed cursors and retain reset/gap full-sweep behavior; an incomplete page cannot mean no dirty PRs.
3. **Shared state files** — Reuse the persisted consumer snapshot/ack mechanism; concurrent marks must not be erased by acknowledgement of an older pass.
4. **Fail closed** — Failed polls restore the base safety-net cadence; failed gate reads refuse landing, not polling. Corrupt settings do not authorize a longer sleep.
5. **Identity scoping** — Keep cursor and dirty keys scoped to the drain role, repository and PR; changed heads require live gate checks.
6. **State over time** — Health changes during sleep, restart replay, duplicate delivery and a mark arriving during a pass all have explicit regression cases.
7. **Who wrote it** — Trust only the configured authenticated feed as a hint and the live gate evidence as authority; this adds no receive endpoint.

## Grounding

- plateau-app:tools/drain-daemon/daemon.mjs:272 polls the direct consumer; :281 wakes on dirty marks; :831 applies feedIntervalSec to the trailing wait.
- plateau-app:tools/drain-daemon/lib.mjs:1701 lengthens only healthy/on delays; plateau-app:tools/drain-daemon/lib.test.mjs:2006 already covers healthy, shadow, stale and unreachable helper outcomes.
- we:scripts/lib/pr-event-feed-settings.json:1 enables the drain feed with a 300-second healthy interval; we:scripts/lib/pr-event-feed.mjs:69 resolves role settings.
- we:scripts/lib/pr-event-feed.mjs:46 supplies the shared defaults; its cursor foundation exists (commit 3ee54a6218), so the still-open #5501 is not an unmet prerequisite for this remaining work.
