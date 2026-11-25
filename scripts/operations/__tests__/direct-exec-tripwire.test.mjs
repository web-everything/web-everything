/** @file direct-exec-tripwire.test.mjs — every dispatch site passes its resolved route to the wrapped Claude launcher. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Known dispatch modules (fix, ci-heal, review, reconcile-fix). Allowlist must be empty at land time.
const SITES = ['scripts/operations/dispatch-lane-io.mjs', 'scripts/operations/review-dispatch.mjs', 'scripts/conveyor/reconcile-fix-dispatch.mjs'];
const ALLOWLIST = [];

/** Every `launchWrapped({ ... })` call body, by balanced-brace scan. */
function callBodies(src) {
  const out = [];
  for (let i = src.indexOf('launchWrapped({'); i !== -1; i = src.indexOf('launchWrapped({', i + 1)) {
    let depth = 0; let j = src.indexOf('{', i);
    const start = j;
    for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
    out.push(src.slice(start, j + 1));
  }
  return out;
}

describe('direct-exec tripwire', () => {
  it('the allowlist is empty', () => { expect(ALLOWLIST).toEqual([]); });
  for (const site of SITES) {
    it(`${site} passes a route to every launchWrapped call`, () => {
      const bodies = callBodies(readFileSync(join(ROOT, site), 'utf8'));
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) expect(body, `${site} launchWrapped call lacks route`).toMatch(/\broute\s*[:,]/);
    });
  }
  it('the scanner flags a call without a route', () => {
    expect(callBodies('launchWrapped({ role: 1 })')[0]).not.toMatch(/\broute\s*[:,]/);
  });
});
