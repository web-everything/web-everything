## Stranded record recovery

### Ownership
Only a run whose stamped same-host owner handle is provably dead is resumed automatically; unstamped runs are never resumed.
The stamp is `{host, namespace, pid, procStart}`. Both namespaces must be non-null and equal; unknown identity refuses.

### Exclusive takeover
Recovery drives a run only while holding its exclusively created claim and after compare-and-swapping the dead owner for itself.
The sweep creates a random-token handoff under `withFileLock`. The loop swaps it once with `--claim-token`; release checks both holder and token. A handoff expires only after ten minutes; a process holder is replaceable only on proven death.

### Resume-only refusal
A pinned recovery that fails any precondition exits refused with zero panel calls, at most `RESUME_MAX_ATTEMPTS` times.
`--resume-run` pins the job; `--resume --resume-only` pins the loop. No failed check sends the pending effect again. Exhausted or unreadable evidence requires operator inspection and `--settle-applied --actor --reason` when evidence can be proven.

### Applied evidence
A pending non-idempotent effect becomes applied only when its sink's own check finds exactly this attempt's trusted marker and its full end state.
Identity is `review-attempt: <owner>/<repo>#<pr>/<runId>/<effectKey>/<attempt>`, with the persisted pre-send attempt starting at one. Complete comments, an open PR on reviewedHead, the added label, and absence of every removed label are required. Exactly one marker occurrence in exactly one trusted comment must match. Incomplete pagination refuses with operator inspection as fallback.
Only operator settlement of legacy unstamped accept runs substitutes exactly one trusted accept with reviewed-sha created at or after lastAttemptAt. Successful settlement records actor and reason; counters and original findings stay intact.

Discovery checks at most sixteen eligible candidates and dispatches at most one job per sweep. Exceeding discovery or comment bounds retains the pending effect and calls for operator inspection.

Real-process claim probes require readable process birth evidence (`ps`). A sandbox denying it must retain claims and fail the positive recovery tests; never replace a missing birth stamp with an invented one. Unknown birth evidence is stamped as an empty string and cannot prove a dead owner.

The scoped recovery suites cover ownership, claims, refusal, attempt budgets, marker rendering and complete evidence. The orphan soak covers a grandchild posting after a failed check. Live graduation remains PENDING until a stamped eligible case is observed through reconciliation and independent red-team completion; the legacy incident is not that proof.
