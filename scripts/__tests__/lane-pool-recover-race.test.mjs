import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realRecoverIo, recoverPool, verifyRecoveryBackup } from '../lib/lane-pool-recover.mjs';
import { parseFeedLine } from '../operations/needs-you-feed.mjs';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';

const script = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const original = 'original card\n', changed = 'modified card\n'; // identical length defeats size-only verification
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
let root, origin, reference, base, laneDir, repo, sharedFixture;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lane-recover-race-'));
  origin = join(root, 'origin.git');
  reference = join(root, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  git(['clone', '--quiet', origin, reference]);
  mkdirSync(join(reference, 'backlog'));
  writeFileSync(join(reference, 'backlog', 'tracked-card.md'), 'committed card\n');
  git(['add', '.'], reference);
  git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'seed'], reference);
  git(['push', '--quiet', 'origin', 'main'], reference);
  sharedFixture = sharedRepos(root, [origin, reference]);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  base = mkdtempSync(join(root, 'case-'));
  const poolRoot = join(base, 'pool'), poolDir = join(poolRoot, 'racepool');
  laneDir = join(poolDir, 'lane-1');
  mkdirSync(poolDir, { recursive: true });
  git(['clone', '--quiet', origin, laneDir]);
  repo = { poolDir, name: 'racepool', originUrl: origin, referencePath: reference, branch: 'main' };
  vi.stubEnv('LANE_POOL_ROOT', poolRoot);
  const binDir = join(base, 'bin');
  mkdirSync(binDir);
  for (const [name, body] of [['claude', 'echo "[]"'], ['lsof', 'exit 0']]) {
    writeFileSync(join(binDir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(binDir, name), 0o755);
  }
  vi.stubEnv('PATH', `${binDir}:${withGhStub(process.env).PATH}`);
  vi.stubEnv('WE_LANE_SALVAGE_QUIET_MIN', '0');
});
afterEach(() => { vi.unstubAllEnvs(); sharedFixture.restore(); rmSync(base, { recursive: true, force: true }); });

// Exercise default recovery separately from the picker-only regression suites. All external IO is
// private: local origin, gh/claude/lsof stubs, backup root and needs-you feed under this case's temp dir.
function acquire(extraEnv = {}) {
  const env = { ...process.env, WE_LANE_BACKUP_ROOT: join(base, 'backups'), WE_NEEDS_YOU_FEED: join(base, 'needs-you.jsonl') };
  delete env.LANE_POOL_AUTO_RECOVER;
  delete env.LANE_POOL_NO_RECOVER;
  const result = spawnSync(process.execPath, [script, 'acquire', `--origin=${origin}`, `--reference=${reference}`,
    '--name=racepool', '--branch=main', '--no-install', '--no-reap', '--no-free-list', '--hard-max=1',
    '--wait-ms=0', '--session=recovery-picker', '--json'], {
    cwd: reference, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    env: { ...env, ...extraEnv },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBeNull();
  return result;
}

function backupFiles(dir = join(base, 'backups')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? backupFiles(path) : [path];
  });
}

