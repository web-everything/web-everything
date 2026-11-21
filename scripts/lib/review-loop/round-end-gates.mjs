import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
/** Round-end composition; IO effects run only after the planner records refusal. */
import { createSizeAdmissionRunner } from '../pr-size-admission.mjs';
import { appendDaemonEvent } from '../daemon-events.mjs';
import { ghRepoSlug } from '../constellation-repos.mjs';
export function roundEndRefusal({ pr, attempts, readIntake, enforce = 'on' }) {
  if (enforce === 'off') return null;
  let verdict;
  try { verdict = readIntake(pr, attempts); } catch { verdict = { verdict: 'unknown', reason: 'unverifiable' }; }
  const result = { ...verdict, kind: verdict?.verdict === 'fail' ? 'split-required' : 'intake-unmeasurable',
    why: 'Intake requires a split or human review of the full diff; operator must resolve unverifiable evidence.', shadow: enforce === 'shadow' };
  if (verdict?.verdict === 'pass') return verdict.overrideUsed ? { ...result, kind: 'intake-override' } : null;
  return result;
}
export async function applyIntakeEffects(plan, { runSize = createSizeAdmissionRunner(), appendEvent = appendDaemonEvent, readHead } = {}) {
  for (const note of plan.notes.filter(n => n.kind === 'intake-effect')) {
    const { intake, pr } = note;
    const repo = note.repo ? ghRepoSlug(note.repo) : undefined;
    if (readHead && await readHead(pr, repo) !== pr.headRefOid) throw Error('stale size request; remeasure next tick');
    if (intake.kind === 'split-required' && !intake.shadow) {
      const result = await runSize({ repo, pr: pr.number, ref: pr.headRefName, sha: pr.headRefOid, base: pr.baseRefName ?? 'main', body: pr.body ?? '', requireSplit: true });
      if (result.cardPublished !== true) throw Error('split card not published; operator must retry intake');
    }
    if (readHead && await readHead(pr, repo) !== pr.headRefOid) throw Error('stale size request; remeasure next tick');
    const appended = await appendEvent({ kind: intake.kind === 'intake-override' ? 'intake-override' : 'intake-split-required', repo, pr: pr.number,
      daemon: 'reconcile', detail: { head: pr.headRefOid, ruling: intake.overrideUsed, lines: intake.lines, shadow: intake.shadow } });
    if (appended === false) throw Error('intake event unavailable; operator must retry');
  }
}

/** Preserve the synchronous planner shell; the bounded child awaits every async effect. */
export function applyIntakeEffectsSync(plan, exec = execFileSync) {
  const notes = plan.notes.filter(n => n.kind === 'intake-effect');
  if (!notes.length) return;
  if (notes.length > 32) throw Error('intake effects exceed tick budget; operator must triage open splits');
  exec(process.execPath, [fileURLToPath(import.meta.url), '--effects'], {
    input: JSON.stringify({ notes }), encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--effects') {
  const { runGhSync } = await import('../gh-throttle.mjs');
  const { ghRepoSlug } = await import('../constellation-repos.mjs');
  await applyIntakeEffects(JSON.parse(readFileSync(0, 'utf8')), { readHead: async (pr, repo) => JSON.parse(runGhSync(
    ['pr', 'view', String(pr.number), ...(repo ? ['--repo', ghRepoSlug(repo)] : []), '--json', 'headRefOid'],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 })).headRefOid });
}
