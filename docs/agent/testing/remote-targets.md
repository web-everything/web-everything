## Configuring heavy-run remote targets

`heavyAdmission.remote.hosts` is an ordered list of `{alias, root}` records in
platform preferences. It follows the existing admission settings cascade and
shared-pool restrictions on tool overrides; policy logs include its value and source.
The default is `[{"alias":"forge","root":"/srv/forge-exec"}]` and adds no discovery probe.
For Mesa first, configure `[{"alias":"mesa-01","root":"/srv/forge-exec"},
{"alias":"forge","root":"/srv/forge-exec"}]`. Both runners currently require exactly `/srv/forge-exec`.

Lists must contain 1–32 entries. Aliases use the run-finisher's strict pattern:
a letter or digit first, followed only by letters, digits, dots, underscores, or
hyphens, with no trailing newline. User@host forms and leading hyphens are rejected.
Roots must be exactly `/srv/forge-exec`; other paths, including `/` and traversal,
are rejected. An invalid explicit list disables remote dispatch, runs locally,
and logs `location=local reason=invalid-remote-hosts` with its settings source.
Custom targets are probed in order with noninteractive SSH, a five-second
connection timeout, and a ten-second execution deadline that kills the child.
A missing executable is `runner-missing`; other SSH failures
are `ssh-unreachable`. No healthy target means local admission with
`location=local reason=no-healthy-remote`, without remote dispatch.
Discovery does not cache results. Execution keeps the existing ops sudo and SSH
credential handling; configure aliases through the operator's existing SSH setup.

Dry discovery uses the same settings without dispatching a job:

```sh
node --input-type=module -e 'import {probeRemoteHosts} from "./scripts/readiness/remote-target.mjs"; console.log(await probeRemoteHosts());'
```

The hermetic tests in `remote-target.test.mjs` cover target ordering, failures,
settings validation, the no-probe default, and the negative no-remote-dispatch path.
