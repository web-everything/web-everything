## Worker cancellation during module loading

Never terminate a worker while its ESM graph is loading: Node 22 can abort the entire process in
`AsyncModuleExecutionFulfilled`. The verify watchdog disarms its shared deadline before cooperative
shutdown, and `verify-lane` awaits its exit before emitting the final verdict, including timeout and
spawn-error paths. Keep the escape sweeps intact when the deadline already fired.

The health probe worker uses `worker-deadline.mjs`: announce readiness after all imports and before
synchronous probe work, check startup cancellation, and drain worker exit before reporting a timeout.
Module evaluation is allowed to finish during cancellation; the timeout prevents probe work from
starting but does not forcibly interrupt the loader. Do not use this readiness protocol for work
that dynamically imports additional modules after announcing readiness.
`bounded-child-tree-kill.test.mjs` and `worker-deadline.test.mjs` use subprocesses with delayed ESM
imports to exercise cancellation without taking down the test runner on a native loader regression.
Eval worker bootstraps must support inherited `--input-type=commonjs` and `--input-type=module`;
use dynamic imports for dependencies shared by both modes. Keep both caller modes in the watchdog's
heartbeat shutdown matrix, including live handles, in-flight imports and fired deadlines.
The named `hashes Git-clean … leaves` table covers every sensitive attribute:
`filter`, `working-tree-encoding`, `ident`, `text`, and `eol`, asserting actual leaf
reads and equality with full hashing. Include an identity encoding as well as a
byte-transforming encoding so base-blob size/hash checks cannot mask a missing
attribute guard. Same-size hidden-edit cases pin uppercase `S` (skip-worktree),
lowercase `h` (assume-unchanged), and lowercase `s` (both flags).


