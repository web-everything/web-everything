#!/usr/bin/env node
/**
 * conformance-autofix.mjs — the conformance auto-fix agent CLI (backlog #095).
 *
 * Wires the pure {@link file://./autofix/engine.mjs} loop to the REAL suite: it reads failures from
 * `check:standards --json`, lets registered fixers propose patches, applies them, and re-runs the
 * suite — keeping a patch ONLY if its target failure cleared and introduced no new error (the
 * verify gate / #089 propose-and-verify moat). Loops until green or nothing fixable remains.
 *
 * Usage:
 *   node scripts/conformance-autofix.mjs                  # apply verify-gated fixes, then report
 *   node scripts/conformance-autofix.mjs --dry-run        # list fixable failures + proposed patches, write nothing
 *   node scripts/conformance-autofix.mjs --review         # print each gate-passing patch's diff and revert it (#293)
 *   node scripts/conformance-autofix.mjs --max-model-fixes=N  # cap metered model-fixer calls so a runaway loop can't burn the BYO key (#293)
 *
 * AI is a swappable provider: this CLI registers only the deterministic *reference* fixers. A
 * BYO-key model fixer for content-generation classes (e.g. missing-description) registers into the
 * same `fixerRegistry` — see the engine header.
 */
import { execFileSync } from 'node:child_process';
import { admittedArgv } from './readiness/heavy-admission.mjs';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { autofix, fixerRegistry, registerReferenceFixers, formatDiff } from './autofix/engine.mjs';
import { registerModelFixers, createAnthropicClient } from './autofix/modelFixer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = join(ROOT, 'scripts/check-standards.mjs');
const DRY = process.argv.includes('--dry-run');

const RED = '\x1b[31m', YEL = '\x1b[33m', GRN = '\x1b[32m', DIM = '\x1b[2m', CYA = '\x1b[36m', RST = '\x1b[0m';

// `--review` (#293): print each gate-passing patch's diff and REVERT it — a human inspects what the
// (model) fixer proposes without anything landing. The interactive accept/revert surface is the
// playground (#298). `--max-model-fixes=N` (#293) bounds metered model calls so a runaway loop can't
// burn the BYO key; reference fixes are free and uncapped.
const REVIEW = process.argv.includes('--review');
const maxModelFlag = process.argv.find((a) => a.startsWith('--max-model-fixes='));
const MAX_MODEL_FIXES = maxModelFlag ? Number(maxModelFlag.slice('--max-model-fixes='.length)) : Infinity;
if (maxModelFlag && (!Number.isFinite(MAX_MODEL_FIXES) || MAX_MODEL_FIXES < 0)) {
  console.error(`${RED}--max-model-fixes must be a non-negative number${RST}`);
  process.exit(2);
}

registerReferenceFixers();

// AI is a swappable provider: register the BYO-key model fixer for content-generation classes
// (e.g. missing-description, #196) ONLY when a key is present. With no key those failures simply
// report as `skipped` — never faked. The verify gate is identical either way.
if (process.env.ANTHROPIC_API_KEY) {
  registerModelFixers(fixerRegistry, createAnthropicClient());
  console.log(`${DIM}model fixer registered (anthropic; BYO key) — content-generation classes are auto-fixable.${RST}`);
}

