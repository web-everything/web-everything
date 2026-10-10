/**
 * @file scripts/lib/__tests__/drain-followup-job.test.mjs
 * @description #4124 slice 1 — the `drain-followup` job kind on the REAL #4125 job runtime and real git:
 *   the kind's shape (mutates-tree, serial), the record input (what main cannot re-derive), the dedicated
 *   linked worktree (never a primary clone), each step's lock / reset / push rules, and one real detached
 *   launch that is SIGKILLed mid-job, picked up by a fresh store after a simulated daemon restart, and resumes
 *   from its checkpoint so numbering and its push happen exactly once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DRAIN_FOLLOWUP_ENTRY, DRAIN_FOLLOWUP_KIND, assertLinkedWorktree, buildFollowupInput, defineDrainFollowupKind,
  followupNeeded, followupSteps, makeFollowupWorktreePreparer,
} from '../drain-followup-job.mjs';
import { createJobStore, enqueueJob, reattachTick } from '../daemon-jobs-runtime.mjs';
import { kindRegistry } from '../daemon-jobs.mjs';
import { planResolveOnLand, syncPrimaryOnLand } from '../../merge-ai-prs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const LIB = resolve(HERE, '..', 'drain-followup-job.mjs');
const RUNTIME = resolve(HERE, '..', 'daemon-jobs-runtime.mjs');
const LOCK = resolve(HERE, '..', '..', 'readiness', 'drain-lock.mjs');
const MERGE = resolve(HERE, '..', '..', 'merge-ai-prs.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await sleep(50);
  }
}

const git = (cwd, ...args) => String(execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();

let tmp;
let origin;
let clone;
let worktree;

/** A bare `origin`, a primary clone of it (stands in for the daemon clone) and the job's linked worktree. */
function makeRepos() {
  tmp = mkdtempSync(join(tmpdir(), 'we-drain-followup-'));
  origin = join(tmp, 'origin.git');
  clone = join(tmp, 'clone');
  worktree = join(tmp, 'jobs', 'drain-followup-tree');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' });
  const hooks = join(tmp, 'no-hooks');
  mkdirSync(hooks);
  git(clone, 'config', 'core.hooksPath', hooks);
  git(clone, 'config', 'user.name', 'test');
  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(clone, 'backlog'));
  writeFileSync(join(clone, 'backlog', 'xabc123-item.md'), 'status: open\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'seed');
  git(clone, 'push', '-q', 'origin', 'main');
}

beforeEach(() => makeRepos());
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('the drain-followup kind', () => {
  it('is a serial, resumable mutates-tree kind whose entry exists in the repo', () => {
    const def = defineDrainFollowupKind({ prepareWorktree: () => '/x' });
    expect(def).toMatchObject({ kind: DRAIN_FOLLOWUP_KIND, entry: DRAIN_FOLLOWUP_ENTRY, codeMode: 'mutates-tree', serial: true, resumable: true });
    expect(existsSync(join(REPO_ROOT, DRAIN_FOLLOWUP_ENTRY))).toBe(true);
  });

  it('refuses to be declared without its own worktree', () => {
    expect(() => defineDrainFollowupKind({})).toThrow(/prepareWorktree/);
  });
});

describe('buildFollowupInput', () => {
  it('keeps exactly what resolve-on-land cannot re-derive from main, as plain JSON', () => {
    const input = buildFollowupInput({
      passId: 'p1', landedLocal: true,
      merged: [{ num: 12, repo: 'we/we', extra: 1 }, { repo: 'no-num' }],
      landedItems: ['xabc123', 42, null],
      carriers: [{ item: 'xabc123', repo: null, isWe: true, headRef: 'lane/a', manifestRefs: ['lane/a', 'lane/b', ''] }, { headRef: 'no-item' }],
      openHeadRefs: new Set(['lane/b']),
    });
    expect(input).toEqual({
      passId: 'p1', landedLocal: true, merged: [{ num: 12, repo: 'we/we' }], landedItems: ['xabc123', '42'],
      carriers: [{ item: 'xabc123', repo: null, isWe: true, headRef: 'lane/a', manifestRefs: ['lane/a', 'lane/b'] }],
      openHeadRefs: ['lane/b'],
    });
    expect(JSON.parse(JSON.stringify(input))).toEqual(input);
    expect(followupNeeded(input)).toBe(true);
    expect(followupNeeded(buildFollowupInput({}))).toBe(false);
  });
});

