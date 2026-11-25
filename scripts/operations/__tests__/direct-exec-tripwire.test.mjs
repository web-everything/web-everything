/** @file direct-exec-tripwire.test.mjs — every dispatch site passes its resolved route to the wrapped Claude launcher. */
import { readFileSync, readdirSync } from 'node:fs';
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
      for (const body of bodies) {
        expect(body, `${site} launchWrapped call lacks a derived route`).toMatch(/\n\s*route:\s*(claudeLaunchRouteFor\(|request\.route \?\? claudeLaunchRouteFor\()/);
        expect(body, `${site} must carry resolved policy evidence`).toMatch(/policyRoute:/);
        expect(body, `${site} must derive its executor`).not.toMatch(/executor:\s*['"]claude['"]/);
      }
    });
  }
  it('no other module calls launchWrappedClaudeWorker or defines a launchWrapped call', () => {
    const scripts = join(ROOT, 'scripts');
    const found = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.mjs$/.test(e.name) && /launchWrapped\(\{|launchWrappedClaudeWorker\(/.test(readFileSync(p, 'utf8'))) found.push(p.slice(ROOT.length + 1));
      }
    };
    walk(scripts);
    // dispatch-smoke-launch spreads the dispatcher's own request (which carries the derived route) into the launcher.
    // The soak replay also forwards real dispatch requests, with detached process creation stubbed.
    const known = new Set([...SITES, 'scripts/operations/worker-wrapper-launch.mjs', 'scripts/lib/dispatch-smoke-launch.mjs',
      'scripts/conveyor/soak/breaks/claude-launch-route-boundaries.mjs']);
    expect(found.filter(f => !known.has(f))).toEqual([]);
  });
  it('the scanner flags a call without a route', () => {
    expect(callBodies('launchWrapped({ role: 1 })')[0]).not.toMatch(/\broute\s*[:,]/);
  });
  it('configured wrapped invocation coverage uses the real guard with only detached launch injected', () => {
    const src = readFileSync(join(ROOT, 'scripts/conveyor/__tests__/fix-executor-routing.test.mjs'), 'utf8');
    const body = src.slice(src.indexOf("'%s uses the configured %s invocation'"), src.indexOf("it.each(['reset', 'stand-down'])"));
    expect(body).toContain('launchWrappedClaudeWorker({ ...options, launch: detached })');
    expect(body).not.toMatch(/wrapper\s*=\s*vi\.fn/);
  });
});
