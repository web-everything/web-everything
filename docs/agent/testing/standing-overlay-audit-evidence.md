## Standing overlay audit evidence

`daemon-overlay add` and `replace` check the resolved candidate SHA inside the add-guard lock.
`overlaySafety.auditEvidence` resolves standard → platform → tool → environment, defaults to
`refuse`, and logs its effective source. `WE_OVERLAY_AUDIT_EVIDENCE=warn|off` is an explicit
operator policy override; historical conflict/replace fixtures set `off` in their own environment.
`--unaudited-reason` requires at least ten trimmed characters and leaves an `unaudited-override`
event. The prototype loader's `--audit-checked-by` marker is provenance, never evidence.
The read-only `scripts/daemon-overlay-audit-check.mjs` inventory uses the registered SHA first,
then local remote-tracking refs for old registrations; it never fetches. A corrupt state or
unresolved SHA exits nonzero. The three `overlay-audit-*` suites support both node:test and Vitest.

When `prototype-load` creates a behind-main merge commit, it runs a fresh canonical audit on
that exact SHA and re-reads the shared evidence before publishing or registering the generated
ref. An auditor error, missing/corrupt record or unwaived WEAKENED verdict stops publication.
Dry runs create no merge commit and run no auditor. Malformed withdrawal records invalidate
waiver admission in both the prototype loader and standing overlay gate until the request log
is repaired; an independent NOT WEAKENED canonical audit can still qualify.
