import { beforeEach, afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, utimesSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { salvageDirtyLane, salvageDirtyLanes } from '../lib/lane-dirty-salvage.mjs';
import { laneLivenessGate } from '../lib/lane-salvage.mjs';
import { realSalvageIo } from '../lib/lane-pool-salvage-push.mjs';

let root, dir, origin, repo, mapFile, options;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 8 * 1024 * 1024 }).trim();
const leaseFile = () => join(dir, '.git', '.lane-lease');
const state = () => ({ head: readFileSync(join(dir, '.git', 'HEAD')), index: readFileSync(join(dir, '.git', 'index')), text: readFileSync(join(dir, 'edited.txt'), 'utf8') });
const refs = () => git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/salvage/');
const deleteParent = () => {
  const commit = message => git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', message);
  commit('missing ancestor');
  const missing = git(dir, 'rev-parse', 'HEAD');
  commit('readable tip');
  rmSync(join(dir, '.git', 'objects', missing.slice(0, 2), missing.slice(2)));
  expect(() => git(dir, 'cat-file', '-e', 'HEAD^{tree}')).not.toThrow();
  expect(() => git(dir, 'rev-list', '--objects', '--missing=error', 'HEAD')).toThrow();
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dirty-salvage-test-'));
  origin = join(root, 'origin.git');
  const primary = join(root, 'primary');
  git(root, 'init', '--bare', origin);
  mkdirSync(primary);
  git(primary, 'init', '-b', 'main');
  git(primary, 'config', 'user.name', 'Fixture');
  git(primary, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(primary, 'edited.txt'), 'before\n');
  writeFileSync(join(primary, 'unchanged.txt'), 'stable\n');
  writeFileSync(join(primary, '.gitignore'), 'ignored.txt\n');
  git(primary, 'add', '.');
  git(primary, 'commit', '-m', 'base');
  git(primary, 'remote', 'add', 'origin', origin);
  git(primary, 'push', 'origin', 'main');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  repo = { branch: 'main', originUrl: origin, referencePath: primary, poolDir: join(root, 'pool', 'fixture') };
  mkdirSync(repo.poolDir, { recursive: true });
  dir = join(repo.poolDir, 'lane-1');
  git(root, 'clone', origin, dir);
  writeFileSync(join(dir, 'edited.txt'), 'after\n');
  writeFileSync(join(dir, 'new file.txt'), 'new\n');
  writeFileSync(join(dir, 'ignored.txt'), 'ignored\n');
  mapFile = join(root, 'records', 'map.jsonl');
  options = { repo, n: 1, dir, mapFile, now: () => new Date('2026-11-15T12:00:00Z'),
    io: realSalvageIo({ repo }),
    livenessGate: args => laneLivenessGate({ ...args, quietMs: 0, readAgents: () => [], readCwds: () => [] }),
    journal: () => {},
    reclaim: ({ assertLease }) => {
      assertLease(); git(dir, 'checkout', '-B', 'main', 'origin/main', '--force');
      assertLease(); git(dir, 'clean', '-fd');
    },
    reprovision: ({ assertLease, assertUnchanged }) => {
      assertLease();
      assertUnchanged();
      const lease = readFileSync(leaseFile());
      renameSync(dir, join(root, 'retained-lane'));
      git(root, 'clone', origin, dir);
      writeFileSync(leaseFile(), lease);
    },
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('pushes and verifies a WIP with exactly dirty changes, then reclaims clean', async () => {
  const result = await salvageDirtyLane(options);
  expect(result.status).toBe('salvaged');
  expect(git(origin, 'rev-parse', `refs/heads/${result.ref}`)).toBe(result.sha);
  expect(git(origin, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.sha).split('\n')).toEqual(['edited.txt', 'new file.txt']);
  expect(git(origin, 'show', `${result.sha}:edited.txt`)).toBe('after');
  expect(git(origin, 'show', `${result.sha}:new file.txt`)).toBe('new');
  expect(git(dir, 'status', '--porcelain')).toBe('');
  expect(JSON.parse(readFileSync(mapFile, 'utf8'))).toEqual({ lane: 1, ref: result.ref, sha: result.sha });
  expect(existsSync(leaseFile())).toBe(false);
});

it('keeps worktree, HEAD and index untouched on failed push', async () => {
  const before = state();
  const result = await salvageDirtyLane({ ...options, io: { ...options.io, push: async () => ({ ok: false }) } });
  expect(result.status).toBe('kept'); expect(state()).toEqual(before);
  expect(existsSync(join(dir, 'new file.txt'))).toBe(true);
  expect(refs()).toBe(''); expect(existsSync(mapFile)).toBe(false);
});

it('keeps a live leased lane untouched without attempting transport', async () => {
  writeFileSync(leaseFile(), JSON.stringify({ session: 'owner', acquiredAt: new Date().toISOString() }));
  const before = state();
  const result = await salvageDirtyLane(options);
  expect(result.status).toBe('kept'); expect(result.reason).toMatch(/lease/);
  expect(state()).toEqual(before); expect(refs()).toBe('');
});

it('keeps unreadable HEAD when status fails, retaining quarantine and every original byte without transport', async () => {
  const quarantine = join(repo.poolDir, '.quarantine-state', 'lane-1.json');
  mkdirSync(join(repo.poolDir, '.quarantine-state'));
  writeFileSync(quarantine, JSON.stringify({ reason: 'missing objects' }));
  writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), '1234567890123456789012345678901234567890\n');
  const before = state();
  expect(() => git(dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all')).toThrow();
  let pushes = 0;
  const result = await salvageDirtyLane({ ...options, quarantined: true, quarantinePath: quarantine,
    io: { ...options.io, push: () => { pushes++; return { ok: true }; } } });
  expect(result).toEqual({ status: 'kept', reason: 'unreadable or failed git/filesystem evidence; inspect lane manually' });
  expect(pushes).toBe(0); expect(refs()).toBe(''); expect(state()).toEqual(before);
  expect(existsSync(mapFile)).toBe(false); expect(existsSync(leaseFile())).toBe(false);
  expect(existsSync(quarantine)).toBe(true);
  expect(readFileSync(join(dir, 'new file.txt'), 'utf8')).toBe('new\n');
});

it('refuses credential content, reporting paths only, and pushes nothing', async () => {
  const secret = 'ghp_' + 'A'.repeat(24);
  writeFileSync(join(dir, 'new file.txt'), secret);
  const before = state();
  const result = await salvageDirtyLane(options);
  expect(result.status).toBe('kept'); expect(result.reason).toBe('credential-scan hit: new file.txt');
  expect(JSON.stringify(result)).not.toContain(secret); expect(state()).toEqual(before); expect(refs()).toBe('');
});

it('dry run preserves all lane files and creates neither mapping nor salvage ref', async () => {
  const before = state();
  const result = await salvageDirtyLane({ ...options, dryRun: true });
  expect(result.status).toBe('kept'); expect(result.reason).toMatch(/would salvage/);
  expect(state()).toEqual(before); expect(refs()).toBe(''); expect(existsSync(mapFile)).toBe(false);
  expect(existsSync(leaseFile())).toBe(false);
});

it('gc --dry-run mutates neither lane git files nor pool state', () => {
  const snapshot = path => readdirSync(path, { withFileTypes: true }).flatMap(e => {
    const file = join(path, e.name);
    return e.isDirectory() ? snapshot(file) : [[file, readFileSync(file).toString('base64')]];
  });
  const before = snapshot(repo.poolDir);
  const run = spawnSync(process.execPath, [resolve('scripts/lane-pool.mjs'), 'gc', '--dry-run',
    `--repo=${repo.referencePath}`, `--origin=${origin}`, '--name=fixture', '--branch=main'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, LANE_POOL_ROOT: join(root, 'pool') },
  });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stderr).toMatch(/would run git gc/);
  expect(snapshot(repo.poolDir)).toEqual(before); expect(refs()).toBe('');
});

