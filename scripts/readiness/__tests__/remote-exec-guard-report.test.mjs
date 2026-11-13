import { it, expect } from 'vitest';
import { splitGuardReport, parseGuardReport, withGuardReport } from '../remote-exec.mjs';

const argv = ['npx', 'vitest', 'run', 'scripts/a.test.mjs', '--reporter=default', '--reporter=json', '--outputFile.json=/tmp/we/report.json'];

it('splits an absolute json report path from the remote argv', () => {
  const split = splitGuardReport(argv);
  expect(split.outputFile).toBe('/tmp/we/report.json');
  expect(split.argv).toEqual(argv.slice(0, -1));
});

it('leaves other commands, relative paths and traversal untouched', () => {
  expect(splitGuardReport(['npx', 'vitest', 'run', 'a', '--outputFile.json=rel.json', '--reporter=json']).outputFile).toBeUndefined();
  expect(splitGuardReport([...argv.slice(0, -1), '--outputFile.json=/tmp/../etc/x.json']).outputFile).toBeUndefined();
  expect(splitGuardReport(['npm', 'run', 'test:unit', '--', '--outputFile.json=/tmp/x.json']).outputFile).toBeUndefined();
});

it('remaps Forge paths in the stdout report to the lane root', () => {
  const report = { numTotalTestSuites: 1, testResults: [{ name: '/work/run1/scripts/a.test.mjs', assertionResults: [{ status: 'passed' }] }] };
  const stdout = Buffer.from(`✓ scripts/a.test.mjs (1 test)\n${JSON.stringify(report, null, 2)}\n`);
  const parsed = JSON.parse(parseGuardReport(stdout, ['scripts/a.test.mjs'], '/lane', '/work/run1'));
  expect(parsed.testResults[0].name).toBe('/lane/scripts/a.test.mjs');
});

it('never credits a nested or suffix-matching test as the guard file', () => {
  const report = { numTotalTestSuites: 2, testResults: [
    { name: '/work/r-123/fixtures/scripts/a.test.mjs', assertionResults: [{ status: 'failed' }] },
    { name: '/elsewhere/work/r-123/scripts/a.test.mjs', assertionResults: [{ status: 'failed' }] },
  ] };
  const parsed = JSON.parse(parseGuardReport(Buffer.from(JSON.stringify(report)), ['scripts/a.test.mjs'], '/lane', '/work/r-123'));
  expect(parsed.testResults.map(t => t.name)).toEqual([
    '/work/r-123/fixtures/scripts/a.test.mjs', '/elsewhere/work/r-123/scripts/a.test.mjs']);
});

it('fails closed on remapping when no Forge run root is known', () => {
  const report = { numTotalTestSuites: 1, testResults: [{ name: '/work/r-123/scripts/a.test.mjs', assertionResults: [] }] };
  const parsed = JSON.parse(parseGuardReport(Buffer.from(JSON.stringify(report)), ['scripts/a.test.mjs'], '/lane'));
  expect(parsed.testResults[0].name).toBe('/work/r-123/scripts/a.test.mjs');
});

it('returns null for a missing or unparseable report (fail closed)', () => {
  expect(parseGuardReport(Buffer.from('no report here'), ['a'], '/lane')).toBeNull();
  expect(parseGuardReport(Buffer.from('{"numTotalTestSuites": 1, "testResults": '), ['a'], '/lane')).toBeNull();
  expect(parseGuardReport(Buffer.from('{"numTotalTestSuites": 1}'), ['a'], '/lane')).toBeNull();
});

it('re-attaches the guard report destination for a delta-to-full retry', () => {
  const split = splitGuardReport(argv);
  const retryArgv = withGuardReport(split.argv, split.outputFile);
  expect(retryArgv).toEqual(argv);
  expect(splitGuardReport(retryArgv).outputFile).toBe('/tmp/we/report.json');
  expect(withGuardReport(split.argv, undefined)).toEqual(split.argv);
});

