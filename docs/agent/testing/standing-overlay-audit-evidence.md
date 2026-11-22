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