it('refuses unknown liveness and remote verification mismatch before reclaim', async () => {
  const before = state();
  const gated = await salvageDirtyLane({ ...options, livenessGate: () => ({ eligible: false, reason: 'unknown evidence' }) });
  expect(gated).toEqual({ status: 'kept', reason: 'unknown evidence' });
  const mismatch = await salvageDirtyLane({ ...options, io: { remoteSha: () => null, push: async () => ({ ok: true }) } });
  expect(mismatch.status).toBe('kept'); expect(mismatch.reason).toMatch(/verification/);
  expect(state()).toEqual(before);
});

it('keeps oversized snapshots and names the manual-salvage fallback', async () => {
  const before = state();
  for (const limits of [{ maxFiles: 1 }, { maxBytes: 1 }]) {
    const result = await salvageDirtyLane({ ...options, ...limits });
    expect(result.status).toBe('kept'); expect(result.reason).toMatch(/bound; salvage manually/);
  }
  expect(state()).toEqual(before); expect(refs()).toBe('');
});

it('keeps changed files after push rather than resetting new work', async () => {
  const push = options.io.push;
  const result = await salvageDirtyLane({ ...options, io: { ...options.io, push: async (...args) => {
    const pushed = await push(...args);
    writeFileSync(join(dir, 'edited.txt'), 'new concurrent work');
    return pushed;
  } } });
  expect(result.status).toBe('kept'); expect(result.reason).toMatch(/changed during salvage/);
  expect(readFileSync(join(dir, 'edited.txt'), 'utf8')).toBe('new concurrent work');
  expect(existsSync(join(dir, 'new file.txt'))).toBe(true);
});

