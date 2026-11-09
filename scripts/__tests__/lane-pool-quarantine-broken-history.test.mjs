import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';

const script = resolve('scripts/lane-pool.mjs');
const git = (args, cwd, input) => execFileSync('git', args, {
  cwd, input, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
}).trim();
let fixture, base, origin, reference, poolRoot, poolDir, laneDir, record, marker;
function runPool(args, fault = '', json = true) {
  const preload = `import os from 'node:os'; import cp from 'node:child_process';
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    os.userInfo = () => ({ homedir: ${JSON.stringify(base)} });
    const original = cp.execFileSync; let failures = 0;
    cp.execFileSync = (cmd, args, opts) => {
      if (opts?.cwd === ${JSON.stringify(laneDir)}) { ${fault} }
      return original(cmd, args, opts);
    }; syncBuiltinESMExports();`;
  const result = spawnSync(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(preload)}`,
    script, ...args, `--origin=${origin}`, `--reference=${reference}`, '--name=historyguard',
    '--branch=main', '--no-install', '--session=history-holder', ...(json ? ['--json'] : [])], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    env: withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot, LANE_POOL_NO_RECOVER: '1',
      LANE_POOL_AUTO_RECOVER: '0', WE_LANE_BACKUP_ROOT: join(base, 'backups'),
      LANE_POOL_FREE_LIST_FILE: join(base, 'free.json') }),
  });
  expect(result.error).toBeUndefined();
  return { ...result, data: json && result.stdout.trim() ? JSON.parse(result.stdout) : null };
}
function quarantine() {
  mkdirSync(join(poolDir, '.quarantine-state'), { recursive: true });
  writeFileSync(record, JSON.stringify({ lane: 1, reason: 'history unreadable: missing parent',
    at: new Date().toISOString(), firstError: 'missing parent' }));
}
function corruptHistory() {
  // A valid tip/tree with an absent parent: no shared object is removed or modified.
  const tree = git(['rev-parse', 'HEAD^{tree}'], laneDir);
  const sha = git(['hash-object', '-t', 'commit', '-w', '--stdin'], laneDir,
    `tree ${tree}\nparent ${'1'.repeat(40)}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\nbroken parent\n`);
  git(['update-ref', 'HEAD', sha], laneDir);
  expect(() => git(['rev-list', '--max-count=200', 'HEAD'], laneDir)).toThrow();
  return sha;
}
beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'history-guard-fixture-'));
  origin = join(root, 'origin.git');
  reference = join(root, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  git(['clone', '--quiet', origin, reference]);
  writeFileSync(join(reference, 'seed.txt'), 'seed\n');
  git(['add', '.'], reference);
  git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'seed'], reference);
  git(['push', '--quiet', 'origin', 'main'], reference);
  fixture = sharedRepos(root, [origin, reference]);
});
afterAll(() => fixture?.dispose());
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'history-guard-case-'));
  poolRoot = join(base, 'pool');
  poolDir = join(poolRoot, 'historyguard');
  laneDir = join(poolDir, 'lane-1');
  marker = join(laneDir, '.git', '.lane-lease');
  record = join(poolDir, '.quarantine-state', 'lane-1.json');
  expect(runPool(['provision', '--count=2']).status).toBe(0);
  writeFileSync(join(base, 'free.json'), JSON.stringify({ v: 1, writtenAt: Date.now(),
    repo: 'historyguard', poolDir, lanes: [1, 2].map(lane => ({ lane })) }));
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); fixture.restore(); });

it('quarantines unreadable history, drops its claim, acquires a healthy lane and reports the reason', () => {
  const sha = corruptHistory();
  const result = runPool(['acquire', '--no-reset']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.data.lane).toBe(2);
  const saved = JSON.parse(readFileSync(record, 'utf8'));
  expect(saved).toEqual(expect.objectContaining({ lane: 1, reason: expect.stringMatching(/history.*unreadable/i),
    at: expect.any(String), firstError: expect.stringContaining('Failed to traverse parents') }));
  expect(existsSync(marker)).toBe(false);
  expect(git(['rev-parse', 'HEAD'], laneDir)).toBe(sha);
  const status = runPool(['status']);
  expect(status.data.lanes[0]).toEqual(expect.objectContaining({ status: 'QUARANTINED', reason: saved.reason }));
  const text = runPool(['status'], '', false);
  expect(text.stderr).toContain('QUARANTINED');
  expect(text.stderr).toContain(saved.reason);
  expect(text.stderr).toContain(`remove ${record} manually`);
});

it('skips an existing quarantine before claiming and refuses explicit acquire with its reason', () => {
  quarantine();
  const fault = `if (args.includes('rev-list')) throw new Error('quarantined lane must not be probed');`;
  const result = runPool(['acquire', '--no-reset'], fault);
  expect(result.status, result.stderr).toBe(0);
  expect(result.data.lane).toBe(2);
  expect(existsSync(marker)).toBe(false);
  const explicit = runPool(['acquire', '--lane=1', '--no-reset']);
  expect(explicit.status).toBe(1);
  expect(explicit.stderr).toContain('history unreadable: missing parent');
});

it('retries a single transient history failure without quarantining', () => {
  const fault = `if (args.includes('rev-list') && args.includes('--max-count=200')) {
    fs.appendFileSync(${JSON.stringify(join(base, 'probes'))}, 'probe\\n');
    if (failures++ === 0) throw new Error('transient history read');
  }`;
  const result = runPool(['acquire', '--no-reset'], fault);
  expect(result.status, result.stderr).toBe(0);
  expect(result.data.lane).toBe(1);
  expect(readFileSync(join(base, 'probes'), 'utf8').trim().split('\n')).toHaveLength(2);
  expect(existsSync(record)).toBe(false);
});

it.each(['unreadable branch history', 'output-too-large'])('quarantines persistent release traversal failure (%s) after exactly two probes', failure => {
  const probes = join(base, 'probes');
  const result = runPool(['acquire', '--no-reset'],
    `if (args.includes('rev-list') && args.includes('--stdin')) {
      fs.appendFileSync(${JSON.stringify(probes)}, 'probe\\n');
      const error = new Error(${JSON.stringify(failure)});
      ${failure === 'output-too-large' ? "error.code = 'ENOBUFS';" : ''}
      throw error;
    }`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.data.lane).toBe(2);
  expect(readFileSync(probes, 'utf8').trim().split('\n')).toHaveLength(2);
  expect(JSON.parse(readFileSync(record, 'utf8')).firstError).toContain(failure);
  expect(existsSync(marker)).toBe(false);
  if (failure === 'output-too-large') expect(runPool(['status'], '', false).stderr).toContain('probe limits');
});

it('release still fails closed on unreadable commit evidence and preserves a quarantined lease', () => {
  expect(runPool(['acquire', '--lane=1', '--no-reset']).status).toBe(0);
  const lease = readFileSync(marker, 'utf8');
  corruptHistory();
  quarantine();
  const result = runPool(['release', '--lane=1', '--force']);
  expect(result.status).toBe(1);
  expect(result.data.released).toBe(0);
  expect(result.stderr).toContain('commit evidence unreadable');
  expect(readFileSync(marker, 'utf8')).toBe(lease);
});

it('quarantine does not block release under the existing rules', () => {
  expect(runPool(['acquire', '--lane=1', '--no-reset']).status).toBe(0);
  quarantine();
  const result = runPool(['release', '--lane=1', '--force']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.data.released).toBe(1);
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(record)).toBe(true);
});
