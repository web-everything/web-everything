/**
 * @file scripts/__tests__/heavy-run-admitted-callers.test.mjs
 * @description Host-overload fix (heavy-enforce): every in-repo caller that starts a vitest or check-standards
 *   run itself takes a heavy-admission slot (or passes through when its own caller already holds one, via
 *   `WE_HEAVY_ADMISSION_HELD`). Audit of 2026-10-04:
 *     already admitted — mutation-check-io, test-selection (`vitest related`), dev/regression, verify-lane (holds
 *       the slot for its gate, related/scan halves and timeout retry run as children with HELD=1),
 *       codex-direct-task (`npm run check:standards` / `test:unit`, both admitted package scripts).
 *     no vitest spawn at all — probation-build-run (runs verify-lane), reconcile-pass (reads config paths only).
 *     fixed here — soak/run-shard.mjs, conformance-autofix.mjs, and the three package scripts below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');
const ADMITTED_PREFIX = 'node scripts/readiness/heavy-admission.mjs run -- ';

describe('package scripts that run vitest / check-standards are admitted', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  // `npm test` is plain `vitest` (watch mode, an interactive dev loop) — never wrapped (a watch run would hold a
  // slot forever); the PreToolUse guard denies it from Claude sessions and names the admitted form instead.
  const heavy = Object.entries(scripts).filter(([name, body]) => name !== 'test' && /\bvitest\b|check-standards\.mjs/.test(body));

  it('finds the heavy scripts at all (guards the filter)', () => {
    expect(heavy.map(([n]) => n)).toEqual(expect.arrayContaining(['test:unit', 'check:standards', 'test:integration:vitest', 'test:coverage:shard', 'check:validation-adherence']));
  });

  it.each(heavy)('%s', (_name, body) => {
    expect(body.startsWith(ADMITTED_PREFIX)).toBe(true);
  });
});

describe('scripts that spawn vitest / check-standards themselves go through admittedArgv', () => {
  it.each([
    ['scripts/conveyor/soak/run-shard.mjs'],
    ['scripts/conformance-autofix.mjs'],
    ['scripts/operations/mutation-check-io.mjs'],
    ['scripts/readiness/test-selection.mjs'],
    ['scripts/dev/regression.mjs'],
  ])('%s', (file) => {
    const src = read(file);
    expect(src).toMatch(/import \{[^}]*\badmittedArgv\b[^}]*\} from '[./]*(?:readiness\/)?heavy-admission\.mjs'/);
    expect(src).toMatch(/admittedArgv\(/);
  });

  it('run-shard no longer spawns a bare vitest', () => {
    expect(read('scripts/conveyor/soak/run-shard.mjs')).not.toMatch(/spawnSync\('vitest'/);
  });

  it('conformance-autofix no longer runs check-standards.mjs bare', () => {
    expect(read('scripts/conformance-autofix.mjs')).not.toMatch(/execFileSync\('node', \[CHECK/);
  });
});
