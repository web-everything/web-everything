#!/usr/bin/env node
/**
 * @file land-advance-cli.mjs
 * Standalone adapter. Plan is the default and reads only. `--mode=dispatch` (alias `--apply`) only ASKS: it
 * dispatches when the operator's durable opt-in is set and no pause marker is, both read from the canonical checkout
 * (land-advance-gate.mjs, #3720). One call at a time: a second concurrent caller exits `busy` (single-flight lease).
 * Every call that runs records a run record in the canonical checkout's run store. Side effects sit behind the applier.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLandAdvanceReader, createLandAdvanceApplier } from './land-advance-io.mjs';
import { planLandAdvance, renderTable, decideMode, LAND_ADVANCE_OP } from './land-advance.mjs';
import { canonicalRoot as resolveCanonicalRoot, readGate as readGateDefault, tryAcquireSingleFlight, releaseSingleFlight, LAND_ADVANCE_LOCK_ROOT } from './land-advance-gate.mjs';
import { createFileRunStore, resolveRunsDir, newRunId, newRunRecord } from './run-store.mjs';
const FLAG = /^--(?:json|apply|mode=(?:plan|dispatch)|cap=\d+|max-items=\d+|caller=[\w.-]+)$/;
export async function main({ argv = process.argv.slice(2), deps = {}, stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s) } = {}) {
  let lease = null;
  const lockRoot = deps.lockRoot ?? LAND_ADVANCE_LOCK_ROOT;
  try {
    for (const a of argv) if (!FLAG.test(a)) throw new Error(`Unknown argument: ${a}`);
    const value = (name, fallback) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
    const cap = Number(value('cap', 3)), maxItemsPerCall = Number(value('max-items', 1)), caller = value('caller', 'cli');
    const requested = argv.includes('--apply') || value('mode') === 'dispatch' ? 'dispatch' : 'plan';
    lease = (deps.acquire ?? tryAcquireSingleFlight)({ lockRoot });
    if (!lease.ok) {
      stdout((argv.includes('--json') ? JSON.stringify({ busy: true, heldBy: lease.heldBy }) : `land-advance: busy, another call holds the single-flight lease (${lease.heldBy})`) + '\n');
      lease = null; return 0;
    }
    const canonical = deps.canonicalRoot ? { root: deps.canonicalRoot() } : resolveCanonicalRoot(), root = canonical.root;
    const mode = decideMode({ requested, gate: { ...(deps.readGate ?? readGateDefault)(root), ambiguous: canonical.ambiguous } });
    const inputs = await (deps.readInputs ?? createLandAdvanceReader({ cap, refreshPrototype: mode.mode === 'dispatch', canonicalRoot: root }))();
    const plan = { ...planLandAdvance({ ...inputs, cap, maxItemsPerCall }), mode, canonicalRoot: root };
    if (mode.mode === 'dispatch' && !plan.errors.length) plan.applied = await (deps.apply ?? createLandAdvanceApplier({ canonicalRoot: root }))(plan, { prs: mode.prs, items: mode.items });
    const store = deps.store ?? createFileRunStore(resolveRunsDir());
    const record = newRunRecord({ id: newRunId(LAND_ADVANCE_OP), op: LAND_ADVANCE_OP, input: { mode: requested, caller } });
    record.verdict = { mode: mode.mode, why: mode.why, budget: plan.capacity.budget, proposedPrs: plan.proposed.map((r) => r.subject),
      proposedItems: plan.items?.proposed.map((i) => i.num) ?? [], dispatched: plan.applied?.dispatched?.length ?? 0, queued: plan.applied?.queued?.length ?? 0,
      errors: [...plan.errors, ...(plan.applied?.errors ?? [])].map((e) => `${e.source ?? e.target ?? 'apply'}: ${e.message}`) };
    store.write(record);
    stdout((argv.includes('--json') ? JSON.stringify(plan) : renderTable(plan)) + '\n');
    const errors = [...plan.errors, ...(plan.applied?.errors ?? [])];
    for (const e of errors) stderr(`${e.source ?? 'apply'}: ${e.message}\n`);
    return errors.length ? 1 : 0;
  } catch (e) { stderr(`${e.message ?? e}\n`); return 1; }
  finally { if (lease) (deps.release ?? releaseSingleFlight)({ lockRoot, owner: lease.owner }); }
}
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) process.exitCode = await main();
