## Drain overlap targets after enqueue declines

The pass-start verdicts are separate from the cascade's `remaining` copies. An enqueue
refusal flips the latter to `skip`; it does not update the original verdict used for
Y-side overlap filtering. Carry `mq-same-head-failed` outcome keys across replans and
allow newly learned holds to trigger another cascade iteration even when nothing merged.
Keep the held PR in the open set so dependency gates still apply.

The enqueue-on-event catch-up declines and backoffs are volatile process-local maps,
not a persisted signal available to the drain child. Do not infer a cross-pass hold from them.
The `overlap-yield-skips-mq-held-target` soak break probes the production row builder
and planner without network IO; it proves planner release, not a live GitHub merge.

The named orchestration test `a real mq refusal continues a no-merge cascade, attempts
the released waiter, and never retries the held target` in
`scripts/__tests__/merge-ai-prs-prestage.test.mjs` drives the real drain entry point,
queue guard, enqueue outcome collector, and cascade loop with hermetic Git/GitHub ports.
Its two-PR fixture holds L on affirmative same-head queue failure and confirms S's enqueue
in that same pass, with one admission attempt for L and zero merges. Removing either
the held-key collection or the no-progress continuation was verified to fail the waiter
enqueue assertion. The production source is restored after each mutation probe.
