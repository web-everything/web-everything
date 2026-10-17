import { it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const roots = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const moduleUrl = pathToFileURL(resolve('scripts/operations/review-extra-seats.mjs')).href;
it('removes a checkout whose pinned fetch fails before makeScratch returns', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'we-seat-failure-test-')); roots.push(tmp);
  const code = `import { createExtraSeatsIo } from ${JSON.stringify(moduleUrl)};
    try { createExtraSeatsIo().makeScratch({ lanePath: 'missing-repo', rev: 'a'.repeat(40) }); process.exitCode = 1; } catch {}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TMPDIR: tmp }, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  expect(readdirSync(tmp).filter(n => n.startsWith('we-review-seat-'))).toEqual([]);
});
it.each(['success', 'failure', 'SIGTERM', 'SIGINT', 'SIGHUP'])('removes owned checkout on %s', mode => {
  const tmp = mkdtempSync(join(tmpdir(), 'we-seat-cleanup-test-')); roots.push(tmp);
  const dir = join(tmp, 'checkout');
  const helper = pathToFileURL(resolve('scripts/lib/review-scratch.mjs')).href;
  const code = `import { mkdirSync } from 'node:fs'; import { ownReviewScratch } from ${JSON.stringify(helper)};
    mkdirSync(${JSON.stringify(dir)}); ownReviewScratch(${JSON.stringify(dir)});
    ${mode === 'failure' ? "throw new Error('failed seat')" : mode === 'success' ? '' : `process.kill(process.pid, '${mode}'); setTimeout(() => {}, 10000);`}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15000 });
  expect(existsSync(dir), r.stderr).toBe(false);
  if (mode === 'success') expect(r.status).toBe(0);
  else expect(r.status === 0).toBe(false);
});
