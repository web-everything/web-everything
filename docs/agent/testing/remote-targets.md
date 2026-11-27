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
Custom targets first pass the routing gate and caller write-confinement check.
Local gate decisions preserve their reason without reading host state or probing.
Each target is then checked in list order: breaker, runner probe, telemetry health.
An open breaker skips the probe (`backoff-<trigger>`); an unreachable backoff is
re-probed so the locked health check can lift it. Probes use noninteractive SSH,
a five-second connection timeout and a ten-second execution deadline that kills
the child. Skips name `runner-missing`, `ssh-unreachable`, or the health refusal.
Hook errors use `breaker-unreadable` or `remote-health-unreadable`; malformed
results use `breaker-result-invalid` or `admit-result-invalid`, and an open breaker
without a reason uses `breaker-open`. The first target passing all three wins.
No healthy target means local admission with `location=local reason=no-healthy-remote`
and ordered skip details in the fallback record; there is no fallback to Forge
unless Forge is explicitly in the list.
Discovery does not cache results. Execution keeps the existing ops sudo and SSH
credential handling; configure aliases through the operator's existing SSH setup.

Targets share the remote slot capacity limit. Cleanup uses each persisted marker's
own validated host for telemetry and finishing, including targets removed from the
current configuration. A recovered preferred target can therefore reclaim finished
fallback-host jobs without relying on that fallback being selected again. Live owners,
unreachable hosts, and unreadable or unbound markers retain their slots until cleanup
is confirmed; another host's idle telemetry never proves their jobs stopped.

Dry discovery uses the same settings without dispatching a job:

```sh
node --input-type=module -e 'import {probeRemoteHosts} from "./scripts/readiness/remote-target.mjs"; console.log(await probeRemoteHosts());'
```

The hermetic tests in `remote-target.test.mjs` cover target ordering, failures,
settings validation, the no-probe default, and the negative no-remote-dispatch path.