it('retains quarantine and all dirty bytes when its push fails', async () => {
  const quarantine = join(repo.poolDir, '.quarantine-state', 'lane-1.json');
  mkdirSync(join(repo.poolDir, '.quarantine-state'));
  writeFileSync(quarantine, JSON.stringify({ reason: 'missing stash object' }));
  const before = state();
  const result = await salvageDirtyLane({ ...options, quarantined: true, quarantinePath: quarantine,
    io: { ...options.io, push: () => ({ ok: false }) } });
  expect(result.status).toBe('kept'); expect(state()).toEqual(before);
  expect(existsSync(quarantine)).toBe(true);
});

it('uses independent quiet evidence with missing ancestry, then reprovisions and clears quarantine', async () => {
  deleteParent();
  const age = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) age(child);
      utimesSync(child, new Date(0), new Date(0));
    }
  };
  age(dir);
  const quarantine = join(repo.poolDir, '.quarantine-state', 'lane-1.json');
  mkdirSync(join(repo.poolDir, '.quarantine-state'));
  writeFileSync(quarantine, JSON.stringify({ reason: 'missing ancestry' }));
  const result = await salvageDirtyLane({ ...options, quarantined: true, quarantinePath: quarantine,
    livenessGate: args => args.quietMs === 0
      ? { eligible: true }
      : { eligible: false, reason: 'lane content changed 0 min ago (< 30 min quiet period)' },
  });
  expect(result.status, result.reason).toBe('salvaged');
  expect(git(origin, 'show', '-s', '--format=%P', result.sha)).toBe('');
  expect(git(origin, 'ls-tree', '-r', '--name-only', result.sha).split('\n')).toEqual(['edited.txt', 'new file.txt']);
  expect(git(origin, 'show', `${result.sha}:edited.txt`)).toBe('after');
  expect(git(origin, 'rev-parse', `refs/heads/${result.ref}`)).toBe(result.sha);
  expect(git(dir, 'status', '--porcelain')).toBe('');
  expect(existsSync(quarantine)).toBe(false);
});

it('keeps quarantine if replacement is not clean after verified push', async () => {
  const quarantine = join(repo.poolDir, '.quarantine-state', 'lane-1.json');
  mkdirSync(join(repo.poolDir, '.quarantine-state'));
  writeFileSync(quarantine, JSON.stringify({ reason: 'missing stash' }));
  const result = await salvageDirtyLane({ ...options, quarantined: true, quarantinePath: quarantine, reprovision: () => {} });
  expect(result.status).toBe('kept'); expect(result.reason).toMatch(/not clean/);
  expect(existsSync(quarantine)).toBe(true);
  expect(readFileSync(join(dir, 'edited.txt'), 'utf8')).toBe('after\n');
});

