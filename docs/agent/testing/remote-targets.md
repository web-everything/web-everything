## Configuring heavy-run remote targets

`heavyAdmission.remote.hosts` is an ordered list of `{alias, root}` records in
platform preferences. It follows the existing admission settings cascade and
shared-pool restrictions on tool overrides; policy logs include its value and source.
The default is `[{"alias":"forge","root":"/srv/forge-exec"}]` and adds no discovery probe.
For Mesa first, configure `[{"alias":"mesa-01","root":"/srv/mesa-exec"},
{"alias":"forge","root":"/srv/forge-exec"}]` with roots matching each installed runner.

Lists must contain 1–32 entries. Aliases match `^[A-Za-z0-9_.@-]+$`;
roots are absolute paths containing only letters, digits, underscore, dot, slash,
and hyphen. Invalid settings retain the lower-layer value (the standard default when no valid
override exists) and appear in policy diagnostics.
Custom targets are probed in order with noninteractive SSH and a five-second
connection timeout. A missing executable is `runner-missing`; other SSH failures
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
