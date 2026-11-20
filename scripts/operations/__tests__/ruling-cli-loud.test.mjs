import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { refuseDirectEntry, isDirectEntry } from '../../lib/direct-entry-guard.mjs';

const here = (f) => join(dirname(fileURLToPath(import.meta.url)), '..', f);

describe('ruling CLI prints its result or refusal', () => {
  for (const f of ['record-red-team-ruling.mjs', 'extend-rounds.mjs']) {
    it(`${f} run directly prints a named refusal and exits 2`, () => {
      const r = spawnSync(process.execPath, [here(f), '--preview'], { encoding: 'utf8' });
      expect(`${r.status} ${r.stderr.slice(0, 400)}`).toMatch(/^2 /);
      expect(r.stdout).toMatch(/^refused: .* has no direct entry; use /);
    });
    it(`${f} imported as a library stays silent`, () => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(here(f)).href)})`], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });
  }
  it('unknown or missing argv is a no-op, never a silent refusal-less pass', () => {
    expect(isDirectEntry('file:///x/y.mjs', undefined)).toBe(false);
    let out = ''; let code = null;
    expect(refuseDirectEntry('file:///x/y.mjs', 'op', 'run.mjs op', { argv1: '/x/y.mjs', write: (s) => { out += s; }, exit: (c) => { code = c; } })).toBe(true);
    expect(out).toContain('use run.mjs op');
    expect(code).toBe(2);
  });
});
