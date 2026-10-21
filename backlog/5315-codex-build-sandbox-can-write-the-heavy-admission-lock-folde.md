---
bornAs: xuxheus
kind: story
size: 2
status: open
scope: ["we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Codex build sandbox can write the heavy-admission lock folder (and impl-lane acquire waits)

The requested narrow writable grant for we:.lanes/.admission/heavy and bounded implementation-lane acquisition are already present in this checkout. Keep this card as a stale-premise review, not a mandate to widen permissions again.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs` — existing test `CODEX_PROVIDER: the ONLY writable grant added for the heavy queue is the admission lock folder (operator ruling 2026-10-07)` checks ordinary, cross-repo and resume launches for one exact admission-root grant and no broader permission.
- [A2] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs` — the acquireImplLane assertion at we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:3212 requires `--wait-ms=60000`. These are existing regression checks, not a newly failing acceptance test: the premise is stale. Sandbox argv assertions alone do not prove live sandbox writability.

## Non-goals

- [N1] No new write roots, sandbox bypass, queue-capacity change or unbounded lane wait; no new implementation without a distinct remaining defect.

## Edge cases this change must handle

1. **Untrusted text** — Derive the grant from admissionLockRoot, not worker prompt text.
2. **Truncated reads** — n/a: root construction and bounded acquire arguments do not consume partial streams.
3. **Shared state files** — Grant access only to the shared admission folder; retain queue locking and lane ownership.
4. **Fail closed** — Retain sandbox enforcement; acquisition failure must not continue with an unowned implementation lane.
5. **Identity scoping** — Cross-repo spawn and resume preserve WE lane identity alongside the implementation cwd.
6. **State over time** — Keep the admission grant on resume and the 60-second acquire bound; no retry loop with unlimited waiting.
7. **Who wrote it** — The existing operator ruling authorizes the narrow grant, not a worker request. No network endpoint changes; HTTP abuse controls are inapplicable.

## Grounding

- we:scripts/operations/deliver-item-wrapper.mjs:875 defines the 60-second bound and line 898 passes it to acquireLane.
- we:scripts/operations/deliver-item-wrapper.mjs:1441 adds admissionLockRoot(lanePath) to writable roots.
- we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:802 tests exact writable grants; line 3212 pins the acquire wait.

## Open questions

STALE: both requested changes already exist. Should this card be closed as shipped, or is there a separately observed sandbox failure with a reproducible launch? That distinction blocks new implementation; the existing argv tests do not establish a live Codex sandbox probe.
