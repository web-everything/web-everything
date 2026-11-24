## Urgent unload adoption

An urgent CI removal persists `unloaded-pending-adoption` before emitting its unload event and
escalation. It remains tracked until the registration is absent and Git in the daemon clone proves
`git merge-base --is-ancestor <failed-sha> HEAD` exits 1. Only then write `unloaded-adopted`.
Historical `settled-unloaded` receipts resume adoption checks using their removal timestamp.
Unknown ancestry or timestamps escalate and stay tracked. After 15 minutes from removal, a HEAD
still containing the SHA with no registration raises a separate last-good-build NEEDS-YOU packet,
deduplicated through a persisted flag per load identity (including tracking ID). Later passes still
check adoption. Keep grace, adoption, legacy receipt, closed-path and dedupe regressions in
`scripts/operations/__tests__/urgent-sweep.test.mjs`; run it and the conveyor tick suite via heavy admission.

Unload receipts checkpoint `unloadEventSent` and `unloadEscalationSent` separately after each
successful sink write. Failed notifications retry on later sweeps even after `unloaded-adopted`,
and do not prevent adoption checks or the other notification. A failed progress write allows
redelivery (event delivery is at least once); escalation IDs stay stable. Legacy `settled-unloaded`
receipts already followed both notifications; pending/adopted receipts missing progress retry them.
Named fault-injection tests cover each sink failure and each progress-write interruption.


