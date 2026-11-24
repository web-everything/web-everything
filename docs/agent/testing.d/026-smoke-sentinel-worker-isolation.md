## Smoke sentinel worker isolation

Daemon rebuild dispatch dry-runs force `WE_WORKER_WRAPPER=off` so injected spawners capture both fix and
review prompts. Missing or blank captures fail; synthetic review PRs inject an allowed CI gate so the brief
check cannot silently skip dispatch. Wrapped launches also refuse sentinel PRs (`9xxxxx`) and session slugs
ending in that sentinel unless `smokeRealWorker.allowSentinel` resolves true through the shared cascade
(`scripts/settings/smoke-real-worker.json`, env `WE_SMOKE_ALLOW_REAL_WORKER=1|true`). The deliberate overlay
real-worker smoke sets this opt-in itself. Test refusal with an injected launcher, for every default-on role.

