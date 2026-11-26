/**
 * 2026-11-26: the rebuild's `failsSameChecks` compared the candidate's failed checks with the last-good control's by
 * NAME only, so a control whose check was budget-refused, skipped, timeout-only or evidence-less counted as "the harness
 * is broken" and the failed candidate was adopted "not worse" (harness-broken-adopted-not-worse). A control may vouch
 * for a candidate failure only when it failed affirmatively with executed-check evidence.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE = `
const { failsSameChecks } = await import(process.argv[1]);
const cand = [{ ok: false, name: 'tree-stays-clean', detail: 'smoke introduced tracked dirt' }];
const out = {
  budgetRefused: failsSameChecks(cand, [{ ok: false, name: 'tree-stays-clean', budgetInterrupted: true, detail: 'skipped: rebuild smoke budget exhausted (0ms left)' }]),
  nameOnly: failsSameChecks(cand, [{ ok: false, name: 'tree-stays-clean' }]),
  bootTimeoutOnly: failsSameChecks(
    [{ ok: false, name: 'daemon-entries-boot', entries: [{ entry: 'e.mjs', ok: false, errorClass: 'SyntaxError: x' }] }],
    [{ ok: false, name: 'daemon-entries-boot', entries: [{ entry: 'e.mjs', ok: false, kind: 'child failed: timed out after 45000ms (process group killed)', errorClass: null, signal: 'SIGKILL' }] }]),
};
console.log(JSON.stringify(out));
`;

function probe(root) {
  const mod = pathToFileURL(join(root, 'scripts/lib/daemon-rebuild/smoke.mjs')).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE, mod], { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0 || r.signal) return null;
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; }
}

export default {
  id: 'rebuild-adopts-candidate-over-refused-control',
  title: 'failsSameChecks matched by name only, so a budget-refused / timeout-only / evidence-less last-good control let a failed candidate be adopted not-worse',
  card: 'SMOKE-ENVTIMEOUT-BUDGET-V2.S2a',
  fixedBy: { sha: '0316298d62c76867d3da95aafddf98d9cc7b5eba', where: 'lane/smoke-v2-s2a', paths: ['scripts/lib/daemon-rebuild/smoke.mjs'] },
  // A declared marker (SHIP-WM-321), NOT the behaviour under test: a regression must flip the test red, never to it.fails.
  fixPresent(root) { return readFileSync(join(root, 'scripts/lib/daemon-rebuild/smoke.mjs'), 'utf8').includes('SHIP-WM-321'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    return { probe: probe(root) };
  },
  judge(report) {
    const p = report.probe;
    if (!p) return ['the failsSameChecks probe did not run'];
    return Object.entries(p).filter(([, v]) => v !== false).map(([k]) => `${k}: a non-affirmative control matched the candidate failure`);
  },
};