it('preserves distinct HEAD, staged and worktree versions on verified remote refs after reclaim', async () => {
  writeFileSync(join(dir, 'edited.txt'), 'staged A\n');
  git(dir, 'add', '--', 'edited.txt');
  writeFileSync(join(dir, 'edited.txt'), 'worktree B\n');
  const result = await salvageDirtyLane(options);
  expect(result.status, result.reason).toBe('salvaged');
  expect(git(origin, 'rev-parse', `refs/heads/${result.indexRef}`)).toBe(result.indexSha);
  expect(git(origin, 'rev-parse', `refs/heads/${result.ref}`)).toBe(result.sha);
  expect(git(origin, 'show', `${result.indexRef}:edited.txt`)).toBe('staged A');
  expect(git(origin, 'show', `${result.ref}:edited.txt`)).toBe('worktree B');
  expect(git(origin, 'show', `${result.indexSha}^:edited.txt`)).toBe('before');
  expect(git(dir, 'status', '--porcelain')).toBe('');
  const records = readFileSync(mapFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(records).toContainEqual({ lane: 1, ref: result.indexRef, sha: result.indexSha });
  expect(records).toContainEqual({ lane: 1, ref: result.ref, sha: result.sha });
});

it('preserves staged content even when the worktree has been reverted to HEAD', async () => {
  writeFileSync(join(dir, 'edited.txt'), 'staged only\n');
  git(dir, 'add', '--', 'edited.txt');
  writeFileSync(join(dir, 'edited.txt'), 'before\n');
  const result = await salvageDirtyLane(options);
  expect(result.status, result.reason).toBe('salvaged');
  expect(git(origin, 'show', `${result.indexRef}:edited.txt`)).toBe('staged only');
  expect(git(origin, 'show', `${result.ref}:edited.txt`)).toBe('before');
  expect(git(dir, 'status', '--porcelain')).toBe('');
});

it('scans staged credentials hidden by subsequent worktree edits before any push', async () => {
  writeFileSync(join(dir, 'edited.txt'), 'ghp_' + 'A'.repeat(24));
  git(dir, 'add', '--', 'edited.txt');
  writeFileSync(join(dir, 'edited.txt'), 'safe worktree\n');
  const before = state();
  const result = await salvageDirtyLane(options);
  expect(result).toEqual({ status: 'kept', reason: 'credential-scan hit: edited.txt' });
  expect(state()).toEqual(before); expect(refs()).toBe('');
});

it('keeps both original staged and worktree versions if index ref verification fails', async () => {
  writeFileSync(join(dir, 'edited.txt'), 'staged A\n');
  git(dir, 'add', '--', 'edited.txt');
  writeFileSync(join(dir, 'edited.txt'), 'worktree B\n');
  const before = state();
  const result = await salvageDirtyLane({ ...options, io: { ...options.io,
    remoteSha: ref => ref.endsWith('-index') ? null : options.io.remoteSha(ref),
  } });
  expect(result.status).toBe('kept'); expect(result.reason).toMatch(/verification/);
  expect(state()).toEqual(before); expect(git(dir, 'show', ':edited.txt')).toBe('staged A');
  expect(existsSync(mapFile)).toBe(false);
});

it('refuses unpushed committed credentials before creating either remote salvage ref', async () => {
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(dir, 'committed-secret.txt'), 'ghp_' + 'A'.repeat(24));
  git(dir, 'add', '--', 'committed-secret.txt');
  git(dir, 'commit', '-m', 'local credential');
  // Delete it in another unpushed commit: checking only HEAD would miss this blob too.
  git(dir, 'rm', '--', 'committed-secret.txt');
  git(dir, 'commit', '-m', 'remove local credential');
  writeFileSync(join(dir, 'edited.txt'), 'staged unrelated A\n');
  git(dir, 'add', '--', 'edited.txt');
  writeFileSync(join(dir, 'edited.txt'), 'unstaged unrelated B\n');
  const before = state();
  let pushes = 0;
  const result = await salvageDirtyLane({ ...options, io: { ...options.io, push: (...args) => {
    pushes++; return options.io.push(...args);
  } } });
  expect(result).toEqual({ status: 'kept', reason: 'credential-scan hit: committed-secret.txt' });
  expect(pushes).toBe(0); expect(refs()).toBe(''); expect(state()).toEqual(before);
  expect(existsSync(mapFile)).toBe(false);
});

