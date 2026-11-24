## Probe worker timeout teardown

Worker timeout promises allow at most one second for `worker.terminate()` before
rejecting. A synchronous native call such as `execFileSync` can prevent termination
from settling: every timeout-path termination wait needs a separate hard deadline.
Reserve the timeout outcome first so late message, error and exit events cannot
replace it. Await normal shutdown within the grace period so callers can tear down
safely; after the deadline, unreference the blocked worker and reject with the original
timeout error. Shutdown remains best effort after this bound; the worker may survive
until its native call returns or its owning process exits.
`scripts/conveyor/__tests__/probe-worker-lifecycle.test.mjs` covers pending, rejected
and synchronously throwing termination for both runners, plus a real probe blocked in
`execFileSync`. The `probe-worker-termination-blocks-timeout` daemon soak break runs
the equivalent real sweep worker case. Keep these bounded-wait cases when changing
timeout teardown; awaiting termination without a secondary deadline must fail them.

