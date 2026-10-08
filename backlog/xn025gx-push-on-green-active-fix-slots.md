---
kind: story
size: 5
parent: "5137"
status: open
scope: ["we:scripts/conveyor/fixer-slot-rules.mjs", "we:scripts/conveyor/await-verify-loop.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/dispatch-settings.json"]
dateOpened: "2026-10-08"
tags: []
---

# Push on green within seconds and count only active fixers toward the fix slot

Fixer audit 2026-10-08: ~70% of fixer time idles until a fix-daemon tick (7-30 min apart) pushes the verified commit; finished sessions hold slots ~120 slot-min per 2 h. Slice 2 of the approved fixer proposal (A1 + A2 part 1, rulings P1/P2): a fast local await-verify loop pushes and wakes within seconds of green; a fixer parked on verify gives its slot back and its resume is admitted first; a claim is released as soon as the fixer's completion record says done. Pure rules + declared settings, off = today. Replaced later by the verify-finished / worker-finished events.

## Rules (pure, facts in → decision out — we:scripts/conveyor/fixer-slot-rules.mjs)

- **R1 fix-slot-state** — a session is `active`, `parked` (verify wait recorded, verdict not in) or `resume-owed` (verdict in).
- **R2 fix-slot-count** — parked sessions do not count; owed resumes do (resumes first); live total ≤ `parkedCapFactor` × cap.
- **R3 resume-admission** — owed resumes wake oldest-first while working + woken < cap.
- **R4 push-wake-cadence** — the fast loop runs the verdict pass every `awaitVerifyLoopSeconds`; the tick runs it only when the loop is off or not alive. The push decision stays `classifyAwaitVerdict` (exact verified sha).
- **R5 release-on-completion** — a fix/ci-heal claim is released once its session's completion record says `done`, written after the claim and after the session's last wake-up, same session, no verify wait left.

## Settings (we:scripts/dispatch-settings.json `fixDispatch`; built-in = today = off)

`awaitVerifyLoopSeconds` (WE_AWAIT_VERIFY_LOOP_SECONDS, 0) · `parkedReleasesSlot` (WE_FIX_PARKED_RELEASES_SLOT, off) ·
`parkedCapFactor` (WE_FIX_PARKED_CAP_FACTOR, 2) · `releaseOnCompletion` (WE_FIX_RELEASE_ON_COMPLETION, off).

## Done when

1. **Executable** — `npm run test:unit -- fixer-slot-rules await-verify-loop` passes (replay fixtures from the 2026-10-08 audit).
2. **Live** — on the fix daemon, pushed rows log "pushed Ns after verify finished" under 2 min; finished sessions log "released completed claim" within one loop period; fewer `refused fix-cap` per tick.

## Edge cases this change must handle

1. **Untrusted text** — the pass's own guards are unchanged (exact sha, `lane/*` ref, claim binding, open PR); the loop adds no push path.
2. **Truncated reads** — an unreadable await store makes R2 fall back to the raw claim list (today's count); a missing or stale heartbeat (a cycle that throws, cannot get the lock, or errors on every record) makes the tick run the cycle (R4 fallback); an auth gate that cannot answer defers wake-ups.
3. **Shared state files** — one cross-process cycle lock (dead holder reclaimed by pid) keeps the loop and the tick from acting on the same record at once.
4. **Fail closed** — a wait older than its TTL counts as active (R1); R5 keeps the claim when the status, the claim time or the record time is missing, and the R5 sweep is skipped when the wake journal cannot be read or updated.
5. **Identity scoping** — wait records bind to claims by repo key + PR + kind + session name (or session id); R5 refuses a record from another session id.
6. **State over time** — R5 ignores a completion record written before the claim (a previous round).
7. **Who wrote it** — completion records keep their #4306 ownership rules; R5 only reads them.