it('refuses unpushed commit-message credentials before any remote publication', async () => {
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'commit', '--allow-empty', '-m', 'ghp_' + 'A'.repeat(24));
  const before = state();
  const result = await salvageDirtyLane(options);
  expect(result).toEqual({ status: 'kept', reason: 'credential-scan hit: (history commit)' });
  expect(refs()).toBe(''); expect(state()).toEqual(before);
});

it('keeps oversized newly reachable history with an explicit manual-salvage fallback', async () => {
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'commit', '--allow-empty', '-m', 'safe local commit');
  const before = state();
  for (const bounds of [{ maxHistoryObjects: 0 }, { maxHistoryBytes: 1 }]) {
    const result = await salvageDirtyLane({ ...options, ...bounds });
    expect(result.status).toBe('kept'); expect(result.reason).toMatch(/history scan exceeds .* bound; salvage manually/);
  }
  expect(refs()).toBe(''); expect(state()).toEqual(before);
});

it('keeps the lane when the origin history scan boundary is unreadable', async () => {
  const before = state();
  const result = await salvageDirtyLane({ ...options, io: { ...options.io, remoteSha: () => undefined } });
  expect(result).toEqual({ status: 'kept', reason: 'unreadable origin history boundary; salvage manually' });
  expect(refs()).toBe(''); expect(state()).toEqual(before);
});


it('pushes and verifies only dirty files parentlessly with missing ancestry and quarantined=false, retaining committed content when reprovisioning', async () => {
  git(dir, 'checkout', '--', 'edited.txt');
  rmSync(join(dir, 'new file.txt'));
  writeFileSync(join(dir, 'unchanged.txt'), 'x'.repeat(4096));
  git(dir, 'add', '--', 'unchanged.txt');
  deleteParent();
  writeFileSync(join(dir, 'pr-body.md'), 'note\n');
  const originalHead = git(dir, 'rev-parse', 'HEAD');
  const originalIndex = readFileSync(join(dir, '.git', 'index'));
  expect(existsSync(join(repo.poolDir, '.quarantine-state', 'lane-1.json'))).toBe(false);
  expect(() => git(dir, 'rev-list', '--objects', '--missing=error', 'origin/main')).not.toThrow();
  // Even the unchanged tracked content exceeds this bound; only the dirty file fits.
  const result = await salvageDirtyLane({ ...options, quarantined: false, maxBytes: 5,
    reclaim: () => { throw Error('must retain the original clone instead of resetting it'); },
  });
  expect(result.status, result.reason).toBe('salvaged');
  expect(git(origin, 'rev-parse', `refs/heads/${result.ref}`)).toBe(result.sha);
  expect(git(origin, 'show', '-s', '--format=%P', result.sha)).toBe('');
  expect(git(origin, 'ls-tree', '-r', '--name-only', result.sha)).toBe('pr-body.md');
  expect(git(origin, 'show', `${result.sha}:pr-body.md`)).toBe('note');
  expect(result.indexSha).toBeUndefined();
  const backup = join(root, 'retained-lane');
  expect(git(backup, 'rev-parse', 'HEAD')).toBe(originalHead);
  expect(readFileSync(join(backup, '.git', 'index'))).toEqual(originalIndex);
  expect(readFileSync(join(backup, 'unchanged.txt'), 'utf8')).toBe('x'.repeat(4096));
  expect(git(backup, 'show', 'HEAD:unchanged.txt')).toBe('x'.repeat(4096));
  expect(readFileSync(join(backup, 'pr-body.md'), 'utf8')).toBe('note\n');
  expect(git(dir, 'status', '--porcelain')).toBe('');
  expect(existsSync(leaseFile())).toBe(false);
});