describe('acquire default automatic recovery with private IO', () => {
  it('backs up an untracked card, reclaims once and retries acquire on the recovered lane', () => {
    const card = join(laneDir, 'backlog', 'new-card.md');
    writeFileSync(card, original);
    const result = acquire();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ lane: 1, path: laneDir });
    expect(result.stderr.match(/auto-recover: reclaimed 1/g)).toHaveLength(1);
    expect(existsSync(card)).toBe(false);
    const saved = backupFiles().filter(path => path.endsWith('/backlog/new-card.md'));
    expect(saved).toHaveLength(1);
    expect(readFileSync(saved[0], 'utf8')).toBe(original);
    expect(JSON.parse(readFileSync(join(laneDir, '.git', '.lane-lease'), 'utf8')).session).toBe('recovery-picker');
    expect(existsSync(join(base, 'needs-you.jsonl'))).toBe(false);
  }, 35_000);

  it('salvages an unpushed commit to the private origin before reclaim and acquire', () => {
    writeFileSync(join(laneDir, 'unpublished.txt'), 'unpublished work\n');
    git(['add', 'unpublished.txt'], laneDir);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'unpublished work'], laneDir);
    const sha = git(['rev-parse', 'HEAD'], laneDir).trim();
    const result = acquire();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ lane: 1, path: laneDir });
    expect(result.stderr.match(/auto-recover: reclaimed 1/g)).toHaveLength(1);
    const remote = git(['ls-remote', '--heads', origin, 'refs/heads/salvage/*'], reference).trim();
    expect(remote).toMatch(new RegExp(`^${sha}\\s+refs/heads/salvage/lane-1-`));
    const records = backupFiles().filter(path => path.endsWith('/salvage-ref.txt'));
    expect(records).toHaveLength(1);
    expect(readFileSync(records[0], 'utf8')).toContain(sha);
    expect(existsSync(join(laneDir, 'unpublished.txt'))).toBe(false);
  }, 35_000);

  it('keeps unrecoverable work, stops after one recovery pass and deduplicates the private needs-you notice', () => {
    const work = join(laneDir, 'unpublished.txt');
    writeFileSync(work, 'uncommitted work\n');
    for (let i = 0; i < 2; i++) {
      const result = acquire();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/no free lane/);
      expect(result.stderr.match(/auto-recover: reclaimed 0/g)).toHaveLength(1);
      expect(result.stderr).not.toContain('attention publish failed');
      expect(readFileSync(work, 'utf8')).toBe('uncommitted work\n');
      expect(existsSync(join(laneDir, '.git', '.lane-lease'))).toBe(false);
    }
    const events = readFileSync(join(base, 'needs-you.jsonl'), 'utf8').trim().split('\n').map(parseFeedLine);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'needs-you', repo: 'racepool' });
    expect(backupFiles()).toEqual([]);
  }, 65_000);

  it.each([{ LANE_POOL_AUTO_RECOVER: '0' }, { LANE_POOL_NO_RECOVER: '1' }])('preserves picker-only refusal with the documented opt-out: %j', env => {
    const card = join(laneDir, 'backlog', 'new-card.md');
    writeFileSync(card, original);
    const result = acquire(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no free lane/);
    expect(result.stderr).not.toContain('auto-recover:');
    expect(readFileSync(card, 'utf8')).toBe(original);
    expect(existsSync(join(laneDir, '.git', '.lane-lease'))).toBe(false);
    expect(backupFiles()).toEqual([]);
    expect(existsSync(join(base, 'needs-you.jsonl'))).toBe(false);
  }, 35_000);
});

async function recoverWithRace({ file = 'new-card.md', mutate = true, lanePoolPath = script, afterBackup } = {}) {
  const card = join(laneDir, 'backlog', file);
  writeFileSync(card, original);
  const io = realRecoverIo({ repo, lanePoolPath, backupRoot: join(base, 'backups'), isLeased: () => false });
  const backup = io.backup;
  let saved;
  io.backup = async n => {
    saved = await backup(n);
    expect(saved.ok, saved.error).toBe(true);
    expect(readFileSync(join(saved.dir, 'backlog', file), 'utf8')).toBe(original);
    if (mutate) writeFileSync(card, changed);
    if (afterBackup) afterBackup(saved);
    return saved;
  };
  const result = await recoverPool({ lanes: [1], io });
  expect(saved, JSON.stringify(result)).toBeDefined(); // excludes a vacuous refusal at proof time
  return { result, card, saved };
}

function assertRaceRefused({ result, card, saved }) {
  expect(result.backedUp).toEqual([1]);
  expect(result.reclaimed).toEqual([]);
  expect(result.keptUnpushed).toEqual([{ lane: 1, reason: expect.stringContaining('content changed after backup') }]);
  expect(readFileSync(card, 'utf8')).toBe(changed);
  expect(readFileSync(join(saved.dir, 'backlog', 'new-card.md'), 'utf8')).toBe(original);
  expect(existsSync(join(laneDir, '.git', '.lane-lease'))).toBe(false);
}