it('every recursive executeRemote retry re-attaches the guard report destination', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(join(process.cwd(), 'scripts/readiness/remote-exec.mjs'), 'utf8');
  // The delta-to-full retry sites (transfer failure and protected delta rejection) are the recursive calls with disableDelta:true.
  const inner = source.split('\n').filter(line => /disableDelta:true/.test(line) && /executeRemote\(\{argv/.test(line));
  expect(inner).toHaveLength(2);
  for (const line of inner) expect(line).toContain('argv:withGuardReport(argv,guardOutputFile)');
});

// ---- executeRemote write-back behaviour (guard report returned over stdout) ----
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, statSync, rmSync, realpathSync } from 'node:fs';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { vi, beforeEach, afterEach, describe } from 'vitest';
import { runRemote as timedRunRemote } from '../remote-exec.mjs';
import { resolveAdmissionPolicy, runWithRemoteDecision } from '../heavy-admission.mjs';
import { gitArgs, bindingEvidence } from './fixtures/forge-bound-git.mjs';

vi.mock('../forge-telemetry.mjs', async importOriginal => {
  const actual = await importOriginal();
  const { easternTimestamp } = await import('../forge-exec-run.mjs');
  return { ...actual, readForgeTelemetry: async () => ({ sampledAtET: easternTimestamp(Date.now()), cores: 8, loadPerCore: 0.1, memFreePct: 90, activeRuns: 0, recent: [] }) };
});