it('kept lanes do not consume the push cap but failed push attempts do', async () => {
  const examined = [], logs = [];
  await salvageDirtyLanes({ lanes: [1, 2, 3, 4, 5, 6], max: 2, log: line => logs.push(line), salvage: async n => {
    examined.push(n);
    if (n === 1) return salvageDirtyLane({ ...options, livenessGate: () => ({ eligible: false, reason: 'live process' }) });
    if (n === 2) return salvageDirtyLane({ ...options, maxBytes: 1 });
    if (n === 3) return salvageDirtyLane({ ...options, livenessGate: () => ({ eligible: false, reason: 'quiet period' }) });
    if (n === 4) return salvageDirtyLane({ ...options, io: { ...options.io, push: () => ({ ok: false }) } });
    return salvageDirtyLane(options);
  } });
  expect(examined).toEqual([1, 2, 3, 4, 5]);
  expect(logs.join('\n')).toMatch(/push cap reached/);
  expect(refs()).not.toBe('');
  expect(git(dir, 'status', '--porcelain')).toBe('');
});

it('bounds examination at four times the cap and names the operator fallback', async () => {
  const examined = [], logs = [];
  await salvageDirtyLanes({ lanes: [1, 2, 3, 4, 5], max: 1, log: line => logs.push(line), salvage: async n => {
    examined.push(n);
    return { status: 'kept', reason: 'unknown liveness' };
  } });
  expect(examined).toEqual([1, 2, 3, 4]);
  expect(logs.join('\n')).toMatch(/examination bound reached; remaining lanes kept.*salvage manually/);
});


for (const flag of ['assume-unchanged', 'skip-worktree']) {
  it(`preserves ${flag} worktree edits before reclaim`, async () => {
    git(dir, 'update-index', `--${flag}`, '--', 'unchanged.txt');
    writeFileSync(join(dir, 'unchanged.txt'), 'concealed authored bytes\n');
    // Other dirty files trigger salvage while Git's ordinary diff conceals this edit.
    expect(git(dir, 'diff', '--name-only', 'HEAD')).not.toContain('unchanged.txt');
    const result = await salvageDirtyLane(options);
    expect(result.status, result.reason).toBe('salvaged');
    expect(git(origin, 'show', `${result.sha}:unchanged.txt`)).toBe('concealed authored bytes');
    expect(git(origin, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.sha).split('\n'))
      .toEqual(['edited.txt', 'new file.txt', 'unchanged.txt']);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(existsSync(leaseFile())).toBe(false);
  });

  it(`keeps oversized ${flag} worktree edits without pushing or changing the index`, async () => {
    git(dir, 'update-index', `--${flag}`, '--', 'unchanged.txt');
    writeFileSync(join(dir, 'unchanged.txt'), 'x'.repeat(1024));
    const before = state();
    let pushes = 0;
    const result = await salvageDirtyLane({ ...options, maxBytes: 64, io: { ...options.io,
      push: () => { pushes++; return { ok: true }; },
    } });
    expect(result.status).toBe('kept');
    expect(result.reason).toMatch(/snapshot exceeds byte bound; salvage manually/);
    expect(pushes).toBe(0);
    expect(state()).toEqual(before);
    expect(readFileSync(join(dir, 'unchanged.txt'), 'utf8')).toBe('x'.repeat(1024));
    expect(refs()).toBe('');
  });
}


