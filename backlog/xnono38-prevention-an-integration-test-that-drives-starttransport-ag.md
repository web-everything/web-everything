---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/diagnostics/transport.ts", "we:src/wip/wip-agent.ts", "we:src/wip/wip-read.ts", "we:wip-relay.js", "we:src/wip/agent-broadcast.ts", "we:scripts/lib/intake-config.mjs", "we:src/diagnostics/scrub.ts", "we:src/wip/glance/glance-mount.ts", "we:src/wip/request-advance.ts", "we:src/wip/glance/glance-view.ts", "we:src/diagnostics/__tests__/transport.test.mjs", "we:src/wip/__tests__/wip-agent.test.mjs", "we:src/wip/__tests__/wip-read.test.mjs", "we:./__tests__/wip-relay.test.mjs", "we:src/wip/__tests__/agent-broadcast.test.mjs", "we:scripts/lib/__tests__/intake-config.test.mjs", "we:src/diagnostics/__tests__/scrub.test.mjs", "we:src/wip/glance/__tests__/glance-mount.test.mjs", "we:src/wip/__tests__/request-advance.test.mjs", "we:src/wip/glance/__tests__/glance-view.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — An integration test that drives startTransport against the real WipRelay.fromPage rate limiter with a mul… (from plateauapp/plateau-app#202 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/diagnostics/transport.ts:58` — An integration test that drives startTransport against the real WipRelay.fromPage rate limiter with a multi-chunk backlog; or have the transport self-pace to the relay's budget (at most 3 sends per 10 s).
2. `we:src/wip/wip-agent.ts:339` — Run `emitAll` with `Promise.allSettled`, or fire each feed with `void`. Add a wip-agent test with one hanging feed asserting the others still emit.
3. `we:src/wip/wip-read.ts:620` — Pass the same overlay into the full read's `readPrFlow`, or have the page keep the newer of the snapshot and delta values by source time. Add a glance-live-delta test: delta, then a snapshot with older prFlow, asserting the delta value survives.
4. `we:wip-relay.js:870` — Add a per-row validator for `prs` in the relay (int `n`, `tone` from a fixed set, bounded strings). Add a table-driven test that sends a hostile value in every field of every `DELTA_TOPICS` entry. A lint rule against unescaped `${…}` in `glance-*.ts` templates would also cover the renderer side.
5. `we:src/wip/agent-broadcast.ts:38` — Add a contract test here that fails if the hook is absent or no longer wraps messages. Alternatively, reword the PR text to 'best-effort refusal here, information-only framing in the hook'.
6. `we:scripts/lib/intake-config.mjs:28` — Default `autoFile` to false (propose, then wait for 'go ahead'), or default `clearForConveyor` to false. Document in the PR that the relay login is the only gate for unattended builds.
7. `we:src/diagnostics/scrub.ts:7` — Extract the shared rules while retaining adapter-specific limits and the blobs option; file a deterministic check:standards rule requiring both adapters to import the canonical policy rather than redeclare it.
8. `we:src/wip/glance/glance-mount.ts:200` — Add a deterministic integration test covering both arrival orders with conflicting PR statuses and source timestamps, and require per-topic freshness checks.
9. `we:src/wip/request-advance.ts:57` — Add a deterministic restart test that skips the open-PR observation and requires recovery from durable merged-PR or card evidence.
10. `we:src/wip/glance/glance-view.ts:78` — Preserve repository-qualified PR identities and add a deterministic collision fixture covering PRs, jobs, and chains.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#202@418001a3de017f1d1c7b9fd7cc2b89a334a95f49

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
