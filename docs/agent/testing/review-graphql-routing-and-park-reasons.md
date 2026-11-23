## Review GraphQL routing and park reasons

The gh shim embeds `ownerFromGhArgv.toString()`: keep its dependencies limited to
helpers already embedded by the shim. For `gh api` it parses argv by option arity:
an option's value (`--template`, `--jq`, `-H`, ...) is never the endpoint or a field.
GraphQL routing needs the endpoint `graphql` as the first positional, and owner plus
name/repo taken only from `-f/-F/--field/--raw-field` key=value pairs.

Unattended confirm holds persist `acceptHoldReason` on the run as a fixed value only:
`live-referrals-unavailable:<class>:<exit code|none>` (classes: repo-not-resolved,
auth, not-found, rate-limit, network, timeout, unknown) or `accept-hold:not-met`.
Raw error text is never persisted or alerted, so there is no redaction code to keep
complete. Readers drop any value that does not match that shape. The exhausted
no-verdict alert carries the same fixed value.
