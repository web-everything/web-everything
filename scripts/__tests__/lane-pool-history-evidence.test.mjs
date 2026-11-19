import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';

const script = resolve('scripts/lane-pool.mjs');
const bogus = '1'.repeat(40);
const git = (args, cwd, input) => execFileSync('git', args, {
  cwd, input, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
}).trim();
let fixture, origin, reference, base, poolRoot, lane, state, evidence, observed;

function runPool(args, { failEvidenceWrite = false } = {}) {
  // Observe the durable evidence at the first repair mutation, not just after acquire exits.
  const preload = `import os from 'node:os'; import cp from 'node:child_process';
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    os.userInfo = () => ({ homedir: ${JSON.stringify(base)} });
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, ...rest) => {
      if (${failEvidenceWrite} && file === ${JSON.stringify(evidence)}) {
        write(${JSON.stringify(join(base, 'evidence-write-attempt'))}, 'ENOSPC');
        throw Object.assign(new Error('ENOSPC: injected evidence write failure'), { code: 'ENOSPC' });
      }
      return write(file, ...rest);
    };
    const original = cp.spawnSync;
    cp.spawnSync = (cmd, args, opts) => {
      if (${failEvidenceWrite} && cmd === 'git' && opts?.cwd === ${JSON.stringify(lane)} &&
          args[0] === 'config' && args.includes('core.commitGraph')) {
        write(${JSON.stringify(join(base, 'repair-invoked'))}, JSON.stringify(args));
      }
      if (cmd === 'git' && opts?.cwd === ${JSON.stringify(lane)} &&
          args[0] === 'config' && args[1] === 'core.commitGraph' && args[2] === 'false') {
        fs.writeFileSync(${JSON.stringify(observed)}, fs.readFileSync(${JSON.stringify(evidence)}));
      }
      return original(cmd, args, opts);
    }; syncBuiltinESMExports();`;
  const result = spawnSync(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(preload)}`,
    script, ...args, `--origin=${origin}`, `--reference=${reference}`, '--name=evidence',
    '--branch=main', '--no-install', '--session=evidence-holder', '--json'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    env: withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot, LANE_POOL_NO_RECOVER: '1',
      LANE_POOL_AUTO_RECOVER: '0', WE_LANE_BACKUP_ROOT: join(base, 'backups'),
      LANE_POOL_FREE_LIST_FILE: join(base, 'free.json') }),
  });
  expect(result.error).toBeUndefined();
  return result;
}

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'history-evidence-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'history-evidence-case-'));
  poolRoot = join(base, 'pool');
  lane = join(poolRoot, 'evidence', 'lane-1');
  state = join(poolRoot, 'evidence', '.quarantine-state', 'lane-1.json');
  evidence = join(poolRoot, 'evidence', '.quarantine-state', 'lane-1.evidence.jsonl');
  observed = join(base, 'evidence-before-heal.jsonl');
  const result = runPool(['provision', '--count=1']);
  expect(result.status, result.stderr).toBe(0);
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); fixture.restore(); });

function expectEvidence(sha) {
  const saved = readFileSync(evidence, 'utf8');
  expect(readFileSync(observed, 'utf8')).toBe(saved);
  const entry = JSON.parse(saved.trim());
  expect(entry).toEqual(expect.objectContaining({ lane: 1, head: 'refs/heads/main', sha,
    firstError: expect.any(String), at: expect.any(String) }));
  expect(entry.firstError.length).toBeGreaterThan(0);
  expect(new Date(entry.at).toISOString()).toBe(entry.at);
  return entry;
}

it('healed-readable history keeps evidence recorded before healing and proceeds', () => {
  const sha = git(['rev-parse', 'HEAD'], lane);
  mkdirSync(join(lane, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(lane, '.git', 'refs', 'heads', 'pr-1686'), `${bogus}\n`);
  const result = runPool(['acquire', '--lane=1']);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).lane).toBe(1);
  expect(result.stderr).toContain('deleted dangling ref refs/heads/pr-1686');
  const entry = expectEvidence(sha);
  expect(entry.refs).toContain(`${bogus} refs/heads/pr-1686`);
  expect(entry.firstError).toContain('local history tip missing or not a commit');
  expect(existsSync(state)).toBe(false);
  expect(existsSync(join(lane, '.git', 'refs', 'heads', 'pr-1686'))).toBe(false);
  expect(existsSync(join(lane, '.git', '.lane-lease'))).toBe(true);
  // Evidence alone must not poison subsequent acquisitions.
  expect(runPool(['acquire', '--lane=1']).status).toBe(0);
});

it('still-unreadable history quarantines and retains evidence recorded before healing', () => {
  const tree = git(['rev-parse', 'HEAD^{tree}'], lane);
  const sha = git(['hash-object', '-t', 'commit', '-w', '--stdin'], lane,
    `tree ${tree}\nparent ${bogus}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\nbroken parent\n`);
  git(['update-ref', 'HEAD', sha], lane);
  const result = runPool(['acquire', '--lane=1']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('QUARANTINED');
  const entry = expectEvidence(sha);
  expect(entry.firstError).toContain('Failed to traverse parents');
  expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual(expect.objectContaining({
    lane: 1, firstError: entry.firstError, reason: expect.stringContaining('history unreadable after two probes'),
  }));
  expect(git(['rev-parse', 'HEAD'], lane)).toBe(sha);
  expect(existsSync(join(lane, '.git', '.lane-lease'))).toBe(false);
});

it('failed evidence persistence refuses acquisition before repair and leaves HEAD and refs unchanged', () => {
  const dangling = join(lane, '.git', 'refs', 'heads', 'pr-1686');
  writeFileSync(dangling, `${bogus}\n`);
  const head = readFileSync(join(lane, '.git', 'HEAD'), 'utf8');
  const sha = git(['rev-parse', 'HEAD'], lane);
  const refs = git(['for-each-ref', '--format=%(objectname) %(refname)'], lane);
  const config = readFileSync(join(lane, '.git', 'config'), 'utf8');

  const result = runPool(['acquire', '--lane=1'], { failEvidenceWrite: true });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ENOSPC: injected evidence write failure');
  expect(readFileSync(join(base, 'evidence-write-attempt'), 'utf8')).toBe('ENOSPC');
  expect(existsSync(join(base, 'repair-invoked'))).toBe(false);
  expect(existsSync(observed)).toBe(false);
  expect(readFileSync(join(lane, '.git', 'HEAD'), 'utf8')).toBe(head);
  expect(git(['rev-parse', 'HEAD'], lane)).toBe(sha);
  expect(git(['for-each-ref', '--format=%(objectname) %(refname)'], lane)).toBe(refs);
  expect(readFileSync(dangling, 'utf8')).toBe(`${bogus}\n`);
  expect(readFileSync(join(lane, '.git', 'config'), 'utf8')).toBe(config);
  expect(existsSync(evidence)).toBe(false);
  expect(existsSync(state)).toBe(false);
  expect(existsSync(join(lane, '.git', '.lane-lease'))).toBe(false);
});
