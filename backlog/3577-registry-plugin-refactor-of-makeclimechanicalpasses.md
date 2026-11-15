---
bornAs: x2zlc42
kind: story
size: 3
parent: "3572"
status: open
scope: ["we:skills-src/conveyor/runner.mjs", "we:scripts/operations/registry.mjs", "we:skills-src/conveyor/passes/review-reconcile-pass.mjs", "we:skills-src/conveyor/passes/hiccup-sink-pass.mjs", "we:skills-src/conveyor/__tests__/runner.test.mjs", "we:scripts/operations/__tests__/registry.test.mjs", "we:skills-src/conveyor/passes/__tests__/review-reconcile-pass.test.mjs"]
dateOpened: "2026-09-07"
tags: []
---

# Registry/plugin refactor of makeCliMechanicalPasses

Ratified by we:backlog/3572-structural-fix-for-we-skills-src-conveyor-runner-mjs-s-makec.md (option a, plugin/registry pattern). Refactors we:skills-src/conveyor/runner.mjs's makeCliMechanicalPasses off a hardcoded sequence of runQuiet(...) calls onto an ordered registry (we:skills-src/conveyor/passes/registry.mjs, MECHANICAL_PASSES) of pass descriptors, so most future mechanical passes add one registry entry instead of editing we:skills-src/conveyor/runner.mjs's body -- see we:backlog/3572-*.md's own Done-when for the full concrete spec (registry shape, per-pass migration, test coverage folding in we:backlog/3501-assert-the-exact-mechanical-pass-set-makeclimechanicalpasses.md).

## Done when

1. **Registry shape.** New we:skills-src/conveyor/passes/registry.mjs exports MECHANICAL_PASSES, an ORDERED array of descriptors, one of two shapes:
   - `{ name, kind: 'script', modulePath, args? }` — dispatched through the existing runQuiet(modulePath, args) subprocess helper (unchanged: same execFileSync('node', […]) shape, same --repo= threading, same best-effort try/catch + summarizeMechanicalPassError log line).
   - `{ name, kind: 'inline', run: (ctx) => Promise<void> }` — for a pass whose control flow is more than one subprocess call; run owns its OWN try/catch + process.stderr.write logging, carried over verbatim from today's code (never unified into a generic wrapper — each inline pass's existing log label is preserved byte-for-byte).
   - ctx passed to every run(...): `{ scriptsDir, repo, out, hiccupSession, execFileSync, runQuiet }`.
2. **Migration — all 9 current passes move into the registry, same order, zero behavior change:**
   - script kind (6): we:scripts/conveyor/infra-blocked.mjs retry, we:scripts/conveyor/lease-reaper.mjs, we:scripts/conveyor/session-reaper.mjs, we:scripts/conveyor/reconcile-fix-dispatch.mjs, we:scripts/conveyor/branch-drift.mjs sweep, we:scripts/conveyor/parked-pr-conflict-watch.mjs sweep, we:scripts/conveyor/duplicate-pr-watch.mjs sweep — each becomes one plain-data descriptor object in we:skills-src/conveyor/passes/registry.mjs; none of these scripts' own internal logic changes.
   - inline kind (2): the review-reconcile dispatch block (today's we:scripts/conveyor/reconcile-pass.mjs --json call + the per-PR we:scripts/operations/review-dispatch.mjs / we:scripts/conveyor/review-round-tag.mjs / we:scripts/conveyor/review-status-tag.mjs orchestration) moves verbatim into we:skills-src/conveyor/passes/review-reconcile-pass.mjs (export async function runReviewReconcilePass(ctx)); the hiccup-sink block moves verbatim into we:skills-src/conveyor/passes/hiccup-sink-pass.mjs (export async function runHiccupSinkPass(ctx)). Neither pass's internal logic is rewritten — only relocated and wired as `{ name, kind: 'inline', run }` entries.
   - we:skills-src/conveyor/runner.mjs#makeCliMechanicalPasses shrinks to a generic loop over MECHANICAL_PASSES (runQuiet(pass.modulePath, pass.args||[]) for script, await pass.run(ctx) for inline) — this loop is the only code left in we:skills-src/conveyor/runner.mjs for this concern; it does not change again when a new simple pass is added.
   - New-pass recipe going forward: add one descriptor object to we:skills-src/conveyor/passes/registry.mjs's array (+ the pass's own new file under we:scripts/conveyor/, following the existing sweep-verb convention) — zero-line diff to we:skills-src/conveyor/runner.mjs.
3. **Test coverage — folds in and updates we:backlog/3501-assert-the-exact-mechanical-pass-set-makeclimechanicalpasses.md's guarantee, not a dangling flag:**
   - New we:skills-src/conveyor/passes/__tests__/registry.test.mjs: asserts MECHANICAL_PASSES' exact ordered `{name, kind, modulePath, args}` shape — the new, direct, no-subprocess-mocking version of "assert the exact mechanical-pass set"; a future add/drop/reorder reddens this test by construction.
   - we:skills-src/conveyor/__tests__/runner.test.mjs's existing "invokes the exact set of mechanical passes, in order, every tick" test (the one #3501/3501 added) is KEPT with its assertion unchanged (same ordered execFileSync call list) — it is now the black-box integration proof that the loop wires the registry correctly end-to-end. Only its explanatory comment (which currently says "delete/reorder/rename a runQuiet(...) line above") is corrected to describe mutating MECHANICAL_PASSES instead.
   - The existing "review-reconcile dispatch block never advances review-round on a failed dispatch" describe block moves to we:skills-src/conveyor/passes/__tests__/review-reconcile-pass.test.mjs, calling runReviewReconcilePass(ctx) directly with the same mocked execFileSync and the same assertions.
   - we:backlog/3501-assert-the-exact-mechanical-pass-set-makeclimechanicalpasses.md itself stays resolved as-is (not reopened) — its guarantee is re-proven by the two points above, not merely asserted.
4. **Executable** — `npx vitest run we:skills-src/conveyor/__tests__/runner.test.mjs we:skills-src/conveyor/passes/__tests__/*.test.mjs` passes.
5. **Executable** — mutation proof (same convention #3501 used): temporarily deleting one entry from MECHANICAL_PASSES reddens BOTH the new registry test and the black-box execFileSync-call-list test in we:skills-src/conveyor/__tests__/runner.test.mjs; verified by hand during the build, then reverted before commit.
6. **Executable** — `npm run check:standards` stays green.
7. **Executable** — live-diff proof: adding one throwaway no-op script-kind descriptor to we:skills-src/conveyor/passes/registry.mjs (then reverting it) touches only that file — zero-line diff to we:skills-src/conveyor/runner.mjs — confirmed by hand during the build.
8. **Landing target: `main`, full pipeline (lane → PR → independent review) — not a direct push to origin/lane/mechanical-dispatcher.** we:skills-src/conveyor/runner.mjs#makeCliMechanicalPasses already lives on main today (confirmed: main's copy is the exact 485-line file we:backlog/3572-*.md's own text cites, with the same 9-commits/14-days hotspot history on main alone) — mechanical-delivery-doctrine rule 4's direct-push carve-out is explicitly scoped to code that exists ONLY on the prototype branch, and does not apply here. origin/lane/mechanical-dispatcher's own later copy (727 lines) will need the same migration applied separately during its own eventual graduation/reconciliation — out of this item's scope.
