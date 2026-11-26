## Drain startup sibling provisioning

`scripts/lib/sibling-clone-provision.mjs` checks the drain checkout’s `../frontierui` and
`../plateau-app` even when its pool has no PORT_BANDS entry. Startup repairs absent paths once
per process; dry runs only log status. Existing paths are never reset, deleted or repaired.
A failed clone leaves the drain lookup fail-closed; the operator repairs the sibling and restarts.
The hermetic regression is `scripts/__tests__/sibling-clone-provision.test.mjs`: use a task-temp
directory, an injected home and a fake synchronous clone runner, never a real daemon pool or network.

Acceptance evidence must identify a named test or a recorded live check for every item:

| Acceptance | Evidence |
| --- | --- |
| Tier-1 missing clone, alias, failure reason, existing paths untouched | `sibling clone provisioning` and `sibling clone audit boundaries` suites |
| Startup dry-run, test isolation, once per process, lease refusal | `main sibling provisioning lifecycle` suite |
| Live drain missing frontierui, plateau-app present, then PR 53 routed after load | `liveDrainProvisionsFrontieruiAndRoutes53` observations below; pending until both are recorded |

Vitest setup sets `WE_UNDER_TEST=1` and `WE_TEST_HERMETIC=1`, inherited by spawned CLIs.
Either marker (including CLI fixtures that clear `WE_UNDER_TEST`) makes startup
provisioning status-only even without `--dry-run`, and logs the marker as the reason.
The `main sibling provisioning lifecycle` tests execute the real entry point through the
CLI harness. They assert zero clones for marked test CLIs and explicit dry runs, one
provision call across repeated main calls without resetting modules, and zero calls on lease
refusal. Their injected clone runner and private parent exercise production mode safely by
omitting the marker. The throwing-logger test pins continued processing of both siblings.

Drain CLI fixtures that deliberately exercise provisioning must also own the parent of their
checkout: put the checkout in a nested temporary directory. Local-only prestage
fixtures provide existing non-repository sibling paths, preserving refusal without launching clones.
Merge-queue fixtures provide synthetic sibling metadata and return each sibling's canonical origin
from its working directory; reusing the local checkout's origin correctly fails validation. Keep
these fixtures independent of host checkout symlinks and retain the downstream merge/hold assertions.

### Named deployment check: liveDrainProvisionsFrontieruiAndRoutes53

This check is pending until recorded on the deployment host; hermetic tests do not prove it.
Before loading the repaired daemon, record `siblingCloneStatus({ cwd: drainCheckout })`
from this library against the actual configured drain checkout, including its absolute cwd,
timestamp, frontierui missing reason and plateau-app presence. After the normal daemon
restart, record the same status (frontierui must be present with validated origin), plus
the daemon's structured pass report identifying the frontierui repo and PR 53. Require
positive evidence that PR 53 was considered or routed, and no missing-clone skip for it;
absence of a skip line alone does not pass. Preserve both observations with the deployed
revision in the review evidence. A missing initial observation, no PR 53 in the pass, or an
unreadable report leaves this check pending. Do not run a drain solely to obtain this evidence.
