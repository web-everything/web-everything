/** Audit 3: Git is the code authority; checkout-copy receipts cannot authorize npm stores. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

const io = vi.hoisted(() => {
  vi.resetModules();
  return { exec: vi.fn(), realExec: null };
});
vi.mock('node:child_process', async original => {
  const actual = await original();
  io.realExec = actual.execFileSync;
  return { ...actual, execFileSync: (...args) => io.exec(...args) };
});

import { rebuildClone } from '../daemon-rebuild.mjs';
import * as snapshots from '../daemon-job-snapshots.mjs';
import * as jobs from '../daemon-rebuild/rebuild-job.mjs';
import * as origin from '../daemon-self-sync.mjs';
import * as watches from '../daemon-force-adopt.mjs';
import * as overlays from '../overlay-adoption.mjs';
import { createJobStore, prepareJobCode } from '../daemon-jobs-runtime.mjs';
import { writeReadyCandidate } from '../daemon-rebuild/state.mjs';

const ensureCode = snapshots.ensureCodeSnapshot;
const asJob = jobs.rebuildCloneAsJob;
const CLI = 'scripts/lib/daemon-rebuild.mjs';
const CODE = '// committed main CLI\n';
const MANIFEST = '{"name":"audit3","dependencies":{"pkg":"1.0.0"}}\n';
const LOCK = JSON.stringify({ name: 'audit3', lockfileVersion: 3, packages: {
  '': { dependencies: { pkg: '1.0.0' } }, 'node_modules/pkg': { version: '1.0.0' },
} });
const INTEGRITY = '.snapshot-integrity.json';
const VERIFIED = 'npm-ci dependency\n';
const LEGACY = 'checkout-copied dependency\n';
const IDLE = { moved: false, reason: 'needs-build' };
const quiet = { error() {}, warn() {}, log() {} };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const put = (root, path, bytes) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
};
const receipt = dir => JSON.parse(readFileSync(join(dir, INTEGRITY), 'utf8'));
let base;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'adopter-audit3-'));
  io.exec.mockReset();
  io.exec.mockImplementation((command, argv, options) => {
    if (command === 'npm' && argv[0] === 'ci') {
      expect(argv).toEqual(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
      expect(readFileSync(join(options.cwd, 'package.json'), 'utf8')).toBe(MANIFEST);
      expect(readFileSync(join(options.cwd, 'package-lock.json'), 'utf8')).toBe(LOCK);
      put(options.cwd, 'node_modules/pkg/index.js', VERIFIED);
      return '';
    }
    // Only local Git/archive processes run; no npm, network, or adopter process escapes.
    if (command === 'git' || command === 'tar') {
      return io.realExec(command, argv, { ...options, timeout: 10_000, maxBuffer: 1024 * 1024 });
    }
    throw new Error(`Unexpected process: ${command}`);
  });
  vi.spyOn(watches, 'runForceWatchTick').mockResolvedValue({});
  vi.spyOn(overlays, 'checkPendingAdoptions').mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

function fixture() {
  const root = join(base, 'checkout');
  mkdirSync(root, { recursive: true });
  const git = (...args) => io.realExec('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  }).trim();
  git('init', '--quiet', '--template=');
  put(root, CLI, CODE);
  put(root, 'tracked.txt', 'committed file\n');
  put(root, 'package.json', MANIFEST);
  put(root, 'package-lock.json', LOCK);
  git('add', '.');
  git('-c', 'user.name=Audit fixture', '-c', 'user.email=audit@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture');
  const main = git('rev-parse', 'HEAD');
  const expectedBlobs = new Map(git('ls-tree', '-r', main).split('\n').map(line => {
    const [entry, path] = line.split('\t');
    return [path, entry.split(' ')[2]];
  }));
  // The moving checkout is deliberately not the source of pinned code or dependencies.
  put(root, CLI, '// uncommitted moving checkout\n');
  put(root, 'node_modules/pkg/index.js', LEGACY);
  const env = {
    WE_DAEMON_STATE_DIR: join(base, 'state'), WE_DAEMON_JOBS_ROOT: join(base, 'jobs'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(base, 'locks'), WE_DAEMON_AUTO_REBASE: '0',
  };
  const jobsDir = jobs.rebuildJobsDir(root, env);
  vi.spyOn(origin, 'readOriginRefSha').mockReturnValue(main);
  const materialize = vi.fn(snapshots.gitArchiveMaterializer(root, main));
  vi.spyOn(snapshots, 'ensureCodeSnapshot').mockImplementation(options =>
    ensureCode({ ...options, materialize }));
  const code = () => snapshots.ensureCodeSnapshot({ jobsDir, codeSha: main, repoDir: root });
  expect(writeReadyCandidate(root, {
    prevHead: main, adopt: { finalSha: main }, smoke: { verdict: 'pass' },
  }, env)).toBe(true);
  vi.spyOn(jobs, 'rebuildCloneAsJob').mockImplementation(({ adopt }) => adopt());
  const child = vi.fn(async () => ({ status: 0, stdout: JSON.stringify(IDLE) }));
  const loadedRun = vi.fn(() => { throw new Error('Unexpected loaded planner Git'); });
  const tick = () => rebuildClone({ root, env, asJob: true, adoptChild: { run: child },
    run: loadedRun, log: quiet, emitEvent: vi.fn() });
  return { root, git, main, expectedBlobs, env, jobsDir, materialize, code, child, tick, loadedRun };
}

// Attacker-controlled evidence: reproduce the old receipt format, not the verifier.
// A matching writable receipt must never substitute for the committed Git blobs.
function forgeCodeReceipt(dir, codeSha) {
  const entries = [];
  function visit(at) {
    for (const name of readdirSync(at)) {
      if (at === dir && ['.snapshot-complete', INTEGRITY, 'node_modules'].includes(name)) continue;
      const path = join(at, name);
      const info = lstatSync(path);
      const key = relative(dir, path).split(sep).join('/');
      if (info.isDirectory()) { entries.push({ path: key, type: 'directory' }); visit(path); }
      else {
        const bytes = readFileSync(path);
        entries.push({ path: key, type: 'file', mode: info.mode, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  visit(dir);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  put(dir, INTEGRITY, JSON.stringify({ codeSha, treeDigest: sha256(JSON.stringify(entries)) }));
}

describe('Git-backed code provenance before adoption', () => {
  it('reuses an unchanged Git archive without rebuilding', async () => {
    const f = fixture();
    const dir = f.code();
    expect(f.git('hash-object', join(dir, CLI))).toBe(f.expectedBlobs.get(CLI));
    await expect(f.tick()).resolves.toMatchObject(IDLE);
    expect(f.materialize).toHaveBeenCalledTimes(1);
    expect(f.child).toHaveBeenCalledTimes(1);
  });

  it.each(['changed blob', 'extra file', 'missing file'])(
    'discards %s with a forged matching receipt and rebuilds once from Git', async attack => {
      const f = fixture();
      const dir = f.code();
      if (attack === 'changed blob') {
        put(dir, CLI, '// attacker CLI\n');
        expect(f.git('hash-object', join(dir, CLI))).not.toBe(f.expectedBlobs.get(CLI));
      } else if (attack === 'extra file') put(dir, 'extra.mjs', '// attacker preload\n');
      else rmSync(join(dir, 'tracked.txt'));
      forgeCodeReceipt(dir, f.main);
      f.child.mockImplementation(async (_exe, _argv, options) => {
        expect.soft(readFileSync(join(options.cwd, CLI), 'utf8')).toBe(CODE);
        expect.soft(existsSync(join(options.cwd, 'extra.mjs'))).toBe(false);
        expect.soft(existsSync(join(options.cwd, 'tracked.txt'))).toBe(true);
        return { status: 0, stdout: JSON.stringify(IDLE) };
      });
      await expect(f.tick()).resolves.toMatchObject(IDLE);
      expect.soft(f.materialize).toHaveBeenCalledTimes(2);
      expect(f.child).toHaveBeenCalledTimes(1);
      expect(f.loadedRun).not.toHaveBeenCalled();
    },
  );

  it('fails closed as adopt-child-failed when the single rebuild still disagrees with Git', async () => {
    const f = fixture();
    const dir = f.code();
    put(dir, CLI, '// forged cached CLI\n');
    forgeCodeReceipt(dir, f.main);
    const archive = snapshots.gitArchiveMaterializer(f.root, f.main);
    f.materialize.mockImplementation(into => {
      archive(into);
      put(into, CLI, '// still wrong after repair\n');
    });
    await expect(f.tick()).resolves.toMatchObject({ moved: false, reason: 'adopt-child-failed' });
    expect.soft(f.materialize).toHaveBeenCalledTimes(2);
    expect.soft(f.child).not.toHaveBeenCalled();
    expect.soft(existsSync(dir)).toBe(false);
    expect(f.loadedRun).not.toHaveBeenCalled();
  });
});

async function dependencyConsumer(role) {
  const f = fixture();
  if (role === 'adopter') return { ...f, consume: async () => {
    await expect(f.tick()).resolves.toMatchObject(IDLE);
    expect(f.child).toHaveBeenCalled();
    return f.child.mock.calls.at(-1)[2].cwd;
  } };
  const store = createJobStore(f.jobsDir);
  let snapshot;
  await asJob({ root: f.root, env: f.env, store, codeSha: f.main,
    reattach: async options => { snapshot = options.snapshot; return { actions: [] }; },
    adopt: async () => IDLE, log: quiet, evict: () => ({ evicted: [] }),
  });
  const [record] = store.list().records;
  expect(record.job.codeSha).toBe(f.main);
  return { ...f, consume: async () => prepareJobCode({ store, record,
    kindDef: jobs.REBUILD_JOB_KIND, snapshot }).cwd };
}

function seedLegacyStore(f) {
  const dir = join(snapshots.snapshotsRoot(f.jobsDir), 'node-modules', snapshots.lockfileKey(LOCK));
  put(dir, 'package.json', MANIFEST);
  put(dir, 'package-lock.json', LOCK);
  put(dir, 'node_modules/pkg/index.js', LEGACY);
  put(dir, '.snapshot-complete', 'legacy complete\n');
  put(dir, INTEGRITY, JSON.stringify({ lockHash: sha256(LOCK), treeDigest: sha256(JSON.stringify([
    { path: 'pkg/index.js', size: Buffer.byteLength(LEGACY), sha256: sha256(LEGACY) },
  ])) }));
  return dir;
}
const npmCalls = () => io.exec.mock.calls.filter(([command]) => command === 'npm');
const storeAt = cwd => dirname(realpathSync(join(cwd, 'node_modules')));

describe.each(['job', 'adopter'])('%s npm-ci dependency provenance', role => {
  it('isolates a matching legacy checkout-copy store and records npm-ci provenance', async () => {
    const f = await dependencyConsumer(role);
    const legacy = seedLegacyStore(f);
    const cwd = await f.consume();
    const dir = storeAt(cwd);
    expect.soft(dir).not.toBe(realpathSync(legacy));
    expect.soft(readFileSync(join(cwd, 'node_modules/pkg/index.js'), 'utf8')).toBe(VERIFIED);
    expect.soft(npmCalls()).toHaveLength(1);
    expect.soft(receipt(dir)).toMatchObject({ installer: 'npm-ci', lockHash: sha256(LOCK) });
    await f.consume();
    expect(npmCalls()).toHaveLength(1);
  });

  it.each(['missing', 'checkout-copy'])('rejects %s installer evidence even with a matching tree digest', async evidence => {
    const f = await dependencyConsumer(role);
    const cwd = await f.consume();
    const dir = storeAt(cwd);
    const record = receipt(dir);
    if (evidence === 'missing') delete record.installer;
    else record.installer = evidence;
    put(dir, INTEGRITY, JSON.stringify(record));
    await f.consume();
    expect.soft(npmCalls()).toHaveLength(2);
    expect(receipt(storeAt(cwd))).toMatchObject({ installer: 'npm-ci' });
  });
});