describe('automatic reclaim backup-to-reset guard', () => {
  it('keeps the real lane when matched salvage is followed by an unpreserved reclaim re-proof', async () => {
    writeFileSync(join(laneDir, 'unpublished.txt'), 'unpublished work\n');
    git(['add', 'unpublished.txt'], laneDir);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'unpublished work'], laneDir);
    const sha = git(['rev-parse', 'HEAD'], laneDir).trim();
    const io = realRecoverIo({ repo, lanePoolPath: script, backupRoot: join(base, 'backups'), isLeased: () => false });
    const proof = io.proof;
    io.proof = vi.fn(proof);
    io.salvage = vi.fn(() => ({ status: 'matched', unmatched: [] }));
    io.backup = vi.fn(io.backup);
    io.reclaim = vi.fn(io.reclaim);
    const result = await recoverPool({ lanes: [1], io });
    expect(io.proof).toHaveBeenCalledTimes(2);
    expect(io.salvage).toHaveBeenCalledTimes(1);
    expect(result.keptUnpushed).toEqual([{ lane: 1, reason: expect.stringMatching(/salvage|unpreserved/i) }]);
    expect(result.reclaimed).toEqual([]);
    expect(io.backup).not.toHaveBeenCalled();
    expect(io.reclaim).not.toHaveBeenCalled();
    expect(git(['rev-parse', 'HEAD'], laneDir).trim()).toBe(sha);
    expect(readFileSync(join(laneDir, 'unpublished.txt'), 'utf8')).toBe('unpublished work\n');
  });

  it('auto-recovery refuses card edits introduced after backup', async () => {
    assertRaceRefused(await recoverWithRace());
  });

  it('refuses same-size tracked card edits introduced after backup', async () => {
    const { result, card } = await recoverWithRace({ file: 'tracked-card.md' });
    expect(result.backedUp).toEqual([1]);
    expect(result.reclaimed).toEqual([]);
    expect(result.keptUnpushed[0].reason).toContain('content changed after backup');
    expect(readFileSync(card, 'utf8')).toBe(changed);
    expect(existsSync(join(laneDir, '.git', '.lane-lease'))).toBe(false);
  });

  it('reclaims an unchanged card after its verified backup', async () => {
    const { result, card } = await recoverWithRace({ mutate: false });
    expect(result.reclaimed).toEqual([1]);
    expect(result.keptUnpushed).toEqual([]);
    expect(existsSync(card)).toBe(false);
  });

  it('refuses an unreadable backup manifest and leaves the card intact', async () => {
    const { result, card } = await recoverWithRace({ mutate: false, afterBackup: saved => rmSync(saved.manifestPath) });
    expect(result.reclaimed).toEqual([]);
    expect(result.keptUnpushed[0].reason).toContain('recovery backup verification failed');
    expect(readFileSync(card, 'utf8')).toBe(original);
    expect(existsSync(join(laneDir, '.git', '.lane-lease'))).toBe(false);
  });

  it('refuses oversized card evidence with a manual-inspection fallback', () => {
    const file = 'backlog/large-card.md', manifestPath = join(base, 'manifest.json');
    writeFileSync(join(laneDir, file), Buffer.alloc(8 * 1024 * 1024 + 1));
    writeFileSync(manifestPath, JSON.stringify({ version: 1, files: { [file]: 'a'.repeat(64) } }));
    const result = verifyRecoveryBackup({ laneDir, manifestPath,
      proof: { unpreservedFiles: [file], unpreservedCommitShas: [] } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exceeds 8 MiB; inspect the lane manually/);
  });

  it('refuses an oversized manifest with an operator-visible recovery fallback', () => {
    const manifestPath = join(base, 'oversized-manifest.json');
    writeFileSync(manifestPath, ' '.repeat(1024 * 1024 + 1));
    const result = verifyRecoveryBackup({ laneDir, manifestPath,
      proof: { unpreservedFiles: [], unpreservedCommitShas: [] } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid backup manifest');
    expect(result.error).toContain('inspect the lane or retry recovery');
  });

  it('mutation control: removing the backup guard makes the named race assertion fail', async () => {
    const guard = 'if (process.env.WE_LANE_RECOVERY_BACKUP !== undefined) {';
    const source = readFileSync(script, 'utf8');
    expect(source.split(guard)).toHaveLength(2);
    // Keep imports pointed at the real modules; only the destructive-boundary guard is disabled.
    const mutant = source.replace(guard, 'if (false) {').replace(/from '(\.[^']+)'/g,
      (_, specifier) => `from '${pathToFileURL(resolve(dirname(script), specifier)).href}'`);
    const lanePoolPath = join(base, 'lane-pool-mutant.mjs');
    writeFileSync(lanePoolPath, mutant);
    const observed = await recoverWithRace({ lanePoolPath });
    expect(observed.result.reclaimed).toEqual([1]);
    expect(existsSync(observed.card)).toBe(false);
    expect(() => assertRaceRefused(observed)).toThrow();
  });
});
