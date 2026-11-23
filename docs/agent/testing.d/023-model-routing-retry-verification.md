## Model routing retry verification

Codex `modelByTask` resolves model, effort and the optional `retry` array as independent cascade
leaves. Each retry pair must use a catalogue model and one of its supported efforts; `[]` disables
same-provider retries. Cover standard, platform, tool and env provenance, invalid pair rejection,
and the actual launch sequence before Claude fallback. Routing-policy model vetoes must survive
settings expansion at the launch boundary. Only a definite pre-launch `notApplied` refusal advances
the chain; an indeterminate or already-started launch must never start a second worker.
Repair defaults (`operations.fix`, `operations.ci-heal`, `taskTypes.bugfix`) keep `inherit: true`
at high effort so evidence routing, backend holds and fixer escalation remain effective. Assert the
Codex retry order through `codex.modelByTask` settings; use an explicit route fixture for launch-boundary tests.
Claude helper defaults resolve through `claudeHelper` and `WE_CLAUDE_HELPER_MODEL`; explicit
per-lens design models still override the helper default.

