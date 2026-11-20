---
bornAs: xrlrbc9
kind: story
size: 3
parent: "4075"
status: open

dateOpened: "2026-10-01"
tags: []
---

# Prevention — Add a unit test that feeds one successful multi-effect ci-heal run to recordPrAttempts and asserts it y… (from chalbert/web-everything#3270 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-pr-attempts.mjs:64` — Add a unit test that feeds one successful multi-effect ci-heal run to recordPrAttempts and asserts it yields at most one attempt. Alternatively, count one attempt per run id and PR instead of per effect.
2. `we:scripts/conveyor/health-watch.mjs:749` — Add a deterministic tick integration test with distinguishable fixture and host records, asserting that fixture flags exclude host evidence; verify that removing the fixtureTick conditional makes it fail.
3. `we:scripts/conveyor/health-smells/index.mjs` — A check:standards lint that verifies all .mjs files in health-smells/ are exported by we:scripts/conveyor/health-smells/index.mjs.
4. `we:scripts/conveyor/health-smells/repeated-pr-attempts.mjs` — A type check or schema validation on smell exports that ensures destructured keys in evaluate match the declared probes array.
5. `we:scripts/conveyor/health-watch.mjs` — An ESLint no-undef rule running in the CI pipeline.
6. `we:scripts/conveyor/health-watch.mjs` — A review checklist requiring every behavioral claim in prose to have a corresponding test assertion.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3270@e0b6162699affe6a3f3d646989957aa4798030ac

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

## Findings (standalone worker, 2026-11-20)

The build-dispatch daemon held #4895 with:

> worker-declined: Not prepared: #4895 — could-not-prepare. Guard 4 requires a policy choice: must every consumed probe be required, or may smells declare optional probes? 'we:scripts/conveyor/health-watch-core.mjs:943' skips evaluation when a declared probe is missing. Requiring 'operationRuns' would therefore suppress today’s log-only repeated-attempt detection. Other smells intentionally consume optional evidence, including 'appStatus' in 'we:scripts/conveyor/health-smells/github-app-token.mjs:40'. A strict matching check would change that behavior; preserving it requires an optional-probe contract. I left no d…

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
