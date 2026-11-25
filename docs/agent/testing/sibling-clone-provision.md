## Drain startup sibling provisioning

`scripts/lib/sibling-clone-provision.mjs` checks the drain checkout’s `../frontierui` and
`../plateau-app` even when its pool has no PORT_BANDS entry. Startup repairs absent paths once
per process; dry runs only log status. Existing paths are never reset, deleted or repaired.
A failed clone leaves the drain lookup fail-closed; the operator repairs the sibling and restarts.
The hermetic regression is `scripts/__tests__/sibling-clone-provision.test.mjs`: use a task-temp
directory, an injected home and a fake synchronous clone runner, never a real daemon pool or network.
