---
bornAs: xpj9fhk
kind: story
size: 3
status: open
scope: ["we:skills-src/conveyor/pass-daemon.mjs", "we:skills-src/conveyor/__tests__/pass-daemon.test.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs", "we:scripts/conveyor/health-smells/daemon-process-before-adoption.mjs", "we:scripts/conveyor/health-smells/__tests__/daemon-process-before-adoption.test.mjs", "we:scripts/conveyor/__tests__/health-watch-core.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-12"
preparedAgainstSha: "4ac28cbadea0a2519698e37b9930486872e71d83"
tags: []
---

# Pass daemons self-sync onto adopted code like the other daemons

Enable pass-daemon self-sync by default through the existing policy cascade, preserving the shared adoption/restart safeguards, and expose a health smell when a running daemon predates its clone's latest adoption. Held finding 215 reported ten pass daemons running pre-86da0b452 code for twenty hours on 2026-10-10 and writing as the operator. That historical incident is motivation, not a live observation made during this preparation.

## Progress

- Original premise/scope: `WE_PASS_DAEMON_SELF_SYNC` defaults off; change only we:skills-src/conveyor/pass-daemon.mjs and we:scripts/conveyor/health-watch-core.mjs. Corrected premise: the existing switch is `PASS_DAEMON_SELF_SYNC`, and only literal `1` or a nonblank `DAEMON_SELF_SYNC_BRANCH` enables it (we:skills-src/conveyor/pass-daemon.mjs:79-99). The requested `WE_` name is a new canonical override, not an existing setting. Default-off behavior is explicitly tested at we:skills-src/conveyor/__tests__/pass-daemon.test.mjs:160-176, so the goal is not already delivered.
- Restart, lease release, main-only protection and version-pinned child execution already exist at we:skills-src/conveyor/pass-daemon.mjs:341-380. The per-spawn authentication environment correction is already present at we:skills-src/conveyor/pass-daemon.mjs:369-374; this item enables code adoption, not another authentication rewrite. Shared restart logic deliberately considers imported-file changes and debounce (we:scripts/lib/daemon-self-sync.mjs:703-711); process age alone is a health observation, not proof of obsolete loaded code or wrong credentials.
- Corrected scope: smells are discovered as modules at we:scripts/conveyor/health-smells/index.mjs:10-18, not implemented in the generic core. The health shell drops clone identity and lacks process-start time at we:scripts/conveyor/health-watch.mjs:403-424. Adoption time is already exposed at we:scripts/conveyor/health-watch.mjs:454-478. Add the missing IO evidence and a new pure smell; no production core change is needed. Include core episode tests to verify recovery and unknown-probe behavior.
- Size changed from 2 to 3: estimated touch set is seven files, approximately 350 changed lines: daemon 65 + daemon tests 90; health shell 65 + shell tests 65; new smell 30 + smell tests 25; core episode tests 10. Evidence for the wider touch set is the missing probe fields and separate smell registry cited above. This remains a story; no task-only `estimatedLoc` is added. No blocker change is proposed. Preparation does not stamp or execute deployment.

## Design

1. In we:skills-src/conveyor/pass-daemon.mjs, use `cascadePolicy` from we:scripts/lib/policy-cascade.mjs:184 for a boolean `passDaemonSelfSync` policy with standard default `true`, platform preference, optional tool value, then env override. Keep the helper injectable for tests. Introduce `WE_PASS_DAEMON_SELF_SYNC` as the canonical env name; accept boolean spellings `1/0`, `true/false`, and `on/off`. A valid canonical value wins; otherwise preserve legacy `PASS_DAEMON_SELF_SYNC=1` and nonblank POC-branch opt-in as compatibility inputs before falling through to policy layers. Legacy `0` must not defeat the existing POC opt-in. An explicit canonical false disables the wrapper even with a POC branch. Invalid values use the cascade's lower-layer fallback and diagnostic rather than JavaScript truthiness. Use its existing source log; no new platform default file is necessary.
2. Wire the resolved setting to the existing wrapper at we:skills-src/conveyor/pass-daemon.mjs:376. Preserve main-only POC refusal, guarded adoption, per-tick version roots, restart debounce/import-closure rules, independent heartbeat, and lease release. No in-flight child is interrupted to adopt code. The underlying shared wrapper remains the authority for whether a change requires restart, including documentation/config/data changes.
3. Extend we:scripts/conveyor/health-watch.mjs with a bounded, injectable process-age probe over the declared daemon inventory. Reuse inventory clone and rebuild state (already returned at we:scripts/operations/daemon-status-io.mjs:560-565). Obtain the live PID from the inventory lease, with a bounded launchctl lookup for running jobs without leases, and obtain its actual start time with a bounded `ps` argv call; never substitute heartbeat or commit time. Correlate by daemon label plus canonical clone identity, not basename. Preserve unknown status for missing PID, unreadable clone/state, invalid timestamps, vanished/reused PID or failed/truncated command output. Validate PID identity around sampling. Fixture ticks must use injected data and must never probe the host implicitly.
4. Add we:scripts/conveyor/health-smells/daemon-process-before-adoption.mjs, automatically discovered, consuming the new probe. For a confirmed live process, breach when process start is strictly earlier than a valid, non-future adopted timestamp. Use a stable daemon-label-plus-clone subject, medium severity, alert action, two breaching samples to open and two confirmed clean samples to close. Include PID, start time, clone, adopted SHA/time and age in evidence. A restarted process or confirmed stopped job clears the condition; unknown readings do not close it. Keep existing shadow-mode notification policy. The message says “process predates adoption”; it does not assert that irrelevant changes require restart or that authentication is wrong.

## MVP

- Default-on policy resolution and compatibility handling reach the real pass wrapper, with existing restart/lease cleanup intact.
- The health tick supplies correlated process/adoption evidence for declared resident daemons, including pass daemons and jobs without leases; one discovered smell reports the condition through existing episodes and reports.
- No new updater, force restart, authentication policy, rebuild mechanism, registry list, or notification-policy change. No HTTP/write endpoint is introduced, so request body caps, CSRF and endpoint rate limits are inapplicable.

## Done when

- With all self-sync overrides unset, a pass uses the shared wrapper and a relevant adopted change causes restart between passes; an explicit canonical off override preserves the unwrapped execution path.
- Failed adoption never runs an unapproved candidate. Main-only passes cannot adopt POC/overlay code. Docs, config and data retain the shared wrapper's existing change classification and smoke checks.
- A fixture daemon predating adoption opens an evidence-bearing episode; a replacement process closes it after confirmed clean samples; missing evidence leaves the episode unchanged.
- The queued tests in the test plan and the runner-owned standards gate pass. A controlled runtime proof demonstrates restart and lease reacquisition before rollout is claimed successful.

## Test plan

- Extend we:skills-src/conveyor/__tests__/pass-daemon.test.mjs: unset defaults on; all cascade layers and logged sources; canonical on/off and invalid values; legacy and POC compatibility; main-only refusal; default-enabled wiring to the actual wrapper; adoption restarts before another child runs; lease cleanup and heartbeat lifecycle; auth refreshed per spawn; unchanged or rejected adoption retains existing behavior. Exercise docs/config/data and debounce through the shared wrapper rather than creating a second classifier.
- Extend we:scripts/conveyor/__tests__/health-watch.test.mjs: injected inventory/process/state correlation, multiple clones and passes, lease-free PID lookup, bounded command failures, malformed/truncated reads, disappearing/reused PID, version-folder identity, unknown adoption times, and fixture isolation. Verify the actual tick populates the declared probe, not only an isolated helper.
- Add we:scripts/conveyor/health-smells/__tests__/daemon-process-before-adoption.test.mjs: before/equal/after adoption, future/invalid dates, independent subjects, confirmed stopped/restarted processes, and unknown inputs. Extend we:scripts/conveyor/__tests__/health-watch-core.test.mjs with the real smell for two-sample opening/closing and unknown samples preserving the episode.
- Run each file through we:scripts/readiness/heavy-admission.mjs using its `run -- npx vitest run` argv, with the selected test path relative to WE. The runner owns stamping and checks, including queued `npm run check:standards`; no bare test commands.

## Proof plan

Use an isolated disposable daemon clone and a harmless fixture pass, with fake/injected auth and no GitHub writes. Start under a restart-capable supervisor with the setting unset, record PID, boot SHA and lease owner, and hold one fixture pass in flight while a relevant candidate is adopted using the existing mechanism. Observe that the child finishes on its pinned tree, the old daemon releases its lease and exits between passes, and the replacement acquires the lease and runs the next pass on the adopted tree. Capture the policy source log and restart log. Repeat with canonical off to demonstrate the override, and with rejected adoption to demonstrate last-good behavior. Feed matching before/after process observations through the health tick into a disposable state root and inspect the rendered episode, unknown-read preservation, and recovery. This is a future implementation proof, not a claim that production daemons were inspected during preparation.

## Edge cases this change must handle

1. **Untrusted text** — treat process labels, paths and state as data; use argv subprocesses, bounded output and existing report escaping/scrubbing; never shell-interpolate them.
2. **Truncated reads** — invalid process/adoption evidence is unknown, never a fabricated start time or healthy sample.
3. **Shared state files** — health is read-only over adoption/lease state; keep existing atomic report/state persistence and ownership-checked lease release.
4. **Fail closed** — keep shared smoke/adoption refusal; invalid settings follow validated cascade fallback; unavailable probes cannot establish recovery.
5. **Identity scoping** — correlate daemon label, live PID/start and canonical clone, including lease-free jobs and multiple passes sharing a clone.
6. **State over time** — sample hysteresis tolerates normal between-pass delay; preserve shared restart debounce and import relevance; age evidence does not prove stale loaded modules.
7. **Who wrote it** — leave per-spawn App environment refresh unchanged; no credentials enter health evidence and no diagnostic performs GitHub writes.

## Follow-ups

After implementation proof, the operator must bootstrap existing old processes onto the delivered version once: code that never self-syncs cannot load its own fix without a restart. Observe subsequent relevant adoptions and the new health episodes before claiming fleet convergence. Any expansion of notification policy, automatic remediation, or authentication fallback changes is separate work and is not needed to complete this item.