it('preserves only dirty staged and worktree files with NUL-delimited renames and deletion messages when ancestry is missing', async () => {
  mkdirSync(join(dir, 'removed-dir'));
  writeFileSync(join(dir, 'removed-dir', 'gone.txt'), 'old\n');
  git(dir, 'add', '--', 'removed-dir/gone.txt');
  deleteParent();
  const renamed = 'renamed\nwith tab\t.txt';
  git(dir, 'mv', '--', 'unchanged.txt', renamed);
  git(dir, 'rm', '--', 'removed-dir/gone.txt');
  rmSync(join(dir, 'removed-dir'), { recursive: true, force: true });
  writeFileSync(join(dir, 'edited.txt'), 'staged A\n');
  git(dir, 'add', '--', 'edited.txt');
  writeFileSync(join(dir, 'edited.txt'), 'worktree B\n');
  const result = await salvageDirtyLane(options);
  expect(result.status, result.reason).toBe('salvaged');
  for (const [ref, sha] of [[result.ref, result.sha], [result.indexRef, result.indexSha]]) {
    expect(git(origin, 'rev-parse', `refs/heads/${ref}`)).toBe(sha);
    expect(git(origin, 'show', '-s', '--format=%P', sha)).toBe('');
    const paths = execFileSync('git', ['ls-tree', '-rz', '--name-only', sha], { cwd: origin, encoding: 'utf8' }).split('\0').filter(Boolean);
    expect(paths).toEqual(ref === result.ref ? ['edited.txt', 'new file.txt', renamed] : ['edited.txt', renamed]);
    expect(git(origin, 'show', `${sha}:${renamed}`)).toBe('stable');
    const message = git(origin, 'show', '-s', '--format=%B', sha);
    expect(message).toContain('Deleted paths (JSON):');
    expect(JSON.parse(message.split('Deleted paths (JSON):\n')[1]).sort()).toEqual(['removed-dir/gone.txt', 'unchanged.txt']);
  }
  expect(git(origin, 'show', `${result.indexSha}:edited.txt`)).toBe('staged A');
  expect(git(origin, 'show', `${result.sha}:edited.txt`)).toBe('worktree B');
  expect(git(dir, 'status', '--porcelain')).toBe('');
  expect(existsSync(leaseFile())).toBe(false);
});

it('records unstaged deletions in a parentless message without manufacturing tree entries', async () => {
  deleteParent();
  rmSync(join(dir, 'unchanged.txt'));
  const result = await salvageDirtyLane(options);
  expect(result.status, result.reason).toBe('salvaged');
  expect(git(origin, 'ls-tree', '-r', '--name-only', result.sha).split('\n')).toEqual(['edited.txt', 'new file.txt']);
  expect(git(origin, 'show', '-s', '--format=%B', result.sha)).toContain('["unchanged.txt"]');
  expect(result.indexSha).toBeUndefined();
  expect(git(dir, 'status', '--porcelain')).toBe('');
});

it('keeps oversized status-derived dirty snapshots with manual-salvage fallback and no publication', async () => {
  deleteParent();
  const before = state();
  const result = await salvageDirtyLane({ ...options, maxBytes: 1 });
  expect(result).toEqual({ status: 'kept', reason: 'snapshot exceeds byte bound; salvage manually or raise maxBytes after inspection' });
  expect(state()).toEqual(before); expect(refs()).toBe('');
  expect(existsSync(mapFile)).toBe(false);
});

for (const kind of ['nested repository', 'submodule']) {
  it(`refuses a ${kind} in the status-derived dirty set without publication or reclaim`, async () => {
    deleteParent();
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    git(nested, 'init', '-b', 'main');
    writeFileSync(join(nested, 'file.txt'), 'nested content\n');
    git(nested, 'add', '.');
    git(nested, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'nested');
    if (kind === 'submodule') git(dir, 'add', '--', 'nested');
    const before = state();
    const result = await salvageDirtyLane(options);
    expect(result.status).toBe('kept');
    expect(result.reason).toMatch(/nested repository/);
    expect(state()).toEqual(before); expect(refs()).toBe('');
    expect(readFileSync(join(nested, 'file.txt'), 'utf8')).toBe('nested content\n');
    expect(existsSync(mapFile)).toBe(false);
  });
}