describe('the dedicated worktree', () => {
  it('adds one linked worktree at origin/main, reuses it, and never accepts a primary clone', () => {
    const prepare = makeFollowupWorktreePreparer({ repoDir: clone, worktreeDir: worktree });
    expect(prepare()).toBe(worktree);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(git(clone, 'rev-parse', 'origin/main'));
    expect(prepare()).toBe(worktree); // reused, not re-added
    expect(git(clone, 'worktree', 'list').split('\n')).toHaveLength(2);
    expect(() => assertLinkedWorktree({ cwd: clone })).toThrow(/not a linked worktree/);
  });
});

/** Fakes that count effects; `withNumberingLock` records the options the step passed. */
function fakes({ lockRan = true, pushOk = true, regen } = {}) {
  const calls = { lock: [], number: 0, resolve: [], push: [], regen: 0 };
  const deps = {
    cwd: worktree,
    withNumberingLock: (fn, opts) => {
      calls.lock.push(opts);
      return lockRan ? { ran: true, result: fn(() => {}) } : { ran: false, result: undefined, heldBy: 'other:1:drain', reason: 'live' };
    },
    numberPendingHashes: () => { calls.number += 1; return { assigned: [{ hash: 'xabc123', nnn: 7 }], committed: true }; },
    resolveLandedItem: (_cwd, id, o) => { calls.resolve.push({ id, ...o }); return { flipped: true }; },
    planResolveOnLand,
    pushNumberingOnLand: (o) => { calls.push.push(o.shouldPush); return pushOk ? { pushed: true } : { pushed: false, warning: 'push FAILED (rejected)' }; },
    regenDerivedOnLand: regen || (() => { calls.regen += 1; return { ran: true, done: ['npm run gen:inventory'], failed: [], committed: true, pushed: true }; }),
  };
  return { calls, deps };
}

describe('followupSteps', () => {
  const input = buildFollowupInput({
    landedLocal: true, landedItems: ['xabc123', 'xdef456'],
    carriers: [
      { item: 'xabc123', isWe: true, headRef: 'lane/a', manifestRefs: ['lane/a'] },
      { item: 'xdef456', isWe: true, headRef: 'lane/c', manifestRefs: ['lane/c', 'lane/c-impl'] },
    ],
    openHeadRefs: ['lane/c-impl'],
  });

  beforeEach(() => { makeFollowupWorktreePreparer({ repoDir: clone, worktreeDir: worktree })(); });

  it('numbers, resolves from the RECORD (deferring a half-open couple) and pushes once, under the lock with no unlocked fallback', () => {
    // A crashed earlier attempt left an unpushed local commit: the step must rebuild from the remote tip.
    writeFileSync(join(worktree, 'backlog', 'stray.md'), 'x');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-q', '-m', 'stray unpushed numbering commit');
    const { calls, deps } = fakes();
    const out = followupSteps(deps)[0].run({ input });
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(git(clone, 'rev-parse', 'origin/main'));
    expect(calls.lock).toEqual([{ runUnlockedOnContention: false }]);
    expect(calls.number).toBe(1);
    expect(calls.resolve).toEqual([{ id: 7, sync: false, publish: false }]);
    expect(calls.push).toEqual([true]);
    expect(out.numbering).toMatchObject({ assigned: [{ hash: 'xabc123', nnn: 7 }], committed: true, pushed: true });
    expect(out.resolveOnLand.resolved).toEqual(['7']);
    expect(out.resolveOnLand.deferred).toEqual([expect.objectContaining({ id: 'xdef456' })]);
  });

  it('throws (so the job retries) and writes nothing when the numbering lock is held', () => {
    const { calls, deps } = fakes({ lockRan: false });
    expect(() => followupSteps(deps)[0].run({ input })).toThrow(/numbering lock held by other:1:drain/);
    expect(calls.number).toBe(0);
  });

  it('throws when the push is rejected, so the retry renumbers on the new tip', () => {
    const { deps } = fakes({ pushOk: false });
    expect(() => followupSteps(deps)[0].run({ input })).toThrow(/push FAILED/);
  });

  it('derived regen: retries a failed push, but records (never retries) generators that all failed', () => {
    const pushFail = fakes({ regen: () => ({ ran: true, done: ['npm run gen:inventory'], failed: [], committed: false, pushed: false, warning: 'derived-artifact regen committed/pushed FAILED (x)' }) });
    expect(() => followupSteps(pushFail.deps)[1].run({ input })).toThrow(/pushed FAILED/);
    const genFail = fakes({ regen: () => ({ ran: true, done: [], failed: [{ cmd: 'npm run gen:inventory', detail: 'boom' }], committed: false, pushed: false, warning: 'derived-artifact regen failed (non-fatal): npm run gen:inventory' }) });
    expect(followupSteps(genFail.deps)[1].run({ input }).derived).toMatchObject({ committed: false, failed: [{ cmd: 'npm run gen:inventory' }] });
  });

  it('refuses to run in a primary clone (the daemon clone is never reset)', () => {
    const { deps } = fakes();
    expect(() => followupSteps({ ...deps, cwd: clone })[0].run({ input })).toThrow(/not a linked worktree/);
  });
});

