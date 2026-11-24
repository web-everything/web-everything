## Shadow dependency tracing (S2)

Append ` --import="file:///absolute/repo/scripts/ci/dep-trace.mjs"` to existing `NODE_OPTIONS`
and set `WE_TRACE_TEST` to the repo-relative test file and `WE_TRACE_DIR` to an artifact directory.
Node 22 uses `module.register` plus a loader message port; synchronous exit drains pending loader edges.
Use an absolute `WE_TRACE_DIR`. Each process emits `trace-<pid>.json` with `truncated` and `incomplete`
flags; merge with `mergeTraces` into `{ tests, incomplete }`, then replay via
`scripts/readiness/trace-coverage.mjs trace-map.json misses.json [static-selected.json]`.
The tracer is observe-only: it never rewrites a `child_process` call or the environment.
Each patched call reaches Node with the caller's exact arguments and receiver.
A child whose real env (`options.env || process.env`) lacks this `--import` hook in `NODE_OPTIONS`,
the same `WE_TRACE_TEST`, a `WE_TRACE_DIR` resolving to the same directory, or the same
`WE_CI_SELECTION` marks the evidence `incomplete`. A trace without the flag also counts as incomplete.
A non-Node child also marks it `incomplete`: `execSync` and any `shell` option (a shell runs first), a
command whose realpath is not the running Node binary (a bare name is looked up on the child's PATH; a
relative or empty PATH entry is unknown), `fork` with a non-Node `execPath`, and a Node child whose args,
`execArgv` or `NODE_OPTIONS` carry `--run`, `--permission`, `--experimental-permission`, `--check`/`-c`,
an env or config file flag (`--env-file`, `--env-file-if-exists`, `--experimental-config-file`,
`--experimental-default-config-file`) or `--experimental-sea-config`; a non-array `execArgv` is unknown.
URL getters are trusted only as captured from node:url at load. Patched built-in array and string
methods are not guarded, and script arguments are scanned as flags (a safe over-flag); carded as `x7m3x86`.
`Worker`, `ChildProcess.prototype.spawn` and `process.execve` are neither traced nor flagged; carded as `xlh3igo`.
An inheriting child is judged by the live `process.env` at call time. Args arrays over 65536 entries and
path buffers over 65536 bytes are not read and mark the trace `incomplete`. A `file:` string is a URL only
for loader edges; to `fs` it is a literal path, and a URL object converts from its hostname and pathname.
Node reads every caller value again, so the tracer never runs caller code: options, env, args and path
values are read by descriptor, and a getter, a Proxy or an object env value (whose `toString` would run)
is left to Node untouched and marks the trace `incomplete`. Only node:url's own `URL` getters (also
inherited by happy-dom's `URL`) and the intrinsic `Uint8Array` getters are read. The `env getter read once`
and `execSync cat` real-child cases and the `never runs caller code` cases pin this.
Callback `fs.readdir` (and other callback/stream read paths) is not wrapped; carded as a read-path gap.
Incomplete evidence keeps its observed edges, but a result it does not show is `traced: null`
(unknown), never `false`. The replay prints `incomplete: true` and warns on stderr.
`execSync` is wrapped separately because it bypasses the exported `spawnSync`. Hook detection splits
`NODE_OPTIONS` on spaces only, as Node does (a tab is not a separator).
Not observed (no edge, no flag): stream, file-descriptor and `FileHandle` reads, and a child killed
by a signal or a `spawnSync` timeout (no exit hook, so no trace file, while the parent's trace still
reads complete). These are carded as `xo73a24`.
Omitting static evidence prints `staticEvidence: "not supplied"`; static and additional counts
are `null` (unknown). An explicit empty static list means known zero static coverage.
Tracing stays shadow-only. The edge cap applies per process; a cap warning means incomplete evidence:
rerun with a larger `ci.selection.trace.maxEdgesPerTest` before interpreting coverage.
Inject filesystem/child-process objects for tracer edge tests and exercise loader hooks directly.
Runtime contract regressions in `scripts/ci/__tests__/dep-trace.test.mjs` also launch isolated Node children:
captured stdout/stderr must accept a synchronous 65536-byte write after loader registration, and
`spawnSync`/`execFileSync` must accept frozen options. A table case runs frozen options, a `Buffer` cwd,
`env: {}` and promisified `execFile` both traced and untraced and asserts identical exit and output.
A `NODE_OPTIONS=--input-type=module` parent must run an `env: {}` CommonJS child unchanged and report
`incomplete: true`. Bound these children by timeout and output size, load the suite's test-cache
child tracer in its no-op mode (`WE_TRACE_FILE=''`) so it cannot rewrite their env, and remove their
temporary trace directories after each case.
Review lens: each settings catch fallback needs a named test forcing the loader to fail,
including malformed input and valid overrides. The `honours fallback settings after loader failure`
cases in `scripts/ci/__tests__/dep-trace.test.mjs` exercise startup's fallback directly.
Review lens: the child-process wrappers must never throw where unwrapped Node would not. Every `cwd` form
Node accepts (string, `Buffer`, file `URL` from any realm) resolves; any other value goes to Node unchanged
for Node to judge. A non-string `NODE_OPTIONS` is stringified. A deleted working directory makes
`process.cwd()` throw; tracing then resolves absolute paths only, and a relative child `WE_TRACE_DIR`
is incomplete. The child env is read with `for…in`, skipping undefined values, and falls back on a
falsy value, as Node does. The `hands Node the exact caller arguments`, `accepts a … cwd`,
`never throws`, `keeps an … cwd` and `flags incomplete evidence` cases pin this.