/** Re-run the suite in JSON mode and return its structured failures (exit 1 still prints JSON). */
function runSuite() {
  let out;
  try {
    // heavy-enforce: each re-run of the suite queues on the host heavy-admission pool (pass-through when the
    // caller already holds a slot). The wrapper inherits stdio, so the JSON report still arrives on stdout.
    const admitted = admittedArgv('node', [CHECK, '--json']);
    out = execFileSync(admitted.file, admitted.args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = e.stdout; // non-zero exit (errors present) still emits the JSON report on stdout
  }
  const parsed = JSON.parse(out);
  return { ok: parsed.ok, failures: parsed.errors };
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const write = (rel, content) => writeFileSync(join(ROOT, rel), content);
const exists = (rel) => existsSync(join(ROOT, rel));
const remove = (rel) => rmSync(join(ROOT, rel), { force: true });

const initial = runSuite();
console.log(`${DIM}conformance-autofix — Web Everything${RST}`);

if (initial.ok) {
  console.log(`${GRN}✓ check:standards is already green — nothing to fix.${RST}`);
  process.exit(0);
}

const fixable = initial.failures.filter((f) => fixerRegistry.resolve(f));
console.log(`${DIM}${initial.failures.length} error(s); ${fixable.length} match a registered fixer (${fixerRegistry.ids().join(', ')}).${RST}`);

if (!fixable.length) {
  console.log(`${YEL}No auto-fixable failures. The remaining errors need a fixer this build doesn't have:${RST}`);
  for (const f of initial.failures) console.log(`  ${DIM}-${RST} ${f.message}`);
  process.exit(1);
}

if (DRY) {
  console.log(`${CYA}Dry run — would attempt ${fixable.length} fix(es) (verify-gated, nothing written):${RST}`);
  for (const f of fixable) {
    const fixer = fixerRegistry.resolve(f);
    let patch = null;
    try { patch = await fixer.fix(f, { read }); } catch (e) { patch = { summary: `(fixer threw: ${e.message})` }; }
    console.log(`  ${DIM}-${RST} [${fixer.id}] ${patch ? patch.summary : '(no safe patch)'}`);
  }
  process.exit(0);
}

// In `--review` the decider prints the proposed diff and rejects every patch, so nothing lands — a
// human reads what the fixers (esp. the model) would change. Without it, patches that pass the gate
// auto-land (default). The interactive accept/revert loop is the playground (#298).
const decide = REVIEW
  ? (proposal) => {
    console.log(`${CYA}  proposed${RST} ${proposal.summary} ${DIM}(${proposal.fixerId}, ${proposal.file})${RST}`);
    console.log(formatDiff(proposal.before, proposal.after, proposal.file).split('\n').map((l) => `    ${l}`).join('\n'));
    return 'revert'; // review-only: change nothing on disk
  }
  : undefined;

const result = await autofix({
  verify: runSuite, read, write, exists, remove, registry: fixerRegistry,
  maxModelFixes: MAX_MODEL_FIXES, decide,
});

for (const a of result.applied) console.log(`${GRN}  fixed${RST} ${a.summary} ${DIM}(${a.fixerId}, ${a.file})${RST}`);
for (const r of result.reviewed) console.log(`${CYA}  reviewed${RST} ${r.summary} ${DIM}(${r.fixerId}) — proposed, not applied (review mode)${RST}`);
for (const d of result.deferred) console.log(`${YEL}  deferred${RST} ${d.failure.message} ${DIM}— ${d.reason}${RST}`);
for (const g of result.gaveUp) console.log(`${YEL}  reverted${RST} ${g.failure.message} ${DIM}— ${g.reason}${RST}`);
for (const s of result.skipped) console.log(`${DIM}  skipped${RST} ${s.message} ${DIM}(no registered fixer)${RST}`);

if (Number.isFinite(MAX_MODEL_FIXES)) console.log(`${DIM}model-fix budget: ${result.modelFixesUsed}/${MAX_MODEL_FIXES} used.${RST}`);

// Review mode never lands a fix, so a non-green suite is expected — exit 0 (it's an inspection, not a
// fix attempt). Otherwise green ? 0 : 1.
const remaining = result.skipped.length + result.gaveUp.length + result.deferred.length;
const tail = result.ok ? `${GRN}✓ suite green` : `${RED}✗ ${remaining} failure(s) remain`;
console.log(
  `\n${tail}${RST} ${DIM}— ${result.applied.length} fixed, ${result.reviewed.length} reviewed, ` +
  `${result.gaveUp.length} reverted, ${result.deferred.length} deferred, ${result.skipped.length} skipped, ` +
  `${result.rounds} verify round(s).${RST}`,
);
process.exit(REVIEW || result.ok ? 0 : 1);