describe('followupSteps — primary-sync (the third step)', () => {
  const input = buildFollowupInput({ landedLocal: true, primary: '/ops/primary', primaryHinted: true });
  /** An exec double answering the primary-checkout git probes; `over` replaces an answer (a function throws/returns). */
  const primaryExec = (over = {}) => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      const sub = args.slice(2).join(' '); // after `-C <primary>`
      const answer = { 'rev-parse --abbrev-ref HEAD': 'main\n', 'status --porcelain --untracked-files=no': '', 'pull --ff-only': 'Updating\n', ...over }[sub];
      if (typeof answer === 'function') return answer();
      if (answer === undefined) throw new Error(`unexpected git ${sub}`);
      return answer;
    };
    return { calls, exec };
  };
  const step = (extra = {}) => followupSteps({ ...fakes().deps, syncPrimaryOnLand, ...extra })[2];
  beforeEach(() => { makeFollowupWorktreePreparer({ repoDir: clone, worktreeDir: worktree })(); }); // the cwd must exist to be compared

  it('is registered third, after numbering and derived regen, so the primary also gets their commits', () => {
    expect(followupSteps({ ...fakes().deps, syncPrimaryOnLand }).map((x) => x.name)).toEqual(['number-resolve-push', 'derived-regen', 'primary-sync']);
  });

  it('no primary in the record (or no sync dep) → recorded as not-located, nothing run', () => {
    const { calls, exec } = primaryExec();
    expect(step({ exec }).run({ input: buildFollowupInput({ landedLocal: true }) }).primarySync).toMatchObject({ synced: false, reason: 'not-located' });
    expect(followupSteps({ ...fakes().deps, exec })[2].run({ input }).primarySync).toMatchObject({ synced: false, reason: 'not-located' });
    expect(calls).toEqual([]);
  });

  it('a clean primary on main is fast-forwarded with a plain pull --ff-only (never autostash)', () => {
    const { calls, exec } = primaryExec();
    expect(step({ exec }).run({ input }).primarySync).toMatchObject({ synced: true, reason: 'synced' });
    expect(calls.at(-1)).toEqual(['git', '-C', '/ops/primary', 'pull', '--ff-only']);
    expect(calls.flat()).not.toContain('--autostash');
  });

  it('every skip is RECORDED, never thrown (a thrown step would burn the job retries)', () => {
    const boom = () => { throw new Error('fatal'); };
    const dirty = primaryExec({ 'status --porcelain --untracked-files=no': ' M backlog/x.md\n' });
    expect(step({ exec: dirty.exec }).run({ input }).primarySync).toMatchObject({ synced: false, reason: 'dirty' });
    expect(dirty.calls.some((c) => c.includes('pull'))).toBe(false); // a dirty primary is left untouched
    expect(step({ exec: primaryExec({ 'rev-parse --abbrev-ref HEAD': 'feature\n' }).exec }).run({ input }).primarySync).toMatchObject({ synced: false, reason: 'not-on-main' });
    expect(step({ exec: primaryExec({ 'rev-parse --abbrev-ref HEAD': boom }).exec }).run({ input }).primarySync).toMatchObject({ synced: false, reason: 'not-a-repo' });
    expect(step({ exec: primaryExec({ 'status --porcelain --untracked-files=no': boom }).exec }).run({ input }).primarySync).toMatchObject({ synced: false, reason: 'status-failed' });
    expect(step({ exec: primaryExec({ 'pull --ff-only': boom }).exec }).run({ input }).primarySync).toMatchObject({ synced: false, reason: 'diverged' });
  });

  it('"is the primary the cwd" is judged against the JOB worktree: the worktree itself is skipped, any other checkout is synced', () => {
    const { calls, exec } = primaryExec();
    const self = step({ exec }).run({ input: buildFollowupInput({ landedLocal: true, primary: worktree }) });
    expect(self.primarySync).toMatchObject({ synced: false, reason: 'from-primary' });
    expect(calls).toEqual([]);
    expect(step({ exec }).run({ input: buildFollowupInput({ landedLocal: true, primary: clone }) }).primarySync).toMatchObject({ synced: true });
  });

  it('a primary that IS the pass\'s own checkout (input.passCwd) is skipped — the pass already synced it inline, the job is not a second writer', () => {
    const { calls, exec } = primaryExec();
    const out = step({ exec }).run({ input: buildFollowupInput({ landedLocal: true, primary: clone, passCwd: clone }) });
    expect(out.primarySync).toMatchObject({ synced: false, reason: 'from-primary' });
    expect(calls).toEqual([]);
  });
});