for (const mode of ['scheduled', 'fallback', 'quarantined before fallback']) {
  it(`gc excludes quarantined lanes at ${mode} execution while admitting a healthy lane`, () => {
    const healthy = join(repo.poolDir, 'lane-2');
    git(root, 'clone', origin, healthy);
    const quarantineDir = join(repo.poolDir, '.quarantine-state');
    mkdirSync(quarantineDir);
    const quarantine = join(quarantineDir, 'lane-1.json');
    const quarantineBytes = JSON.stringify({ reason: 'unreadable history with recoverable work' });
    writeFileSync(quarantine, quarantineBytes);
    const before = state();
    const lateLane = join(repo.poolDir, 'lane-3');
    const lateQuarantine = join(quarantineDir, 'lane-3.json');
    if (mode === 'quarantined before fallback') git(root, 'clone', origin, lateLane);
    const callsFile = join(root, 'gc-calls.jsonl');
    writeFileSync(callsFile, '');
    // Run the real CLI and scheduler with isolated host state and observable GC execution.
    // Git's old-version failure exercises the scheduler's actual fallback through the CLI guard.
    const preload = `import os from 'node:os';
      import cp from 'node:child_process';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const userInfo = os.userInfo;
      os.userInfo = () => ({ ...userInfo(), homedir: ${JSON.stringify(root)} });
      const original = cp.execFileSync;
      cp.execFileSync = (file, args, opts) => {
        if (file === 'git' && args.includes('gc')) {
          fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ cwd: opts.cwd, args }) + '\\n');
          if (args.includes('--no-detach') &&
              (${JSON.stringify(mode)} === 'fallback' || opts.cwd === ${JSON.stringify(lateLane)})) {
            if (${JSON.stringify(mode)} === 'quarantined before fallback') {
              fs.writeFileSync(${JSON.stringify(lateQuarantine)}, JSON.stringify({ reason: 'quarantined during scheduled GC attempt' }));
            }
            throw Object.assign(new Error('old Git option refusal'), {
              status: 129, stderr: "unknown option 'no-detach'"
            });
          }
          return '';
        }
        return original(file, args, opts);
      };
      syncBuiltinESMExports();`;
    const run = spawnSync(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(preload)}`,
      resolve('scripts/lane-pool.mjs'), 'gc', `--repo=${repo.referencePath}`, `--origin=${origin}`,
      '--name=fixture', '--branch=main'], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LANE_POOL_ROOT: join(root, 'pool'),
        LANE_POOL_AUTO_RECOVER: '0', LANE_POOL_NO_RECOVER: '1',
        VITEST: 'true', WE_TEST_HOST_LOAD1: '0', WE_TEST_HOST_MEMORY_MB: '999999',
        WE_HOST_CAPACITY_SIGNAL: 'load' },
    });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const calls = readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    expect(calls.filter(call => call.cwd === dir)).toEqual([]);
    const healthyCalls = calls.filter(call => call.cwd === healthy);
    expect(healthyCalls.map(call => call.args.includes('--no-detach')))
      .toEqual(mode === 'fallback' ? [true, false] : [true]);
    expect(calls.every(call => call.cwd === healthy || call.cwd === lateLane)).toBe(true);
    if (mode === 'quarantined before fallback') {
      expect(calls.filter(call => call.cwd === lateLane).map(call => call.args.includes('--no-detach'))).toEqual([true]);
      expect(run.stderr).toContain('history quarantined; git gc refused');
      expect(existsSync(lateQuarantine)).toBe(true);
    } else {
      expect(calls).toHaveLength(mode === 'fallback' ? 2 : 1);
      expect(run.stderr).toContain('gc: pass completed');
    }
    expect(state()).toEqual(before);
    expect(readFileSync(quarantine, 'utf8')).toBe(quarantineBytes);
    expect(readFileSync(join(dir, 'new file.txt'), 'utf8')).toBe('new\n');
    expect(refs()).toBe('');
  });
}


it('keeps an unquarantined lane with missing ancestry when no backup/reprovision path is available', async () => {
  deleteParent();
  const before = state();
  let reclaims = 0;
  const result = await salvageDirtyLane({ ...options, quarantined: false, reprovision: undefined,
    reclaim: () => { reclaims++; },
  });
  expect(result).toEqual({ status: 'kept', reason: 'missing journal or provision path; inspect manually' });
  expect(reclaims).toBe(0); expect(state()).toEqual(before); expect(refs()).toBe('');
  expect(readFileSync(join(dir, 'new file.txt'), 'utf8')).toBe('new\n');
  expect(existsSync(mapFile)).toBe(false); expect(existsSync(leaseFile())).toBe(false);
});
