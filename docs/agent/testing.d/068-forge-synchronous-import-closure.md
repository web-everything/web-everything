## Forge synchronous import closure

Keep the Forge runner, client, telemetry, warmer and limits modules free of top-level
`await` throughout their static import graph. Put async CLI execution inside the
guarded async wrapper used by `forge-exec-run.mjs`. The `Forge synchronous module loading`
cases in `forge-client-controls.test.mjs` use native Node require to check that importing
each module succeeds without executing its CLI, including the limits dependency.

