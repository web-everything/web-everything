## Urgent sweep guarded withdrawals

Urgent CI failure and expired-verdict unloads use `retireRegistration` with the library-only
`urgent-failed` mode after `recoverDrops` for the clone. Pass the loaded registration SHA
(`registration.sha`, which may differ from the source SHA) and the observed full entry snapshot.
The normal retirement proof still runs; only `unique-commits-not-on-main` and `pr-open` keep
verdicts may authorize urgent withdrawal, with a matching tracking record, SHA and exact live tip.
Pinned, edge-resolution and unreadable keep verdicts still refuse. Check the registration
`edgeResolution` explicitly before overriding a keep verdict: the planner can return `pr-open`
before inspecting its approved edge. Keep regression cases for changed
entries, moved/unreadable tips, the lock and
persisted drop intent at interruption, and recovery confirming or restoring the drop. The mode
never creates operator retirement evidence. Both CLI `recover-drops` and sweep recovery use the
same locked library helper; recovery failure must prevent retirement and unload receipts.

### Audit-waiver compaction and host preference bounds

New audit waivers belong in the ops JSONL store; legacy platform/tool waivers remain readable.
The audited-tip gate uses the same union as prototype-load. Pruning retains entries on lookup errors;
run `node scripts/operations/ruled-weakened-prune.mjs --dry-run` before applying compaction.
The CLI uses remote heads and local commit objects against `origin/main`; refresh those objects
separately before pruning. New recorder entries carry a repository ownership key derived from
the selected checkout's origin. Pruning only removes entries with that same key; foreign entries
and legacy entries without ownership survive even if their branch is absent or collides with a
local branch. Origin aliases conservatively retain entries, and an unreadable origin retains all.
Legacy ownership is never inferred from a branch name or retroactively assigned by replay;
inspect the original repository before manually retiring those entries.
Host platform-preference reads default to 2 MiB, independently of other
bounded reads. An oversized file names its path and byte count; prune waivers or set
`WE_HOST_OVERLOAD_PREFS_MAX_BYTES` to an explicit larger bound and retry.

Waiver append and pruning share the ledger writer lock, keyed by the store parent's realpath
and filename. Pruning holds it from the initial read through git probes and atomic replacement;
lock contention refuses mutation with retry guidance. The process-interleaving regression in
`scripts/operations/__tests__/ruled-weakened-concurrency.test.mjs` pauses pruning after its snapshot,
proves a concurrent append waits, then verifies the new ruling survives compaction.

Pruning also retains a waiver when either its recorded or current-head net-diff fingerprint is
unavailable. The prune CLI regression injects each missing fingerprint separately and forces
compaction of another entry, proving the retained ruling survives the rewrite. Unknown carry
evidence is distinct from two readable, unequal fingerprints, which still drop a stale waiver.


The repo-owned `scripts/operations/ruled-weakened-record.mjs` replaces approval replay in the
external handoff recorder. Run it from the target repository: it checks current origin heads
with one bounded `ls-remote` lookup and permits older approved heads only with the shared
net-diff carry proof. Approvals supply rulings and `findingsHash` (SHA-256 of
`JSON.stringify(findings)`); the latest canonical WEAKENED audit supplies verbatim findings,
and WITHDRAWN requests veto recording. Replays deduplicate `(repository, ref, sha, ruling)`
inside the append/prune lock. Unreadable evidence refuses writes; inputs above 16 MiB require
archiving old records before retrying. Hermetic recorder proofs live in
`scripts/operations/__tests__/ruled-weakened-record.test.mjs`.

Prototype-load requires a fix-ready record carrying the waiver's ruling and verbatim disclosure
before admitting a canonical WEAKENED audit. A waiver alone refuses and names
`scripts/operations/fix-ready-record.mjs` as the recovery step. These regressions live in
`scripts/operations/__tests__/prototype-load.test.mjs`.
The recorder, store and load gate share the handoff R-number shape, including one lowercase
letter suffix such as `R1063a` and combined rulings joined by `+`.


Carry recording must persist the proof consumed by admission. The recorder's injected
`carries(entry, head)` returns the proven net-diff fingerprint (not just `true`); the CLI
returns it only after the shared `carriesAcross` comparison succeeds. The store accepts and
preserves this optional 64-hex fingerprint, while legacy entries without it remain readable
and malformed fingerprints refuse validation. Exact-head recording also saves available proof
for future rebases. A replay can enrich a duplicate missing that proof only after the current
head, canonical audit and approved verbatim findings validate again. The locked store rewrite
preserves the original approval timestamp, findings and repository ownership; repeated or stale
snapshots do not add duplicate rows. The recorder tests cover readiness before and after an
unchanged rebase, legacy replay, changed code and cross-repository pruning through the real store.
The named `recorder-to-load same-diff waiver
admission` regression records an old approval through the real append/read store path, then
loads the equivalent live head with matching carried fix-ready evidence. It also rejects changed code
and changed canonical findings; an added-count assertion alone does not prove usable carry.
