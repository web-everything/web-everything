## Build-priority named-file allowlist fixtures

The shipped `scripts/settings/build-priority-scope.json` has `allowedFiles: []`.
An empty array is valid settings evidence and refuses every scope with
`allowlist is empty; add the file by a reviewed settings PR`. Missing or unreadable
settings, a missing key, non-array values, non-string entries and inexact paths
still refuse as invalid evidence. Tests needing listed files must inject
`readScopeSettings` with an explicit allowlist; real Git reader tests commit their
own settings blob and pin it with the card snapshot. Never depend on a shipped seed.

Runtime scope protection imports the immutable vocabulary from `guard-path-floor.mjs`
and the matcher from `audit-path.mjs`. The audit settings resolver and verdict engine
remain inert. Keep the import-graph assertion in `build-priority-set.test.mjs` alongside
the repository-wide inertness check in `audit-verdict.test.mjs`; protected module names
in `guard-auditor-roots.json` are path data, not module dependencies. The existing audit
exports re-export the shared vocabulary and matcher so their callers keep the same API.

Settings-registry migration checks use the key roster in the immutable original metadata
fixture. Compare historical declarations and rendered bytes within that roster; keep the
live inventory and committed-document drift check responsible for subsequently added keys.
