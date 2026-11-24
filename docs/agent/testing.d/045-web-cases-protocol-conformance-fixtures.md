## Web Cases — protocol conformance fixtures
"Web Cases" are the source of truth for protocol conformity: live documentation examples **and** input fixtures for E2E conformance testing.
- **Directory**: `src/cases/<protocol-id>/`
- **Naming**: ordered — `01-registry-standard.html`, `02-edge-case.html`.
- **Format**: raw HTML fragments. ❌ No `<html>`/`<body>`/`div.wrapper`. ✅ Only the directive/component and its direct children.

**Mandatory coverage per protocol:**
1. **Registry Standard** — happy path using valid registry defaults.
2. **Visual Overrides** — inline slot/template customization.
3. **Parameterization** — passing args via attributes (`args-*`).
4. **Reliability** — error handling, timeouts, forgivable failures.
5. **Deferred/Lazy** — interaction with the loading/visibility Intent.

### Stale-state inventory

`node scripts/operations/run.mjs stale-state --json` inventories this checkout's active/preparing
backlog claims, its repository lane pool, and the configured operation run store. Read
`verdict.records` together with `verdict.gaps`; a failed source enumeration is never an empty-source
claim. Corrupt run records remain visible as unknown. Lane status preserves lease read/parse failures
as `readError`; the inventory retains each such lane as a lease record with unknown owner liveness.

`pidAlive` records the current probe of the recorded PID; `ownerPidAlive` drives the verdict.
The lease `pid` is the acquire CLI, not the agent, so leases without a durable `agentPid` have unknown
owner liveness even if their recorded PID is dead. Probes reuse `reconcile-pass.mjs#probePid`;
null/invalid PIDs and foreign-host PIDs remain unknown. TTL and run completion never prove death.
Claims do not normally record an owner or PID; the report preserves that missing evidence as null.

`hasUnsafeWork` reuses lane status cleanliness and supplements it with a read-only count of commits
absent from the verified expected branch and main origin refs. Dirty status or a positive ahead
count reports true. A zero local ahead count reports null with a publication reason: even these
expected tracking refs are lane-writable and cannot prove publication. This reader never reports
false, whether fresh or cached; destructive actions require `guardLaneAction` with fresh trusted
publication evidence. Unassociated claims/runs have null work safety.
Age is milliseconds since the recorded acquisition/start time, or null when missing/unreadable.

The CLI normally persists runs and call telemetry even for compute-only operations. This inventory
uses the existing memory run store and omits the optional call logger to honor its zero-write contract.
All child git reads inherit `GIT_OPTIONAL_LOCKS=0` so status does not refresh an index. Cleanup stays
with supported manual lifecycle commands; never edit lease/claim files by hand.

