// @vitest-environment node
// PR #4279 review finding — the unit-shard step must FAIL when shard-assign.mjs fails or hands back no files.
// `mapfile -t files < <(node …)` swallows the producer's exit status (bash does not propagate a process
// substitution's status), so a rejected assignment ran vitest with NO file filters = the whole suite in every
// shard. This test runs the real `run:` script of the step under GitHub's default `bash -e` with stub `node` /
// `npm` binaries and asserts vitest is never invoked on a bad assignment.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const raw = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const step = yaml.load(raw).jobs['test-shard'].steps.find((s) => /^Unit suite shard/.test(s.name ?? ''));
const script = step.run.replaceAll('${{ matrix.shard }}', '1').replaceAll('${{ strategy.job-total }}', '4');

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'unit-shard-step-'));
  mkdirSync(join(dir, 'bin'));
  // Stub `node`: behaviour chosen by STUB_ASSIGN; stub `npm` records its argv so we can see if vitest would launch.
  writeFileSync(join(dir, 'bin', 'node'), [
    '#!/bin/bash',
    'case "$STUB_ASSIGN" in',
    '  fail) echo "shard-assign: filter is a substring of another test path" >&2; exit 2 ;;',
    '  fail-after-output) echo "a.test.ts"; exit 2 ;;',
    '  empty) exit 0 ;;',
    '  ok) printf "a.test.ts\\nb/c.test.ts\\n"; exit 0 ;;',
    'esac',
  ].join('\n'));
  writeFileSync(join(dir, 'bin', 'npm'), `#!/bin/bash\nprintf '%s\\n' "$@" > "${dir}/npm-args"\n`);
  chmodSync(join(dir, 'bin', 'node'), 0o755);
  chmodSync(join(dir, 'bin', 'npm'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runStep(assign) {
  const r = spawnSync('bash', ['-e', '-c', script], {
    cwd: dir,
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, STUB_ASSIGN: assign },
    encoding: 'utf8',
  });
  return { ...r, npmCalled: existsSync(join(dir, 'npm-args')), npmArgs: existsSync(join(dir, 'npm-args')) ? readFileSync(join(dir, 'npm-args'), 'utf8').split('\n').filter(Boolean) : [] };
}

describe('ci.yml unit-shard step — assignment failure prevents vitest invocation', () => {
  it('fails the step and never launches vitest when shard-assign exits non-zero', () => {
    const r = runStep('fail');
    expect(r.status).not.toBe(0);
    expect(r.npmCalled).toBe(false);
  });

  it('fails the step even when shard-assign printed some files before exiting non-zero', () => {
    const r = runStep('fail-after-output');
    expect(r.status).not.toBe(0);
    expect(r.npmCalled).toBe(false);
  });

  it('fails the step and never launches vitest when the assignment is empty (no filters = whole suite)', () => {
    const r = runStep('empty');
    expect(r.status).not.toBe(0);
    expect(r.npmCalled).toBe(false);
  });

  it('passes each assigned file to vitest as its own filter on success', () => {
    const r = runStep('ok');
    expect(r.status).toBe(0);
    expect(r.npmArgs.slice(-2)).toEqual(['a.test.ts', 'b/c.test.ts']);
  });

  it('never feeds a test selection through process substitution (its exit status is dropped)', () => {
    expect(script).not.toMatch(/<\s*<\(/);
  });
});
