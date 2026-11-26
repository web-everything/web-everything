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
const { failsSameChecks, resolveAdoptNotWorse } = await import(process.argv[1]);
const raw = 'TypeError: smoke harness broke at 12';
const entry = (over = {}) => ({ entry: 'e.mjs', ok: false, kind: 'import failed', errorClass: raw, rawError: raw, ...over });
const boot = (over = {}, row = {}) => ({ ok: false, name: 'daemon-entries-boot', entries: [entry(over)], ...row });
// The candidate is ALWAYS a valid typed failure, so only the CONTROL's evidence validation can make a probe false.
const cand = [boot()];
const out = {
  // The shipped default: a failed candidate is never adopted as "not worse" (daemons.rebuild.adoptNotWorse is off).
  adoptNotWorseDefaultOn: resolveAdoptNotWorse({}).enabled,
  validControl: failsSameChecks(cand, [boot()]),
  budgetRefused: failsSameChecks(cand, [boot({}, { budgetInterrupted: true })]),
  timeoutOnly: failsSameChecks(cand, [boot({ kind: 'child failed: timed out after 45000ms (process group killed)', signal: 'SIGKILL' })]),
  unparsable: failsSameChecks(cand, [boot({ kind: 'unparsable child output' })]),
  infraError: failsSameChecks([boot({ errorClass: 'Error: spawn git ENOENT', rawError: 'Error: spawn git ENOENT' })], [boot({ errorClass: 'Error: spawn git ENOENT', rawError: 'Error: spawn git ENOENT' })]),
  textualOnly: failsSameChecks(cand, [{ ok: false, name: 'daemon-entries-boot', detail: raw }]),
  differentRaw: failsSameChecks(cand, [boot({ rawError: raw.replace('12', '13') })]),
  nameOnly: failsSameChecks([{ ok: false, name: 'tree-stays-clean', detail: 'dirt' }], [{ ok: false, name: 'tree-stays-clean', detail: 'dirt' }]),
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
    const problems = Object.entries(p).filter(([k, v]) => k !== 'validControl' && v !== false).map(([k]) => `${k}: a non-affirmative control matched the candidate failure`);
    if (p.validControl !== true) problems.push('validControl: an exact, typed, executed-check control no longer matches (the probe cannot discriminate)');
    return problems;
  },
};
