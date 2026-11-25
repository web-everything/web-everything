## Drain startup sibling provisioning

`scripts/lib/sibling-clone-provision.mjs` checks the drain checkout’s `../frontierui` and
`../plateau-app` even when its pool has no PORT_BANDS entry. Startup repairs absent paths once
per process; dry runs only log status. Existing paths are never reset, deleted or repaired.
A failed clone leaves the drain lookup fail-closed; the operator repairs the sibling and restarts.
The hermetic regression is `scripts/__tests__/sibling-clone-provision.test.mjs`: use a task-temp
directory, an injected home and a fake synchronous clone runner, never a real daemon pool or network.

Drain CLI fixtures must also own the parent of their checkout: put the checkout in a nested
temporary directory so startup never provisions into a shared temporary root. Local-only prestage
fixtures provide existing non-repository sibling paths, preserving refusal without launching clones.
Merge-queue fixtures provide synthetic sibling metadata and return each sibling's canonical origin
from its working directory; reusing the local checkout's origin correctly fails validation. Keep
these fixtures independent of host checkout symlinks and retain the downstream merge/hold assertions.
