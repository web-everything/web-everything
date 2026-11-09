/**
 * Red contract tests for adopter-only dependency integrity. The proposed on-disk record is
 * .snapshot-integrity.json: { lockHash: sha256(lockfile), treeDigest: sha256(JSON.stringify(entries)) }.
 * Entries are sorted relative POSIX file paths with byte size and SHA256, including every
 * package.json (scoped/nested packages too). The oracle below is independent of production code.
 * Only IO boundaries are faked; store construction, reuse and adoption refusal remain real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

// Clear setup-file imports before installing IO mocks: cached consumers otherwise
// retain their original builtin imports and can run a real npm subprocess.
const io = vi.hoisted(() => {
  vi.resetModules();
  return { exec: vi.fn(), unstable: false, reads: 0 };
});
vi.mock('node:child_process', async (original) => ({
  ...await original(), execFileSync: (...args) => io.exec(...args),
}));
vi.mock('node:fs', async (original) => {
  const fs = await original();
  return {
    ...fs,
    readFileSync: (path, ...args) => {
      const bytes = fs.readFileSync(path, ...args);
      if (io.unstable && String(path).replaceAll('\\', '/').endsWith('/node_modules/pkg/package.json')) {
        const text = `{"name":"pkg","version":"${String(++io.reads).padStart(8, '0')}"}`;
        return typeof bytes === 'string' ? text : Buffer.from(text);
      }
      return bytes;
    },
  };
});

import { rebuildClone } from '../daemon-rebuild.mjs';
import * as snapshots from '../daemon-job-snapshots.mjs';
import * as jobs from '../daemon-rebuild/rebuild-job.mjs';
import * as origin from '../daemon-self-sync.mjs';
import * as forceWatch from '../daemon-force-adopt.mjs';
import * as overlays from '../overlay-adoption.mjs';
import { readReadyCandidate, readyCandidatePath, writeReadyCandidate } from '../daemon-rebuild/state.mjs';

const realEnsureNodeModulesStore = snapshots.ensureNodeModulesStore;
const INTEGRITY = '.snapshot-integrity.json';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const MAIN = 'a'.repeat(40);
const BEFORE = 'b'.repeat(40);
const TARGET = 'c'.repeat(40);
const LOCK = '{"name":"fixture","lockfileVersion":3,"packages":{}}\n';
const ACCEPT = { moved: true, adopted: true, reason: 'ready-adopted', head: TARGET };
const put = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

function entries(root, at = root) {
  return readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
    const path = join(at, entry.name);
    if (entry.isDirectory()) return entries(root, path);
    const bytes = readFileSync(path);
    return [{ path: relative(root, path).split(sep).join('/'), size: bytes.length, sha256: sha(bytes) }];
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function installedTree(into, version = '1') {
  // Deliberately unsorted creation order; include scoped and nested manifests.
  put(into, 'node_modules/z/package.json', '{"name":"z"}');
  put(into, 'node_modules/pkg/index.js', `export default ${version};\n`);
  put(into, 'node_modules/pkg/package.json', `{"name":"pkg","version":"${version}"}`);
  put(into, 'node_modules/pkg/node_modules/nested/package.json', '{"name":"nested"}');
  put(into, 'node_modules/@scope/a/package.json', '{"name":"@scope/a"}');
}

let base;
beforeEach(() => {
  base = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'adopt-integrity-'));
  io.unstable = false;
  io.reads = 0;
  io.exec.mockReset();
  vi.spyOn(forceWatch, 'runForceWatchTick').mockResolvedValue({});
  vi.spyOn(overlays, 'checkPendingAdoptions').mockResolvedValue([]);
});
afterEach(() => {
  io.unstable = false;
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

function fixture() {
  const root = join(base, 'checkout');
  const snapshot = join(base, 'main-snapshot');
  const env = {
    WE_DAEMON_STATE_DIR: join(base, 'state'),
    WE_DAEMON_JOBS_ROOT: join(base, 'jobs'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(base, 'locks'),
  };
  for (const dir of [root, snapshot]) {
    put(dir, 'package.json', '{"name":"fixture"}');
    put(dir, 'package-lock.json', LOCK);
  }
  put(root, '.git/HEAD', BEFORE);
  installedTree(root, '9'); // matching lockfile, untrusted moving-checkout dependencies
  const ready = { prevHead: BEFORE, adopt: { finalSha: TARGET }, smoke: { verdict: 'pass' } };
  expect(writeReadyCandidate(root, ready, env)).toBe(true);
  const readyBytes = readFileSync(readyCandidatePath(root, env), 'utf8');
  vi.spyOn(origin, 'readOriginRefSha').mockReturnValue(MAIN);
  vi.spyOn(snapshots, 'ensureCodeSnapshot').mockReturnValue(snapshot);
  vi.spyOn(jobs, 'rebuildCloneAsJob').mockImplementation(({ adopt }) => adopt());
  const cloneInstaller = vi.spyOn(jobs, 'cloneNodeModulesInstaller');
  const install = vi.fn((into) => {
    expect(readFileSync(join(into, 'package-lock.json'), 'utf8')).toBe(LOCK);
    expect(readFileSync(join(into, 'package.json'), 'utf8')).toBe('{"name":"fixture"}');
    installedTree(into);
  });
  // Inject at the store's existing installer seam, leaving its real materialization,
  // marker handling and integrity/reuse policy intact. Explicit caller installers
  // are preserved so a checkout-copy regression cannot be hidden by the fake.
  vi.spyOn(snapshots, 'ensureNodeModulesStore').mockImplementation((options) => (
    realEnsureNodeModulesStore({ ...options, install: options.install ?? install })
  ));
  io.exec.mockImplementation((command, argv, options) => {
    if (command !== 'npm' || argv[0] !== 'ci') throw new Error(`Unexpected process: ${command}`);
    expect(readFileSync(join(options.cwd, 'package-lock.json'), 'utf8')).toBe(LOCK);
    expect(readFileSync(join(options.cwd, 'package.json'), 'utf8')).toBe('{"name":"fixture"}');
    install(options.cwd);
    return '';
  });
  const child = vi.fn(async () => ({ status: 0, stdout: JSON.stringify(ACCEPT) }));
  const adopt = () => rebuildClone({
    root, env, asJob: true, adoptChild: { run: child }, emitEvent: vi.fn(),
    run: () => { throw new Error('Unexpected git IO'); },
    log: { error() {}, warn() {}, log() {} },
  });
  const store = () => dirname(realpathSync(join(snapshot, 'node_modules')));
  const unchanged = () => {
    expect(readFileSync(join(root, '.git/HEAD'), 'utf8')).toBe(BEFORE);
    expect(readReadyCandidate(root, env)).toEqual(ready);
    expect(readFileSync(readyCandidatePath(root, env), 'utf8')).toBe(readyBytes);
  };
  return { root, snapshot, env, install, child, adopt, store, unchanged, cloneInstaller };
}

describe('adopter dependency provenance and integrity', () => {
  it('A/D: bypasses a complete checkout-copied shared job store without modifying it', async () => {
    const f = fixture();
    const jobsDir = jobs.rebuildJobsDir(f.root, f.env);
    const copy = vi.fn((_cmd, argv) => cpSync(argv.at(-2), argv.at(-1), { recursive: true }));
    const shared = snapshots.ensureNodeModulesStore({
      jobsDir, sourceDir: f.root,
      install: jobs.cloneNodeModulesInstaller(f.root, { exec: copy, fallback: () => { throw new Error('unexpected fallback'); } }),
    });
    expect(copy).toHaveBeenCalledTimes(1);
    const before = entries(shared.dir);
    f.cloneInstaller.mockClear();
    await expect(f.adopt()).resolves.toMatchObject(ACCEPT);
    expect.soft(f.install).toHaveBeenCalledTimes(1);
    expect.soft(f.store()).not.toBe(shared.dir);
    expect.soft(relative(join(jobsDir, '.snapshots'), f.store()).split(sep)[0]).not.toBe('node-modules');
    expect.soft(readFileSync(join(f.snapshot, 'node_modules/pkg/index.js'), 'utf8')).toBe('export default 1;\n');
    expect(f.cloneInstaller).not.toHaveBeenCalled();
    expect(entries(shared.dir)).toEqual(before);
  });

  it('B: records the snapshot lock hash and a sorted content digest, then reuses a matching store', async () => {
    const f = fixture();
    await expect(f.adopt()).resolves.toMatchObject(ACCEPT);
    const recordPath = join(f.store(), INTEGRITY);
    expect(existsSync(recordPath), 'built store must carry an integrity record').toBe(true);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    expect(record).toMatchObject({
      lockHash: sha(LOCK), treeDigest: sha(JSON.stringify(entries(join(f.store(), 'node_modules')))),
    });
    const before = readFileSync(recordPath, 'utf8');
    await expect(f.adopt()).resolves.toMatchObject(ACCEPT);
    expect(f.install).toHaveBeenCalledTimes(1);
    expect(f.child).toHaveBeenCalledTimes(2);
    expect(readFileSync(recordPath, 'utf8')).toBe(before);
  });

  it('B: an unchanged installed tree is reused without another install', async () => {
    const f = fixture();
    await expect(f.adopt()).resolves.toMatchObject(ACCEPT);
    const dir = f.store();
    const before = entries(dir);
    await expect(f.adopt()).resolves.toMatchObject(ACCEPT);
    expect(f.store()).toBe(dir);
    expect(entries(dir)).toEqual(before);
    expect(f.install).toHaveBeenCalledTimes(1);
    expect(f.child).toHaveBeenCalledTimes(2);
  });

  const corruptions = [
    ['same-size package.json modification', (dir) => put(dir, 'node_modules/pkg/package.json', '{"name":"pkg","version":"9"}')],
    ['same-size non-manifest modification', (dir) => put(dir, 'node_modules/pkg/index.js', 'export default 9;\n')],
    ['added file', (dir) => put(dir, 'node_modules/pkg/extra.js', 'injected')],
    ['removed file', (dir) => rmSync(join(dir, 'node_modules/pkg/index.js'))],
    ['missing completion marker', (dir) => rmSync(join(dir, '.snapshot-complete'), { force: true })],
    ['missing integrity marker', (dir) => rmSync(join(dir, INTEGRITY), { force: true })],
    ['wrong lock hash', (dir) => {
      const path = join(dir, INTEGRITY);
      const record = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
      put(dir, INTEGRITY, JSON.stringify({ ...record, lockHash: '0'.repeat(64) }));
    }],
  ];
  it.each(corruptions)('C/D: %s causes exactly one clean rebuild before child execution', async (_name, corrupt) => {
    const f = fixture();
    // Also hold a different-lock shared job store: repair must never evict or edit it.
    const unrelated = join(base, 'other-source');
    put(unrelated, 'package.json', '{}');
    put(unrelated, 'package-lock.json', '{"different":true}');
    const shared = snapshots.ensureNodeModulesStore({
      jobsDir: jobs.rebuildJobsDir(f.root, f.env), sourceDir: unrelated, install: installedTree,
    });
    const sharedBefore = entries(shared.dir);
    await expect(f.adopt()).resolves.toMatchObject(ACCEPT);
    const pristine = entries(join(f.store(), 'node_modules'));
    corrupt(f.store());
    f.child.mockClear();
    let atChild;
    f.child.mockImplementation(async () => {
      // Check at the decision boundary: repairs after running the child are too late.
      atChild = { installs: f.install.mock.calls.length, tree: entries(join(f.store(), 'node_modules')) };
      return { status: 0, stdout: JSON.stringify(ACCEPT) };
    });
    await expect(f.adopt()).resolves.toMatchObject(ACCEPT);
    expect.soft(f.install).toHaveBeenCalledTimes(2);
    expect.soft(f.child).toHaveBeenCalledTimes(1);
    expect.soft(atChild).toEqual({ installs: 2, tree: pristine });
    expect(entries(shared.dir)).toEqual(sharedBefore);
    expect(f.cloneInstaller).not.toHaveBeenCalled();
  });

  it('C: a rebuilt tree still changing during verification refuses adoption after one repair', async () => {
    const f = fixture();
    await f.adopt();
    put(f.store(), 'node_modules/pkg/index.js', 'tampered');
    f.child.mockClear();
    io.unstable = true;
    expect.soft(await f.adopt()).toMatchObject({ moved: false, reason: 'adopt-child-failed' });
    expect.soft(f.install).toHaveBeenCalledTimes(2);
    expect.soft(f.child).not.toHaveBeenCalled();
    f.unchanged();
  });

  it.each(['fresh install', 'repair'])('C: throwing %s refuses adoption and preserves ready evidence', async (phase) => {
    const f = fixture();
    if (phase === 'repair') {
      await f.adopt();
      put(f.store(), 'node_modules/pkg/index.js', 'tampered');
      f.child.mockClear();
    }
    f.install.mockImplementation(() => { throw new Error('injected npm ci failure'); });
    expect.soft(await f.adopt()).toMatchObject({ moved: false, reason: 'adopt-child-failed' });
    expect.soft(f.install).toHaveBeenCalledTimes(phase === 'repair' ? 2 : 1);
    expect.soft(f.child).not.toHaveBeenCalled();
    f.unchanged();
  });
});
