## Standing overlay audit evidence

`daemon-overlay add` and `replace` check the resolved candidate SHA inside the add-guard lock.
`overlaySafety.auditEvidence` resolves standard → platform → tool → environment, defaults to
`refuse`, and logs its effective source. `WE_OVERLAY_AUDIT_EVIDENCE` may only tighten the
resolved mode: env `warn` or `off` over `refuse` is ignored. Loosening takes the platform layer
or the tool settings file. Test fixtures that need the gate off point `WE_PLATFORM_PREFERENCES_FILE`
(the policy cascade's sanctioned test seam) at a file with `{"overlaySafety":{"auditEvidence":"off"}}`;
setting `WE_OVERLAY_AUDIT_EVIDENCE=off` alone does nothing.
`add --check` and `replace --check` run the gate read-only: no registration or override event is
written, and a refusal exits 3.
`--unaudited-reason` requires at least ten trimmed characters and leaves an `unaudited-override`
event. The prototype loader's `--audit-checked-by` marker is provenance, never evidence.
The read-only `scripts/daemon-overlay-audit-check.mjs` inventory checks the current local
`origin/<ref>` tip of each registration; it never fetches. The stored registration SHA is only
reported as `moved-from` when the tip differs or cannot be resolved. A gone ref reports
`sha=unresolved` and fails.
A corrupt state file or any unaudited entry exits nonzero.
The `daemon-overlay-audit-check` and `overlay-audit-evidence` suites run under both node:test and
Vitest; the `daemon-overlay-audit-gate` suite is Vitest-only (it uses `vi` spies and env stubs).

When `prototype-load` creates a behind-main merge commit, it runs a fresh canonical audit on
that exact SHA and re-reads the shared evidence before publishing or registering the generated
ref. An auditor error, missing/corrupt record or unwaived WEAKENED verdict stops publication.
Dry runs create no merge commit and run no auditor. Malformed withdrawal records invalidate
waiver admission in both the prototype loader and standing overlay gate until the request log
is repaired; an independent NOT WEAKENED canonical audit can still qualify.