describe('executeRemote guard report write-back', () => {
  let cwd, reportDir, dest;
  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(process.env.TMPDIR, 'remote-guard-report-')));
    // The report directory lives outside the lane checkout, like the real verify report directory.
    reportDir = realpathSync(mkdtempSync(join(process.env.TMPDIR, 'remote-guard-report-dest-')));
    dest = join(reportDir, 'guard.json');
    writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
    writeFileSync(join(cwd, 'a.test.mjs'), 'fixture');
  });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(reportDir, { recursive: true, force: true }); });

  const guardArgv = () => ['npx', 'vitest', 'run', 'a.test.mjs', '--reporter=json', `--outputFile.json=${dest}`];
  const reportFor = root => JSON.stringify({ numTotalTestSuites: 1, testResults: [{ name: `${root}/a.test.mjs`, assertionResults: [{ status: 'passed' }] }] });

  // Fake Forge: `emit(call, root)` decides what the run phase streams to the client's onOutput hook.
  function fixture({ runCode = 0, emit } = {}) {
    let state, root;
    const exec = vi.fn(async call => {
      const text = call.args.join(' ');
      if (call.file === 'git') {
        const binding = bindingEvidence(call); if (binding) return binding;
        if (gitArgs(call).join(' ') === 'rev-parse HEAD') return { code: 0, stdout: Buffer.from('a'.repeat(40) + '\n') };
        if (call.args.includes('-i')) return { code: 0, stdout: Buffer.alloc(0) };
        const files = ['package-lock.json', 'a.test.mjs'];
        const records = call.args.includes('--stage') ? files.map(name => {
          const content = readFileSync(join(cwd, name));
          return `100644 ${createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')} 0\t${name}`;
        }) : files;
        return { code: 0, stdout: Buffer.from(records.join('\0') + '\0') };
      }
      if (call.file === 'rsync') { root = call.args.at(-1).replace(/^[^:]+:/, '').replace(/\/$/, ''); return { code: 0, stdout: '' }; }
      if (call.file === 'ssh' && text.endsWith(' bases')) return { code: 254, stdout: '' };
      if (call.file === 'ssh' && text.endsWith(' prepare')) {
        state = JSON.parse(call.input); state.run = 'r-' + state.nonce;
        return { code: 0, stdout: JSON.stringify({ run: state.run, capabilities: { siblings: 1, commandClasses: 1, gitWorktree: 2 } }) };
      }
      if (call.file === 'ssh' && text.endsWith(' run')) { state = { ...state, ...JSON.parse(call.input) }; emit?.(call, root); return { code: runCode, stdout: '' }; }
      if (call.file === 'ssh' && text.endsWith(' finish')) {
        return { code: 0, stdout: JSON.stringify({ v: 1, nonce: state.nonce, run: state.run, inputDigest: state.inputDigest, argvDigest: state.argvDigest, lock: state.lock, manifestDigest: state.manifestDigest, ...(state.siblingShas ? { siblingShas: state.siblingShas } : {}), phase: 'test', code: runCode }) };
      }
      if (call.file === 'ssh' && call.args.at(-1) === 'true') return { code: 0, stdout: '' };
      throw new Error(`Unexpected exec call: ${JSON.stringify(call)}`);
    });
    const writes = [];
    const fs = { ...filesystem, writeFile: (path, ...rest) => { writes.push(String(path)); return filesystem.writeFile(path, ...rest); } };
    return { exec, writes, fs, listFiles: vi.fn(async () => ['package-lock.json', 'a.test.mjs']), argv: guardArgv(), cwd, lockRoot: join(cwd, 'heavy'), env: {}, runId: 'abcdef-1' };
  }
  const run = async f => { const { timings, ...result } = await timedRunRemote(f); return result; };
  const reportWrites = f => f.writes.filter(path => path.startsWith(reportDir));

  it('writes the streamed stdout report to the requested file only, remapped to the lane root, mode 0600', async () => {
    const f = fixture({ emit: (call, root) => { const text = `✓ a.test.mjs\n${reportFor(root)}\n`; call.onOutput(text.slice(0, 9), 'stdout'); call.onOutput(text.slice(9), 'stdout'); } });
    expect(await run(f)).toMatchObject({ mode: 'remote', code: 0 });
    expect(JSON.parse(readFileSync(dest, 'utf8')).testResults[0].name).toBe(join(cwd, 'a.test.mjs'));
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(reportWrites(f)).toEqual([dest]);
    expect(readdirSync(reportDir)).toEqual(['guard.json']);
    expect(readdirSync(cwd).filter(name => name !== '.git').sort()).toEqual(['a.test.mjs', 'package-lock.json']);
  });

  it('a green run without a usable report returns guard-report-unavailable and writes nothing', async () => {
    const f = fixture({ emit: call => call.onOutput('no report in this output\n', 'stdout') });
    expect(await run(f)).toEqual({ mode: 'cancelled', terminated: true, code: 1, reason: 'guard-report-unavailable' });
    expect(existsSync(dest)).toBe(false);
    expect(reportWrites(f)).toEqual([]);
  });

  it('a red run without a usable report keeps its remote verdict and writes nothing', async () => {
    const f = fixture({ runCode: 1, emit: call => call.onOutput('no report in this output\n', 'stdout') });
    expect(await run(f)).toMatchObject({ mode: 'remote', code: 1 });
    expect(existsSync(dest)).toBe(false);
  });

  it('a report that appears only on stderr is never written (stdout only)', async () => {
    const f = fixture({ emit: (call, root) => call.onOutput(reportFor(root), 'stderr') });
    expect(await run(f)).toMatchObject({ reason: 'guard-report-unavailable' });
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a symlinked report destination and leaves its target untouched', async () => {
    const target = join(reportDir, 'victim.json');
    writeFileSync(target, 'original');
    symlinkSync(target, dest);
    const f = fixture({ emit: (call, root) => call.onOutput(reportFor(root), 'stdout') });
    expect(await run(f)).toMatchObject({ reason: 'guard-report-unavailable' });
    expect(readFileSync(target, 'utf8')).toBe('original');
    expect(reportWrites(f)).toEqual([]);
  });

  it('an unwritable destination (missing directory) is a missing report, not a thrown error', async () => {
    dest = join(reportDir, 'no-such-dir', 'guard.json');
    const f = fixture({ emit: (call, root) => call.onOutput(reportFor(root), 'stdout') });
    expect(await run(f)).toMatchObject({ reason: 'guard-report-unavailable' });
  });

  it('stdout beyond the 16 MiB cap is not credited as a report', async () => {
    const f = fixture({ emit: (call, root) => { call.onOutput(Buffer.alloc(17 * 1024 * 1024, 120), 'stdout'); call.onOutput(reportFor(root), 'stdout'); } });
    expect(await run(f)).toMatchObject({ reason: 'guard-report-unavailable' });
    expect(existsSync(dest)).toBe(false);
  });

  it('a green run without a usable report is rerun through local admission (no remote verdict kept)', async () => {
    const f = fixture({ emit: call => call.onOutput('no report\n', 'stdout') });
    const log = vi.fn();
    expect(await runWithRemoteDecision({ argv: f.argv, cwd, env: {}, lockRoot: f.lockRoot, log, loadPerCore: () => 0,
      policy: resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always' } } }),
      remoteExec: async () => {
        const result = await run({ ...f, argv: f.argv });
        expect(result).toMatchObject({ reason: 'guard-report-unavailable', terminated: true });
        return result;
      },
    })).toEqual({ handled: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('falling back to local admission'));
    expect(existsSync(dest)).toBe(false);
  });
});
