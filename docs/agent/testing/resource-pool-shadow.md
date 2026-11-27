## Resource pool shadow observation (R1094 S1a)

### Collector and shadow rows

`scripts/lib/resource-pool-io.mjs` exports the unwired, observe-only
`collectResourcePool` and `appendShadowRows` helpers. Legacy admission remains
authoritative; nothing reads `pool-shadow.jsonl` to grant capacity.

The collector checks every named source in `SOURCES`. A throwing (including a
non-Error throw), missing, malformed, wrong-source or invalid-budget source
makes the entire report `unknown` and holds every pool decision. Unknown
settings do the same. Inspect the failed source and repair it before rerunning;
incomplete evidence never means an empty, safe pool. Collection writes nothing.
A fix job is counted once per repo/jobId across claims and workers; unidentified
jobs stay separately counted and identical jobIds in different repos stay distinct.

Every report contains exactly one comparison row per kind, in this order:
`review`, `redTeam`, `fix`. Rows include `poolDecision`, `legacyDecision` from
`admit()`, `reason` and `unknown`. A throwing legacy comparison becomes
`legacyDecision: 'unknown'` without changing the pool decision, reason or pool
evidence's `unknown` flag. Injectable readers, settings, legacy admission, host,
coordination root and clock keep tests independent of the host.

`appendShadowRows` appends through `appendResourceLog` to
`<coord>/resource/pool-shadow.jsonl`; its byte cap may rotate the ledger. Mode
`off` appends nothing and returns false. A sink failure returns false without
throwing or attempting later rows; callers must report that failure. Collection
and appending are separate: S1 adds no callers in admission or CLI paths.

The collector unit tests pin closed inputs, exact kinds, three persisted rows,
deduplication, read-only collection and sink failures. The hermetic
`resource-pool-live-fix-workers` soak replays a leased fixer with no claim or
heavy slot, duplicate slot evidence, unreadable inventories and recovery as a
ci-healer. It checks the persisted timeline as well as C3's 2u observation.
Run `scripts/lib/__tests__/resource-pool-io.test.mjs` through heavy admission;
run `scripts/conveyor/soak/breaks/resource-pool-live-fix-workers.soak.test.mjs`
through the same queue with `--config vitest.soak.config.ts`.
