## Red-team planner holds

Planner skips persist a bounded `blockedReason`; test legacy entries without it, restart,
reason changes, and removal on unblock. A CI-recovery head move does not override a later
review hold: the planner's acceptance guard still refuses dispatch. The drain reports the
recorded reason only for the exact repo/PR/head and keeps missing or unreadable evidence held.

A fresh, successful label read matching a pending non-idempotent accept label swap only lets the recovery witness stand in for that exact-head run when every other condition holds (owner death proven, quiet past the abandon horizon, complete scan, confirm accept, no other blocking run, not retryable); dispatch still passes the owner-death and recovery guards, and the drain is unchanged.

The recovery path makes five fresh label reads: dispatch, abandon, the production
`readRedTeamOnlyPayload` witness, admission, and queued-writer readback. Assert the
exact count through the real path, with `noMemo:true` and a timeout on every probe.
The applied-swap soak fixture injects its label probe into status-label sync as well;
that separate status IO must never reach live GitHub in a hermetic run.
