## Daemon entry import regression

`daemon-entries-import.test.mjs` cold-imports every `DAEMON_ENTRY_MODULES` entry from the
rebuild boot smoke in a separate eval-mode Node child, without invoking daemon main functions.
Keep this in the unit tier: shared-process imports can hide ordering-dependent ESM cycles.
Process liveness helpers shared by drain evidence and review jobs live in the dependency-free
`scripts/lib/pid-alive.mjs`; importing the job store for a helper pulls in dispatch and reconcile.