describe('buildFollowupInput — primary', () => {
  it('round-trips the primary and its hinted flag as plain JSON; absent when there is none', () => {
    const withPrimary = buildFollowupInput({ landedLocal: true, primary: '/ops/primary', primaryHinted: 1 });
    expect(withPrimary).toMatchObject({ primary: '/ops/primary', primaryHinted: true });
    expect(JSON.parse(JSON.stringify(withPrimary))).toEqual(withPrimary);
    expect(buildFollowupInput({ landedLocal: true, primary: '/p' }).primaryHinted).toBe(false);
    expect(buildFollowupInput({ landedLocal: true, primary: '/p', passCwd: '/pass' }).passCwd).toBe('/pass');
    expect('primary' in buildFollowupInput({ landedLocal: true })).toBe(false);
    expect('primaryHinted' in buildFollowupInput({ landedLocal: true, primaryHinted: true })).toBe(false);
  });
});

describe('a real detached drain-followup job across a daemon restart', () => {
  it('is SIGKILLed mid-job, reattached by a fresh store, resumes from its checkpoint, and numbers + pushes exactly once', async () => {
    const jobsDir = join(tmp, 'jobs', 'records');
    const lockRoot = join(tmp, 'locks');
    const effects = join(tmp, 'effects.log');
    mkdirSync(jobsDir, { recursive: true });
    const prepareWorktree = () => {
      const dir = makeFollowupWorktreePreparer({ repoDir: clone, worktreeDir: worktree })();
      // The job's own entry, with test I/O: real git, real lock (in a temp root), real push to the temp origin.
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, DRAIN_FOLLOWUP_ENTRY), [
        `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';`,
        `import { execFileSync } from 'node:child_process';`,
        `import { join } from 'node:path';`,
        `import { runJob } from ${JSON.stringify(RUNTIME)};`,
        `import { followupSteps } from ${JSON.stringify(LIB)};`,
        `import { withNumberingLock } from ${JSON.stringify(LOCK)};`,
        `import { planResolveOnLand, pushNumberingOnLand } from ${JSON.stringify(MERGE)};`,
        `const cwd = process.cwd();`,
        `const effect = (s) => appendFileSync(${JSON.stringify(effects)}, s + ' pid=' + process.pid + '\\n');`,
        `const git = (...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });`,
        `const steps = followupSteps({`,
        `  cwd, planResolveOnLand, pushNumberingOnLand,`,
        `  withNumberingLock: (fn, o) => withNumberingLock(fn, { ...o, lockRoot: ${JSON.stringify(lockRoot)}, waitMs: 5000 }),`,
        `  numberPendingHashes: () => {`,
        `    if (!existsSync(join(cwd, 'backlog', 'xabc123-item.md'))) return { assigned: [], committed: false };`,
        `    git('mv', 'backlog/xabc123-item.md', 'backlog/7-item.md'); git('commit', '-q', '-m', 'number xabc123 -> 7');`,
        `    effect('numbered'); return { assigned: [{ hash: 'xabc123', nnn: 7 }], committed: true };`,
        `  },`,
        `  resolveLandedItem: (_c, id) => { effect('resolved ' + id); return { alreadyResolved: true }; },`,
        `  regenDerivedOnLand: () => {`,
        `    if (process.env.DAEMON_JOB_ATTEMPT === '1') { effect('crash-in-regen'); process.kill(process.pid, 'SIGKILL'); }`,
        `    effect('regen'); return { ran: true, done: ['gen'], failed: [], committed: false, pushed: false };`,
        `  },`,
        `});`,
        `const out = await runJob({ steps });`,
        `process.exit(out.outcome === 'succeeded' ? 0 : 1);`,
      ].join('\n'));
      return dir;
    };
    const kinds = () => kindRegistry([defineDrainFollowupKind({ prepareWorktree })]);
    const tickOpts = { maxConcurrent: 1, heartbeatIntervalMs: 100, backoffBaseMs: 1 };

    // Daemon A: the pass records the job and the tick launches it detached.
    const storeA = createJobStore(jobsDir);
    enqueueJob({ store: storeA, kindDef: kinds().get(DRAIN_FOLLOWUP_KIND), id: 'fu-1', input: buildFollowupInput({ passId: 'p1', landedLocal: true, landedItems: ['xabc123'], carriers: [{ item: 'xabc123', isWe: true, headRef: 'lane/a', manifestRefs: ['lane/a'] }] }) });
    const first = await reattachTick({ store: storeA, kinds: kinds(), ...tickOpts });
    expect(first.actions).toEqual([expect.objectContaining({ id: 'fu-1', action: 'launch', attempt: 1 })]);
    // The child dies mid-job (step 2), after step 1 checkpointed — daemon A is gone too.
    await waitFor(() => existsSync(effects) && readFileSync(effects, 'utf8').includes('crash-in-regen'));
    await sleep(300);
    expect(storeA.read('fu-1').job).toMatchObject({ status: 'running', checkpoint: { step: 1 } });

    // Daemon B boots with a fresh store on the same records: reattach sees the dead handle and requeues.
    const storeB = createJobStore(jobsDir);
    const boot = await reattachTick({ store: storeB, kinds: kinds(), ...tickOpts });
    expect(boot.actions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fu-1', state: 'dead', action: 'requeue' })]));
    expect(storeB.read('fu-1').job.status).toMatch(/queued|launching|running/);
    await sleep(20); // past the 1 ms backoff
    if (storeB.read('fu-1').job.status === 'queued') await reattachTick({ store: storeB, kinds: kinds(), ...tickOpts });
    await waitFor(() => storeB.read('fu-1').job.status === 'succeeded');

    const job = storeB.read('fu-1').job;
    const started = job.timeline.filter((e) => e.event === 'started');
    expect(started.map((e) => [e.attempt, e.fromStep])).toEqual([[1, 0], [2, 1]]);
    expect(job.checkpoint.data.numbering).toMatchObject({ committed: true, pushed: true, assigned: [{ hash: 'xabc123', nnn: 7 }] });
    const lines = readFileSync(effects, 'utf8').trim().split('\n').map((l) => l.replace(/ pid=\d+$/, ''));
    expect(lines).toEqual(['numbered', 'resolved 7', 'crash-in-regen', 'regen']);
    // Numbering reached origin exactly once.
    git(clone, 'fetch', '-q', 'origin');
    expect(git(clone, 'log', '--format=%s', 'origin/main').split('\n').filter((s) => s.startsWith('number '))).toEqual(['number xabc123 -> 7']);
  }, 60_000);
});
