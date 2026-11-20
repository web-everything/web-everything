import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkoutHasRetryableTestUnit, scanRetryCommand } from '../verify-remote-routing.mjs';
import { scanCommands } from '../repo-scan-tests.mjs';
import { shellQuote } from '../verify-lane-gate.mjs';
import { retryFailedPhase } from '../gate-timeout-retry.mjs';
import { createFailureCollector } from '../verify-failures.mjs';

const unit = 'node scripts/readiness/heavy-admission.mjs run -- vitest run';

describe('full-gate retry package evidence', () => {
  it.each([
    ['exact admission-wrapped Vitest', { 'test:unit': unit }, true],
    ['pre hook', { 'test:unit': unit, 'pretest:unit': 'node pre.mjs' }, false],
    ['post hook', { 'test:unit': unit, 'posttest:unit': 'node post.mjs' }, false],
    ['empty hook', { 'test:unit': unit, 'posttest:unit': '' }, false],
    ['extra check', { 'test:unit': `${unit} && node check.mjs` }, false],
    ['custom flags', { 'test:unit': `${unit} --config other.mjs` }, false],
    ['unwrapped runner', { 'test:unit': 'vitest run' }, false],
    ['trailing newline', { 'test:unit': `${unit}\n` }, false],
    ['missing script', {}, false],
    ['unknown scripts shape', null, false],
  ])('%s is checked from the target checkout at runtime', (_, scripts, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-retry-package-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
      expect(checkoutHasRetryableTestUnit(dir)).toBe(expected);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:unit': unit, 'posttest:unit': 'node new-hook.mjs' } }));
      expect(checkoutHasRetryableTestUnit(dir)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['missing', 'malformed', 'oversized', 'directory'])('%s package evidence refuses retries; retain red for a fresh verify', mode => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-retry-package-'));
    try {
      const path = join(dir, 'package.json');
      if (mode === 'malformed') writeFileSync(path, '{');
      if (mode === 'oversized') writeFileSync(path, JSON.stringify({ scripts: { 'test:unit': unit }, pad: 'x'.repeat(65536) }));
      if (mode === 'directory') mkdirSync(path);
      expect(checkoutHasRetryableTestUnit(dir)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('unreadable package evidence refuses retries', () => {
    expect(checkoutHasRetryableTestUnit('.', () => { throw Error('EACCES'); })).toBe(false);
  });
});

describe('scan retry inputs', () => {
  const scan = files => scanCommands({ changedFiles: files,
    fileExists: file => file === 'scripts/lib/__tests__/exec-output-guard.test.mjs' })[0];

  it('an untracked deterministic violation stays red on retry with identical VERIFY_SCAN_FILES', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-scan-retry-'));
    try {
      execFileSync('git', ['init', '-q', dir]);
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(join(dir, 'scripts/tracked.mjs'), 'safe');
      execFileSync('git', ['add', '.'], { cwd: dir });
      writeFileSync(join(dir, 'scripts/untracked.mjs'), 'violation');
      writeFileSync(join(dir, 'probe.mjs'), `
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = process.env.VERIFY_SCAN_FILES ? JSON.parse(process.env.VERIFY_SCAN_FILES)
  : execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\\n');
const bad = files.some(file => readFileSync(file, 'utf8') === 'violation');
console.log(JSON.stringify({ scope: process.env.VERIFY_SCAN_FILES, bad }));
process.exitCode = bad ? 1 : 0;
`);
      const command = scan(['scripts/untracked.mjs']);
      const argv = [process.execPath, 'probe.mjs'];
      const run = cmd => spawnSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', env: { ...process.env, VERIFY_SCAN_FILES: undefined } });
      const original = run(command.slice(0, command.indexOf('npx vitest')) + argv.map(shellQuote).join(' '));
      expect(original.status, original.stderr).toBe(1);
      // Without the prefix, the tracked-only enumeration misses the deterministic violation.
      expect(run(argv.map(shellQuote).join(' ')).status).toBe(0);
      const stderr = ' FAIL a.test.mjs > deterministic violation\nAssertionError: bad\n';
      const stdout = ' Test Files 1 failed\n Tests 1 failed\n Duration 1s\n';
      const collector = createFailureCollector({ cwd: dir });
      collector.push(stderr, 'stderr'); collector.push(stdout);
      const red = { exitCode: 1, output: { stdout, stderr }, failureDetails: collector.finish() };
      let runs = 0;
      const audit = await retryFailedPhase({ result: red, attempts: 1, cwd: dir, mode: 'all', infrastructureFailure: () => false,
        run: async () => {
          runs++;
          const retry = run(scanRetryCommand(command, argv));
          expect(retry.status, retry.stderr).toBe(1);
          expect(retry.stdout).toBe(original.stdout);
          return { ...red, exitCode: retry.status };
        } });
      expect(runs).toBe(1);
      expect(audit.result.exitCode).toBe(1);
      expect(audit.flakes).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('full scans preserve the inherited environment without adding a scope', () => {
    expect(scanRetryCommand('npx vitest run scan.test.mjs', ['npx', 'vitest', 'run', './scan.test.mjs']))
      .toBe("'npx' 'vitest' 'run' './scan.test.mjs'");
  });

  it.each([
    undefined, 'UNKNOWN=value npx vitest run scan.test.mjs',
    "VERIFY_SCAN_FILES='[bad' npx vitest run scan.test.mjs",
    'npx vitest run scan.test.mjs && echo extra',
    `VERIFY_SCAN_FILES='${JSON.stringify(['scripts/' + 'x'.repeat(65536)])}' npx vitest run scan.test.mjs`,
  ])('unreproducible or oversized scan context refuses retry (%#)', command => {
    expect(scanRetryCommand(command, ['npx', 'vitest', 'run'])).toBeNull();
  });

  it('verify-lane wires package eligibility and each original scan command into recovery', () => {
    const source = readFileSync(resolve('scripts/verify-lane.mjs'), 'utf8');
    expect(source).toContain('&& checkoutHasRetryableTestUnit(REPO)');
    expect(source).toContain("retryPhase(scan, 'scan', previousOutcome, scanCommand)");
    expect(source).toContain('scanRetryCommand(scanCommand, argv)');
    expect(source).toContain('scan stays red: cannot reproduce its environment');
  });
});
