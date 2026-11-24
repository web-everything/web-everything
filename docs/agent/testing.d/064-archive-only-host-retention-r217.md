## Archive-only host retention (R217)

`scripts/lib/archive-retention.mjs` uses the run store's shared directory resolver without triggering
legacy migration; `OPERATION_RUNS_DIR` wins. Tests use temporary source, Drive and stamp roots.
Run the archive-retention and archive-retention-tick fixtures through heavy admission. Real `tar`
creation/listing proves the happy path; injected post-bundle changes prove truncation, size/count
mismatch and concurrent-source protection. The Drive root must already exist. Never create a local
fallback archive or remove originals when Drive verification fails. An oversized scan retains all
sources and asks the operator to split the source or inspect and raise the scan bound. Stale lock
recovery requires operator inspection, never automatic lock stealing. Archives have no expiry.
The CLI defaults to both kinds; `--dry-run` creates no archive or stamp. Settings live in
`scripts/settings/archive-retention.json` and resolve through the shared policy cascade with sources
included in results and logged by the CLI/health-watch. Host health ticks invoke both kinds; fixture,
dry-run and redirected ticks skip retention. Each kind serializes with a lock and uses a 24-hour stamp.

A durable per-kind manifest beside the stamp records source-relative paths, size, mtime and
identity/ctime for verified bundles, scoped to the source and Drive paths. Retained unchanged
sources are skipped even after stamp expiry; changed sources and session companions remain eligible.
The manifest is read under the invocation lock and atomically replaced after bundle verification,
before source removal or stamp publication. Dry-run reads it without writing state. Invalid or
oversized manifests fail closed and ask the operator to inspect or restore the manifest; the read
and write limits are 128 MiB and `maxFiles` entries. Regression fixtures cross stamp expiry for both
kinds, change size/mtime or restore mtime after a same-size edit, and retry failed verification or
manifest publication. Existing bundles from before manifest tracking cannot be deduplicated by it.

The archiver's invocation lock serializes archivers only; it does **not** exclude run-store or
Claude writers. A stat/unlink pair cannot safely reclaim a mutable source. Source removal therefore
requires the injected `withSourceWriterExclusion(path, criticalSection)` provider to exclude **all**
writers, including already-open file descriptors and atomic replacements, throughout final identity
verification and unlink. The provider must await the critical section and leave it uncalled when
exclusion is unavailable. No production provider exists for Claude's external transcript writers;
the CLI and daily health-watch archive but retain originals, report `filesRetained` and an operator
fallback, and claim zero reclaimed bytes. Do not enable reclamation with a policy flag or quiet-time
heuristic. The operator must arrange actual writer exclusion before reclamation can be wired in.
Regression tests append in the final-stat/removal interval, hold an open transcript descriptor, test
unavailable exclusion, and queue a cooperating writer through the same exclusion used by removal.

### Security condition test shape

Every new bypass-widening condition needs one negative test per conjunct. Security
checks must not be hidden behind `!testRoot` guards; inject identity, ownership,
and other system evidence so hermetic tests exercise the production checks.

Security review checklist: for each new `localFallback(` call site under
`scripts/readiness/`, require a named negative test that reaches that call site,
asserts no remote dispatch, and checks the fallback reason. For a guard after a
wait, occupy capacity, change the evidence during the wait, and release capacity;
pin the expiry boundary and reservation cleanup as well as the refusal.

Standards-conformance review checklist: when remote execution consumes a gate's
output string to detect incomplete inputs, require a producer-side test that runs
the gate's emitting code with a skipping checker and asserts the warning. Test
stdout and stderr, successful non-skipping output, and failed checker output;
injecting a string only into the remote consumer does not cover the producer.

Writer guards shared by root cron and operator controllers must stay on one
private inode owned by the operator. Test first-use creation and migration of
existing root-owned guards, retaining mode 0600 and inode identity. The worker-pool
suite models ownership transfer on unprivileged hosts and includes a Linux/root
integration case that runs prune as root then reserves every slot as the operator.

### Remote diff coverage inputs

Legacy remote coverage fixtures must create the ignored `coverage/coverage-final.json` locally,
then assert its manifest digest and snapshot bytes. Preserve source mtimes through staging
and full shipping so the freshness guard retains local semantics; warm delta assembly
recreates mtimes. Compare coverage scope with an explicit `DIFF_COVERAGE_BASE`, including
a clean HEAD whose changes exist only relative to that base. Invalid refs fall back locally.

The tracked `.claude/agent-memory` bridge is verified against its index blob and
projected from `agent-memory-src/` into regular snapshot leaves. Require `MEMORY.md`
and the complete target corpus; reject unsafe links or incomplete inputs before
transfer. These projected inputs require full shipping.

For legacy remote `check:standards`, observe both output streams for skipped gates,
`no-scope`, and `ENOENT`. A matching protected completion receipt permits a failed
remote result to fall back through local admission; an invalid receipt keeps the
result unconfirmed. The single standards input parity test in `remote-exec.test.mjs`
compares local and shipped discovery of the base, coverage report, and memory index.

