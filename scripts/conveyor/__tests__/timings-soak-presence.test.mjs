import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import b from '../soak/breaks/fix-scope-overlap-timings-serializes.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tree(policy) {
  const root = mkdtempSync(join(tmpdir(), 'timings-presence-')); roots.push(root);
  mkdirSync(join(root, 'scripts/conveyor'), { recursive: true });
  if (policy) writeFileSync(join(root, 'scripts/conveyor/fix-scope-policy.mjs'), policy);
  return root;
}
it('keeps fixPresent true when the independent two-fix planning scenario regresses', async () => {
  const root = tree("export const stripProseScope = scope => scope.filter(path => path !== 'we:scripts/ci/test-timings.json');");
  writeFileSync(join(root, 'scripts/conveyor/reconcile-fix-dispatch.mjs'), `
    export const filterFixesByInFlightScope = queue => ({
      planned: queue.slice(0, 1), refusals: queue.slice(1).map(f => ({ pr: f.pr, kind: 'scope-overlap' }))
    });
  `);
  expect(b.fixPresent(root)).toBe(true);
  // Native import can load the scratch tree outside Vite's filesystem allowlist.
  const run = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const b = (await import(process.argv[1])).default; console.log(JSON.stringify(b.judge(await b.run())));',
    pathToFileURL(join(process.cwd(), 'scripts/conveyor/soak/breaks/fix-scope-overlap-timings-serializes.mjs')).href], {
    env: { ...process.env, SOAK_TREE_ROOT: root }, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual([
    'shared timings serialized fixes: scripts/ci/test-timings.json',
    'shared timings serialized fixes: we:scripts/ci/test-timings.json',
  ]);
});
it('detects the absent fix from scope behavior without needing a planner module', () => {
  expect(b.fixPresent(tree('export const stripProseScope = scope => scope;'))).toBe(false);
});
it('fails closed when the policy cannot be read', () => {
  expect(b.fixPresent(tree())).toBe(false);
});
