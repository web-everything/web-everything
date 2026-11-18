/**
 * @file scripts/__tests__/lane-pool-acquire-base.test.mjs
 * @description Proof of #2386 — `acquire --base=<ref>` lands the leased clone at a PREDECESSOR LANE'S TIP
 *   (an arbitrary ref, typically another lane's pushed `lane/*` branch) instead of `origin/<branch>`. This is
 *   the building block for overlap-stacked serial batches: a later lane's work can build on an earlier lane's
 *   not-yet-merged commits. Still a pool clone — the reset happens INSIDE the leased lane's own clone, same as
 *   the default path it replaces; the primary checkout is never touched (#2219/#104). These tests spawn the
 *   real CLI against a throwaway local origin + reference checkout (no network, no shared pool root) and
 *   assert: `--base=<ref>` (a bare branch name resolved via `origin/<ref>`) lands the clone at that ref's tip,
 *   content and all; a `--base` ref that isn't on origin hard-fails loud, touching nothing; and plain
 *   `acquire` (no `--base`) keeps landing on `origin/<branch>`, unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos, withGhStub, scopeTestEnv } from './fixtures/shared-git-fixture.mjs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: withGhStub({ ...process.env, ...(base ? scopeTestEnv(base) : {}), ...extraEnv }) });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

let base, originDir, referenceDir, poolRoot;

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-acquire-base-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'main-tip\n');
  git(['add', 'file.txt'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'main v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-acquire-base-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

function provision(count) {
  const r = runPool(
    ['provision', `--count=${count}`, `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install'],
    { LANE_POOL_ROOT: poolRoot },
  );
  expect(r.code).toBe(0);
}

// Simulate a predecessor lane: commit + push a `lane/*` branch to origin, distinct from `main`'s tip.
function pushPredecessorLaneRef(refName, fileContents) {
  const scratch = join(base, 'predecessor-scratch');
  git(['clone', '--quiet', originDir, scratch]);
  writeFileSync(join(scratch, 'file.txt'), fileContents);
  git(['add', 'file.txt'], scratch);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'predecessor lane tip'], scratch);
  git(['push', '--quiet', 'origin', `HEAD:refs/heads/${refName}`], scratch);
  return git(['rev-parse', 'HEAD'], scratch);
}

describe('lane-pool acquire --base=<ref> (#2386)', () => {
  it('lands the clone at the predecessor lane ref\'s tip, not origin/main', () => {
    provision(2);
    const predecessorSha = pushPredecessorLaneRef('lane/predecessor-42', 'predecessor-tip\n');

    const r = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--base=lane/predecessor-42', '--json'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    const info = JSON.parse(r.out);
    expect(info.base).toBe('lane/predecessor-42');
    const lane = info.path;

    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('predecessor-tip\n');
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(predecessorSha);
  });

  it('also resolves a fully-qualified origin/<ref> the same way', () => {
    provision(2);
    pushPredecessorLaneRef('lane/predecessor-fq', 'fq-tip\n');

    const r = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--base=origin/lane/predecessor-fq', '--json'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    const lane = JSON.parse(r.out).path;
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('fq-tip\n');
  });

  it('hard-fails loud on a --base ref that does not exist on origin, touching nothing', () => {
    const lane = join(poolRoot, 'basetest', 'lane-1');
    provision(1);

    const r = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--base=lane/does-not-exist'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--base=lane\/does-not-exist/);
    expect(r.err).toMatch(/does not resolve/);
    // The reset never ran — the lane's working tree is exactly as `provision` left it.
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('main-tip\n');

    // The failed acquire's lease claim (taken BEFORE ref resolution) is the same "leaves a lease behind on a
    // failed ready-phase step" behavior any acquire has always had (e.g. a `git fetch` failure) — release
    // --force is the documented escape hatch (#2337b), after which the lane is normally acquirable again.
    const rel = runPool(
      ['release', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--force'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(rel.code).toBe(0);
    const retry = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--json'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(retry.code).toBe(0);
  });

  it('rejects --base + --no-reset as mutually exclusive, before claiming any lane (touches nothing)', () => {
    provision(1);
    pushPredecessorLaneRef('lane/predecessor-combo', 'combo-tip\n');
    const lane = join(poolRoot, 'basetest', 'lane-1');

    const r = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--base=lane/predecessor-combo', '--no-reset', '--json'],
      { LANE_POOL_ROOT: poolRoot },
    );
    // Fails loud rather than silently misreporting the base as applied under --no-reset.
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--base=lane\/predecessor-combo/);
    expect(r.err).toMatch(/--no-reset/);
    expect(r.err).toMatch(/mutually exclusive/);
    // No JSON on stdout — it never got as far as reporting a lane.
    expect(r.out.trim()).toBe('');
    // The guard runs BEFORE any lane is claimed: no lease was taken, so lane-1 acquires cleanly with no
    // --force release needed, and its working tree is exactly as `provision` left it.
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('main-tip\n');
    const retry = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--json'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(retry.code).toBe(0);
  });

  it('absent --base preserves current origin/<branch> behavior (unchanged)', () => {
    provision(1);
    pushPredecessorLaneRef('lane/irrelevant', 'should-not-be-used\n');

    const r = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--json'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    const info = JSON.parse(r.out);
    expect(info.base).toBeNull();
    expect(readFileSync(join(info.path, 'file.txt'), 'utf8')).toBe('main-tip\n');
  });

  // Regression: `--base=<branch-name>` MUST resolve via the freshly-fetched `origin/<ref>`, never via a
  // same-named LOCAL ref left over in the lane's own clone from a prior reset — `fetch` only updates
  // remote-tracking refs, so a same-named local branch (most obviously `main` itself) silently goes stale.
  // Caught live pre-fix: `--base=main` after `origin/main` advanced past the lane's last reset returned the
  // OLD content with no error, because the bare ref was tried (and resolved) before `origin/<ref>`.
  it('--base=main resolves via the freshly-fetched origin/main, not this lane\'s own stale local main', () => {
    provision(1);
    // First acquire lands the lane's local `main` at the CURRENT origin/main tip ("main-tip") — this is what a
    // same-named local ref would still point at below, if the resolver preferred it over `origin/main`.
    const first = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--json'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(first.code).toBe(0);
    const lane = JSON.parse(first.out).path;
    runPool(['release', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main'], { LANE_POOL_ROOT: poolRoot });

    // Advance origin/main past the lane's last-seen tip.
    writeFileSync(join(referenceDir, 'file.txt'), 'main-advanced\n');
    git(['add', 'file.txt'], referenceDir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'main v2'], referenceDir);
    git(['push', '--quiet', 'origin', 'main'], referenceDir);

    const r = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--base=main', '--json'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).path).toBe(lane);
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('main-advanced\n'); // NOT the stale 'main-tip'
  });

  // #2419 — a lane can be left ATTACHED to a stray `lane/*` local branch (a leftover from an earlier
  // rebase-drop or a manual checkout in that clone) instead of its own `repo.branch` (`main`). A bare
  // `reset --hard` moves whatever branch HEAD happens to be on without changing which branch that is, so a
  // reset-only fix would leave the lane attached to the stray branch forever, just with fresher content —
  // exactly the state that stranded JIT numbering downstream (the drain's post-land `pull --ff-only` needs
  // an attached branch WITH an upstream, which a `lane/*` branch never has). `acquire` must always land HEAD
  // back on `repo.branch` itself, regardless of what branch it started on.
  it('recovers a lane left attached to a stray lane/* branch, landing HEAD back on repo.branch (main)', () => {
    provision(1);
    const lane = join(poolRoot, 'basetest', 'lane-1');
    // Simulate the strand: check out a local `lane/*` branch inside the lane's own clone, as an earlier
    // rebase-drop or manual recovery step might have left it.
    git(['checkout', '--quiet', '-b', 'lane/file-2417'], lane);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], lane)).toBe('lane/file-2417');

    const r = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--json'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    const info = JSON.parse(r.out);
    expect(info.path).toBe(lane);
    // HEAD is attached to the lane's own `main` again — never left on the stray branch.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], lane)).toBe('main');
    expect(git(['rev-parse', 'main'], lane)).toBe(git(['rev-parse', 'origin/main'], lane));
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('main-tip\n');
  });

  // #2419 pre-PR review catch — `checkout -B` (unlike `reset --hard`) runs the ordinary safe-checkout
  // tree-merge and REFUSES on a dirty TRACKED-file conflict ("local changes would be overwritten by
  // checkout") unless `--force` is also passed to the git invocation. `acquire --lane=N` (the EXPLICIT-lane
  // path — e.g. a batch orchestrator re-acquiring its own known lane number, which skips the auto-pick
  // `chooseFreeLane` dirty filter entirely, unlike the bare auto-pick path) used to reset unconditionally on
  // tree cleanliness regardless — #3390 changed that: without the application-level `--force`, this path now
  // REFUSES before ever reaching the git-level `checkout -B --force` below (a lease going stale, or a lane
  // simply released dirty, is not evidence the tree holds abandoned garbage — see the real incident named in
  // #3390). `--force` restores the old unconditional-discard behavior, at which point the underlying
  // `checkout -B --force` git mechanics still need their own `--force` to not throw on the tree-merge
  // conflict — this pins both layers.
  function dirtyLaneAgainstAdvancedOrigin() {
    provision(1);
    const lane = join(poolRoot, 'basetest', 'lane-1');
    // First acquire lands the lane on `main` at the current origin/main tip.
    const first = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--lane=1', '--json'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(first.code).toBe(0);
    runPool(['release', '--lane=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main'], { LANE_POOL_ROOT: poolRoot });

    // Advance origin/main past the lane's last-seen tip, so a --force acquire has real incoming content to
    // conflict against the lane's dirty uncommitted edit.
    writeFileSync(join(referenceDir, 'file.txt'), 'main-advanced-2\n');
    git(['add', 'file.txt'], referenceDir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'main v3'], referenceDir);
    git(['push', '--quiet', 'origin', 'main'], referenceDir);

    // Dirty the lane's tracked file with an UNCOMMITTED edit that conflicts with the incoming content.
    writeFileSync(join(lane, 'file.txt'), 'uncommitted dirty edit\n');
    expect(git(['status', '--porcelain'], lane)).toContain('file.txt');
    return lane;
  }

  it('WITHOUT --force, now REFUSES a dirty tracked-file conflict rather than discarding it (#3390)', () => {
    const lane = dirtyLaneAgainstAdvancedOrigin();

    const r = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--lane=1', '--json'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/would destroy that work/);
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('uncommitted dirty edit\n'); // survives
  });

  it('WITH --force, still discards a dirty tracked-file conflict unconditionally (mirrors reset --hard, #2419)', () => {
    const lane = dirtyLaneAgainstAdvancedOrigin();

    const r = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--lane=1', '--force', '--json'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0); // never throws on the git-level tree-merge conflict — succeeds exactly like reset --hard did
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('main-advanced-2\n'); // dirty edit discarded
    expect(git(['status', '--porcelain'], lane)).toBe('');
  });
});

describe('lane-pool acquire --purpose=workflow-lane marks the lease (#2413)', () => {
  const leaseOf = (lane) => JSON.parse(readFileSync(join(lane, '.git', '.lane-lease'), 'utf8'));

  it('stamps workflowLane:true and the LANE_SESSION slug into the lease', () => {
    provision(1);
    const r = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--lane=1', '--purpose=workflow-lane', '--ttl-minutes=90', '--json'],
      { LANE_POOL_ROOT: poolRoot, LANE_SESSION: 'batch-x-2427' },
    );
    expect(r.code).toBe(0);
    const lease = leaseOf(JSON.parse(r.out).path);
    expect(lease.workflowLane).toBe(true);
    expect(lease.session).toBe('batch-x-2427');   // the minted slug the guard requires an op to assert
    expect(lease.purpose).toBe('workflow-lane');
    expect(lease.ttlMinutes).toBe(90);
  });

  it('a normal (non-workflow) acquire leaves workflowLane false — unmarked, today\'s semantics', () => {
    provision(1);
    const r = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--lane=1', '--purpose=drain', '--json'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(leaseOf(JSON.parse(r.out).path).workflowLane).toBe(false);
  });
});

describe('lane-pool acquire --scope= persists advisory predicted scope (#2560)', () => {
  const leaseOf = (lane) => JSON.parse(readFileSync(join(lane, '.git', '.lane-lease'), 'utf8'));

  it('stamps predictedScope into the marker AND keeps stdout the clean lane path (LANE= contract)', () => {
    provision(1);
    // No --json: stdout must be ONLY the lane path (the `LANE=$(… acquire)` capture must stay clean).
    const r = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--lane=1', '--scope=we:src/a.ts,we:src/b.ts'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    const lanePath = r.out.trim();
    // stdout is the lane path and NOTHING else (no advisory text, no JSON leaked onto stdout).
    expect(r.out).toBe(lanePath + '\n');
    const lease = leaseOf(lanePath);
    expect(lease.predictedScope).toEqual(['we:src/a.ts', 'we:src/b.ts']);
  });

  it('a plain acquire (no --scope) OMITS predictedScope from the marker (back-compat)', () => {
    provision(1);
    const r = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--lane=1'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect('predictedScope' in leaseOf(r.out.trim())).toBe(false);
  });

  it('refuses before claiming; explicit overlap is audited and release clears only its own entry', () => {
    provision(2);
    const common = [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install', '--session=scope-test'];
    const env = { LANE_POOL_ROOT: poolRoot };
    const first = runPool(['acquire', ...common, '--lane=1', '--scope=we:src/shared.ts'], env);
    expect(first.code).toBe(0);
    const registry = () => JSON.parse(readFileSync(join(base, 'agent-scopes.json'), 'utf8')).entries;
    expect(registry()[0]).toMatchObject({ agent: 'lane-1', lane: 1, files: ['we:src/shared.ts'] });
    expect(registry()[0].owner).toBe(leaseOf(first.out.trim()).holder);
    // No 45-minute heartbeat window: a live lane's claim must not expire while it is still leased.
    expect(registry()[0].staleAfterMinutes).toBeUndefined();
    expect(registry()[0].ttlHours).toBe(12);
    const args = ['acquire', ...common, '--lane=2', '--scope=we:src/shared.ts'];
    const refused = runPool(args, env);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toMatch(/scope overlap:.*lane-1/);
    expect(refused.err).toContain('--allow-overlap=<reason>');
    expect(existsSync(join(poolRoot, 'basetest/lane-2/.git/.lane-lease'))).toBe(false);
    expect(runPool([...args, '--allow-overlap='], env).code).not.toBe(0);
    expect(runPool([...args, '--allow-overlap'], env).code).not.toBe(0);
    const allowed = runPool([...args, '--allow-overlap=paired work'], env);
    expect(allowed.code).toBe(0);
    const audit = JSON.parse(readFileSync(join(base, 'scope-overlap-allowed.jsonl'), 'utf8'));
    expect(audit).toMatchObject({ scope: ['we:src/shared.ts'], reason: 'paired work', session: 'scope-test',
      overlaps: [{ file: 'we:src/shared.ts', agent: 'lane-1', lane: 1 }] });
    expect(Number.isFinite(Date.parse(audit.ts))).toBe(true);
    const released = runPool(['release', ...common, '--lane=2', `--session=${leaseOf(allowed.out.trim()).holder}`], env);
    expect(released.code).toBe(0);
    expect(registry().map(e => e.agent)).toEqual(['lane-1']);
  });

  it('concurrent overlapping acquires across pools admit exactly one without an override', async () => {
    provision(1);
    const otherRoot = join(base, 'other-pool');
    const common = [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main', '--no-install'];
    expect(runPool(['provision', ...common, '--count=1'], { LANE_POOL_ROOT: otherRoot }).code).toBe(0);
    const connections = new Set();
    let arrived = 0;
    const server = createServer(socket => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
      // Each reader blocks at its first PR read until BOTH acquires reach admission.
      if (++arrived >= 2) {
        for (const waiting of connections) waiting.end('go');
        connections.clear();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const reader = join(base, 'synchronized-reader.mjs');
    writeFileSync(reader, `#!/usr/bin/env node
import { connect } from 'node:net';
const socket = connect(${server.address().port}, '127.0.0.1');
socket.once('data', () => { process.stdout.write('[]'); socket.end(); });
`, { mode: 0o755 });
    const children = [];
    const start = (root, session) => {
      const child = spawn(process.execPath, [SCRIPT, 'acquire', ...common, '--lane=1', '--no-reap',
        '--scope=we:src/concurrent.ts', `--session=${session}`], {
        env: withGhStub({ ...process.env, ...scopeTestEnv(base), WE_FREE_SCOPE_GH_BIN: reader, LANE_POOL_ROOT: root }),
      });
      children.push(child);
      let out = '', err = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { err += chunk; });
      return once(child, 'close').then(([code]) => ({ code, out, err }));
    };
    const deadline = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 20000);
    try {
      const results = await Promise.all([start(poolRoot, 'concurrent-a'), start(otherRoot, 'concurrent-b')]);
      expect(arrived).toBe(4); // Both callers completed both repo reads; no network evidence was skipped.
      expect(results.filter(result => result.code === 0)).toHaveLength(1);
      expect(results.filter(result => result.code !== 0)).toHaveLength(1);
      expect(results.find(result => result.code !== 0).err).toContain('scope overlap:');
      const entries = JSON.parse(readFileSync(join(base, 'agent-scopes.json'), 'utf8')).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0].agent).toBe('lane-1');
      expect(existsSync(join(base, 'scope-overlap-allowed.jsonl'))).toBe(false);
    } finally {
      clearTimeout(deadline);
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
      for (const socket of connections) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('clears the pending scope reservation when acquire fails after admission', () => {
    provision(1);
    const common = [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest', '--branch=main',
      '--no-install', '--lane=1', '--no-reap', '--scope=we:src/failure.ts'];
    const env = { LANE_POOL_ROOT: poolRoot };
    const refused = runPool(['acquire', ...common, '--base=lane/missing'], env);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toMatch(/does not resolve/);
    expect(JSON.parse(readFileSync(join(base, 'agent-scopes.json'), 'utf8')).entries).toEqual([]);
    expect(runPool(['acquire', ...common], env).code).toBe(0);
  });

  it('refuses corrupt evidence even with an overlap override', () => {
    provision(1);
    writeFileSync(join(base, 'agent-scopes.json'), '{broken');
    const r = runPool(['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=basetest',
      '--branch=main', '--no-install', '--lane=1', '--scope=we:src/a.ts', '--allow-overlap=inspect'], { LANE_POOL_ROOT: poolRoot });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/cannot read registry/);
    expect(existsSync(join(poolRoot, 'basetest/lane-1/.git/.lane-lease'))).toBe(false);
  });
});
