// @vitest-environment node
/**
 * @file red-main-freeze-shared.test.mjs — card xyd06qo: the red-main freeze is published to a shared ops/* branch
 *   by the same CLI that raises/clears it locally, and the merge-gate reads that branch: pass while clear, hold while
 *   frozen, FAIL CLOSED whenever the shared copy is missing or unreadable. Every git/fs call is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLISH_ATTEMPTS, SHARED_FREEZE_FILE, buildSharedFreezeDoc, publishSharedFreeze, publishFreezeFromCli, readSharedFreeze, resolveFreezeBranch, timedGit,
} from '../red-main-freeze-shared.mjs';
import { evaluatePrGates } from '../merge-gate-ci.mjs';
import { loadMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';
import { applyFreezeRecheck, combineRedMain, gatherPrFacts, isMainFixPr, readMainCiFact, readRedMainFact } from '../../merge-gate-check.mjs';
import { isTrustedPrAuthor } from '../../conveyor/main-ci-red-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', '..', 'readiness', 'red-main-remediation.mjs');
const BRANCH = 'ops/red-main-freeze';

/** A git stub serving one file from the branch tip (or failing the fetch). */
const reader = ({ text = null, fetchFails = false } = {}) => (args) => {
  if (args[0] === 'fetch') { if (fetchFails) throw Object.assign(new Error('fetch failed'), { stderr: "fatal: couldn't find remote ref ops/red-main-freeze" }); return ''; }
  if (args[0] === 'ls-tree') return text == null ? '' : `${SHARED_FREEZE_FILE}\n`;
  if (args[0] === 'show') return text;
  return '';
};

/** The merge-gate's red-main-freeze row for a given shared read. */
const PR = { number: 1, title: 't', body: 'b', labels: [], commits: [], baseRefName: 'main', headRefName: 'lane/x', headRefOid: 'a'.repeat(40), statusCheckRollup: [] };
const gate = (redMain) => evaluatePrGates({ repo: 'o/r', num: 1, pr: PR, defaultBranch: 'main', redMain }).results.find((r) => r.id === 'red-main-freeze');

describe('shared red-main freeze (xyd06qo)', () => {
  it('the branch comes from the policy cascade (default ops/red-main-freeze)', () => {
    expect(resolveFreezeBranch({ toolSettings: {} })).toBe(BRANCH);
    expect(resolveFreezeBranch({ toolSettings: { mergeDelivery: { redMainFreezeBranch: 'ops/other-freeze' } } })).toBe('ops/other-freeze');
  });

  it('builds a frozen doc from a marker and a clear doc from no marker', () => {
    const fixed = { now: () => '2026-10-09T12:00:00.000Z', host: 'h' };
    expect(buildSharedFreezeDoc({ reason: 'post-land red', at: '2026-10-09T11:00:00Z', mergeSha: 'abc' }, fixed))
      .toMatchObject({ schema: 1, frozen: true, reason: 'post-land red', at: '2026-10-09T11:00:00Z', mergeSha: 'abc', publishedAt: '2026-10-09T12:00:00.000Z' });
    expect(buildSharedFreezeDoc(null, fixed)).toMatchObject({ frozen: false, reason: null, at: null });
  });

  it('publishes through the ops-branch transport, pinned to exactly that ref', () => {
    const calls = [];
    const run = (args) => { calls.push(args); return args[0] === 'diff' ? SHARED_FREEZE_FILE : ''; };
    const writes = [];
    const r = publishSharedFreeze({
      marker: { reason: 'red', at: 'x' }, board: '/board', branch: BRANCH, run,
      transport: { mkdir: () => {}, write: (p, c) => writes.push({ p, c }), rm: () => {}, now: () => 1 },
    });
    expect(r).toMatchObject({ branch: BRANCH, pushed: true, doc: { frozen: true, reason: 'red' } });
    expect(writes).toHaveLength(1);
    expect(writes[0].p).toBe(join('/board', '.operations', 'transport', 'wt-1', SHARED_FREEZE_FILE));
    expect(JSON.parse(writes[0].c)).toMatchObject({ frozen: true, reason: 'red' });
    expect(calls.find((a) => a[0] === 'push')).toEqual(['push', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`]);
  });

  it('refuses to publish to a non-ops ref', () => {
    expect(() => publishSharedFreeze({ marker: null, board: '/b', branch: 'main', run: () => '', transport: { mkdir: () => {}, write: () => {}, rm: () => {} } }))
      .toThrow(/only an ops\/<slug> branch/);
  });

  it('CLI hook: a failed publish keeps the local marker, reports loudly and exits non-zero', async () => {
    const lines = [];
    let code = 0;
    const r = await publishFreezeFromCli({
      marker: { reason: 'red' }, env: { WE_RED_MAIN_FREEZE_SHARED_BOARD: '/b' }, stderr: (s) => lines.push(s), setExitCode: (c) => { code = c; },
      publish: () => { throw new Error('push rejected'); }, sleep: async () => {},
    });
    expect(r).toMatchObject({ ok: false, error: 'push rejected', attempts: PUBLISH_ATTEMPTS });
    expect(code).toBe(1);
    expect(lines.join('')).toMatch(/SHARED copy was NOT published.*red-main-remediation\.mjs publish/s);
  });

  it('CLI hook: a rejected push is retried (bounded, with backoff) and succeeds once a later attempt lands', async () => {
    const lines = [];
    const waits = [];
    let calls = 0;
    let code = 0;
    const r = await publishFreezeFromCli({
      marker: { reason: 'red' }, env: { WE_RED_MAIN_FREEZE_SHARED_BOARD: '/b' }, stderr: (s) => lines.push(s), setExitCode: (c) => { code = c; },
      sleep: async (ms) => { waits.push(ms); },
      publish: () => { calls += 1; if (calls < 3) throw new Error('! [rejected] HEAD -> ops/red-main-freeze (fetch first)'); return { branch: BRANCH, pushed: true, doc: { frozen: true } }; },
    });
    expect(r).toMatchObject({ ok: true, pushed: true, attempts: 3 });
    expect(calls).toBe(3);
    expect(waits).toEqual([250, 500]);
    expect(code).toBe(0);
    expect(lines.join('')).toMatch(/attempt 1\/4 failed.*retrying.*published on ops\/red-main-freeze \(frozen=true\) after 3 attempts/s);
  });

  it('CLI hook: onFailedAttempt runs after the FIRST failure, before any wait, and its throw never stops the retries', async () => {
    const order = [];
    let calls = 0;
    const r = await publishFreezeFromCli({
      marker: { reason: 'red' }, env: { WE_RED_MAIN_FREEZE_SHARED_BOARD: '/b' }, stderr: () => {}, setExitCode: () => {},
      sleep: async (ms) => { order.push(`sleep ${ms}`); },
      onFailedAttempt: ({ attempt }) => { order.push(`failed ${attempt}`); if (attempt === 1) throw new Error('disk full'); },
      publish: () => { calls += 1; order.push(`publish ${calls}`); if (calls < 2) throw new Error('rejected'); return { branch: BRANCH, pushed: true, doc: { frozen: true } }; },
    });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(order).toEqual(['publish 1', 'failed 1', 'sleep 250', 'publish 2']);
  });

  it('CLI hook: retries stop at the total deadline (git has no timeout of its own)', async () => {
    let t = 0;
    let calls = 0;
    const lines = [];
    const r = await publishFreezeFromCli({
      marker: { reason: 'red' }, env: { WE_RED_MAIN_FREEZE_SHARED_BOARD: '/b' }, stderr: (s) => lines.push(s), setExitCode: () => {},
      deadlineMs: 1000, nowMs: () => t, sleep: async () => {},
      publish: () => { calls += 1; t += 900; throw new Error('slow reject'); },
    });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ ok: false, attempts: 1 });
    expect(lines.join('')).toMatch(/deadline \(1000ms\) reached/);
  });

  it('CLI hook: passes an absolute deadlineAt to the writer, so each git call can be capped at the time left (shared:130)', async () => {
    const seen = [];
    const before = Date.now();
    await publishFreezeFromCli({
      marker: { reason: 'red' }, env: { WE_RED_MAIN_FREEZE_SHARED_BOARD: '/b' }, stderr: () => {}, setExitCode: () => {}, deadlineMs: 5000,
      publish: (o) => { seen.push(o); return { pushed: true, branch: BRANCH, doc: { frozen: true } }; },
    });
    expect(seen[0].deadlineAt).toBeGreaterThanOrEqual(before + 5000);
    expect(seen[0].deadlineAt).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it('timedGit: each call\'s timeout is min(per-call, time left); past the deadline a call throws without running git; `worktree prune` cleanup is never cut', () => {
    const calls = [];
    const exec = (cmd, args, opts) => { calls.push({ args, timeout: opts.timeout }); return ''; };
    let t = 1000;
    const run = timedGit(15_000, { deadlineAt: 3000, now: () => t, exec });
    run(['fetch', 'origin']);
    expect(calls.at(-1).timeout).toBe(2000);
    t = 3000;
    expect(() => run(['push', 'origin'])).toThrow(/deadline reached before git push/);
    expect(calls).toHaveLength(1);
    run(['worktree', 'prune'], { cwd: '/b' });
    expect(calls.at(-1)).toMatchObject({ args: ['worktree', 'prune'], timeout: 15_000 });
    t = 2500;
    run(['fetch'], { timeout: 99_999 }); // a caller's own timeout never lifts the cap
    expect(calls.at(-1).timeout).toBe(500);
  });

  it('timedGit: no deadline → the plain per-call timeout', () => {
    const calls = [];
    timedGit(7000, { exec: (c, a, o) => { calls.push(o.timeout); return ''; } })(['fetch']);
    expect(calls).toEqual([7000]);
  });

  it('CLI hook: a deterministic refusal from the writer is reported once and never retried', async () => {
    let calls = 0;
    let code = 0;
    const r = await publishFreezeFromCli({
      marker: { reason: 'red' }, env: { WE_RED_MAIN_FREEZE_SHARED_BOARD: '/b' }, stderr: () => {}, setExitCode: (c) => { code = c; }, sleep: async () => {},
      publish: () => { calls += 1; throw Object.assign(new Error('refusing to publish to "main"'), { refusal: true }); },
    });
    expect(calls).toBe(1);
    expect(code).toBe(1);
    expect(r).toMatchObject({ ok: false, refused: 'refusal' });
  });

  it('CLI hook: a refusal (no marker, no clear) is never retried — publish is not called at all', async () => {
    let calls = 0;
    const r = await publishFreezeFromCli({ marker: null, env: { WE_RED_MAIN_FREEZE_SHARED_BOARD: '/b' }, stderr: () => {}, setExitCode: () => {}, sleep: async () => {}, publish: () => { calls += 1; } });
    expect(r).toMatchObject({ ok: false, refused: 'no-marker' });
    expect(calls).toBe(0);
  });

  it('CLI hook: never pushes from inside a test run unless a board is injected', async () => {
    let called = false;
    const r = await publishFreezeFromCli({ marker: null, env: { VITEST: 'true' }, publish: () => { called = true; } });
    expect(r).toEqual({ ok: true, skipped: 'test-run' });
    expect(called).toBe(false);
  });

  it('CLI hook: WE_RED_MAIN_FREEZE_SHARED=off skips the push even with VITEST/WE_UNDER_TEST cleared', async () => {
    let called = false;
    const r = await publishFreezeFromCli({ marker: null, clear: true, env: { WE_RED_MAIN_FREEZE_SHARED: 'off' }, publish: () => { called = true; } });
    expect(r).toEqual({ ok: true, skipped: 'disabled' });
    expect(called).toBe(false);
  });

  it('CLI hook: every SKIP says so on stderr — a real `freeze` run with VITEST/WE_UNDER_TEST or the off switch exported never passes silently (shared:128)', async () => {
    for (const [env, why] of [[{ VITEST: 'true' }, /test run/], [{ WE_UNDER_TEST: '1' }, /test run/], [{ WE_RED_MAIN_FREEZE_SHARED: 'off' }, /WE_RED_MAIN_FREEZE_SHARED=off/]]) {
      const lines = [];
      const r = await publishFreezeFromCli({ marker: { reason: 'operator stop' }, env, stderr: (s) => lines.push(s), publish: () => { throw new Error('must not publish'); } });
      expect(r.ok).toBe(true);
      expect(lines.join('')).toMatch(/shared copy was NOT published/);
      expect(lines.join('')).toMatch(why);
    }
  });

  it('the shared doc never carries the drain host\'s hostname — `publishedBy` is a coarse actor label (shared:62)', () => {
    const doc = buildSharedFreezeDoc({ reason: 'r' }, { now: () => 't' });
    expect(doc.publishedBy).toBe('red-main-remediation');
    expect(JSON.stringify(doc)).not.toContain(hostname());
  });

  it('CLI: `publish` is a known command (republish the local state), skipped under test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rmf-'));
    try {
      const out = execFileSync(process.execPath, [CLI, 'publish'], {
        encoding: 'utf8', env: { ...process.env, WE_UNDER_TEST: '1', WE_RED_MAIN_FREEZE: join(dir, 'm.json') },
      });
      expect(out).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('merge-gate: shared copy clear → red-main gate passes', () => {
    const redMain = readSharedFreeze({ board: '/b', branch: BRANCH, run: reader({ text: JSON.stringify({ frozen: false }) }) });
    expect(redMain).toMatchObject({ source: `${BRANCH}:${SHARED_FREEZE_FILE}`, frozen: false });
    expect(gate(redMain)).toMatchObject({ status: 'pass' });
  });

  it('merge-gate: simulated freeze on the shared copy → red-main gate holds', () => {
    const redMain = readSharedFreeze({ board: '/b', branch: BRANCH, run: reader({ text: JSON.stringify({ frozen: true, reason: 'post-land red' }) }) });
    expect(gate(redMain)).toMatchObject({ status: 'hold' });
    expect(gate(redMain).reason).toMatch(/post-land red/);
  });

  it.each([
    ['branch absent / unreachable', { fetchFails: true }, /branch unreadable/],
    ['file absent on the branch', { text: null }, /not on ops\/red-main-freeze/],
    ['corrupt JSON', { text: '{nope' }, /not JSON/],
    ['no boolean frozen', { text: JSON.stringify({ frozen: 'no' }) }, /no boolean/],
  ])('merge-gate fails CLOSED when the shared copy is unreadable: %s', (_name, stub, msg) => {
    const redMain = readSharedFreeze({ board: '/b', branch: BRANCH, run: reader(stub) });
    expect(redMain.error).toMatch(msg);
    expect(gate(redMain)).toMatchObject({ status: 'fail-closed' });
  });
});

describe('shared red-main freeze: only an explicit clear may publish frozen:false (PR 4715 review)', () => {
  it('hook: no marker and no explicit clear is REFUSED — nothing is published, exit non-zero', async () => {
    let called = false;
    const lines = [];
    let code = 0;
    const r = await publishFreezeFromCli({
      marker: null, env: { WE_RED_MAIN_FREEZE_SHARED_BOARD: '/b' }, stderr: (s) => lines.push(s), setExitCode: (c) => { code = c; },
      publish: () => { called = true; },
    });
    expect(called).toBe(false);
    expect(r).toMatchObject({ ok: false, refused: 'no-marker' });
    expect(code).toBe(1);
    expect(lines.join('')).toMatch(/refus.*no (valid )?local freeze marker/is);
  });

  it('hook: an explicit clear publishes frozen:false', async () => {
    let seen;
    const r = await publishFreezeFromCli({
      marker: null, clear: true, env: { WE_RED_MAIN_FREEZE_SHARED_BOARD: '/b' }, stderr: () => {},
      publish: (o) => { seen = o; return { branch: BRANCH, pushed: true, doc: { frozen: false } }; },
    });
    expect(r).toMatchObject({ ok: true, pushed: true });
    expect(seen).toMatchObject({ marker: null, clear: true });
  });

  it('writer: publishSharedFreeze itself refuses a null marker without an explicit clear', () => {
    const ran = [];
    expect(() => publishSharedFreeze({ marker: null, board: '/b', branch: BRANCH, run: (a) => { ran.push(a); return ''; }, transport: { mkdir: () => {}, write: () => {}, rm: () => {} } }))
      .toThrow(/explicit clear/);
    expect(ran).toEqual([]);
  });

  it('hook: a failed CLEAR points the retry at `unfreeze`, a failed raise at `publish`', async () => {
    const lines = [];
    const boom = () => { throw new Error('push rejected'); };
    const env = { WE_RED_MAIN_FREEZE_SHARED_BOARD: '/b' };
    await publishFreezeFromCli({ marker: null, clear: true, env, stderr: (s) => lines.push(s), setExitCode: () => {}, publish: boom, sleep: async () => {} });
    expect(lines.join('')).toMatch(/red-main-remediation\.mjs unfreeze/);
    lines.length = 0;
    await publishFreezeFromCli({ marker: { reason: 'r' }, env, stderr: (s) => lines.push(s), setExitCode: () => {}, publish: boom, sleep: async () => {} });
    expect(lines.join('')).toMatch(/red-main-remediation\.mjs publish/);
  });
});

/** A real temp git board with a bare `origin`, so the CLI's publish path runs end to end (nothing stubbed). */
function cliFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rmf-cli-'));
  const remote = join(root, 'remote.git');
  const board = join(root, 'board');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(root, 'init', '--bare', '-q', '-b', 'main', remote);
  g(root, 'init', '-q', '-b', 'main', board);
  g(board, 'config', 'user.email', 't@example.com');
  g(board, 'config', 'user.name', 't');
  g(board, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(board, 'README'), 'x');
  g(board, 'add', 'README');
  g(board, 'commit', '-qm', 'init');
  g(board, 'remote', 'add', 'origin', remote);
  g(board, 'push', '-q', 'origin', 'main');
  const marker = join(root, 'marker.json');
  /** The shared doc as CI would read it (null ⇒ the branch/file does not exist). */
  const shared = () => {
    try { return JSON.parse(g(root, '--git-dir', remote, 'show', `${BRANCH}:${SHARED_FREEZE_FILE}`)); } catch { return null; }
  };
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WE_UNDER_TEST: '1', WE_RED_MAIN_FREEZE: marker, WE_RED_MAIN_FREEZE_LEGACY: join(root, 'legacy.json'), WE_RED_MAIN_FREEZE_SHARED_BOARD: board, ...env },
  });
  const breakOrigin = () => g(board, 'remote', 'set-url', 'origin', join(root, 'nope.git'));
  const fixOrigin = () => g(board, 'remote', 'set-url', 'origin', remote);
  /** The origin REJECTS its next `n` pushes (a pre-receive hook with a counter), then accepts again. */
  const rejectNextPushes = (n) => {
    const left = join(root, 'rejects-left');
    writeFileSync(left, String(n));
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(hook, `#!/bin/sh\nn=$(cat '${left}')\nif [ "$n" -gt 0 ]; then echo $((n - 1)) > '${left}'; echo 'rejected by test hook' >&2; exit 1; fi\nexit 0\n`);
    chmodSync(hook, 0o755);
    return () => Number(readFileSync(left, 'utf8'));
  };
  /** A pre-receive hook that records, at each push, whether the local marker file already exists (then accepts). */
  const recordMarkerAtPush = () => {
    const log = join(root, 'marker-at-push');
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(hook, `#!/bin/sh\nif [ -f '${marker}' ]; then echo present >> '${log}'; else echo missing >> '${log}'; fi\nexit 0\n`);
    chmodSync(hook, 0o755);
    return () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  };
  return { root, board, marker, shared, run, breakOrigin, fixOrigin, rejectNextPushes, recordMarkerAtPush, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('red-main-remediation CLI → shared copy, end to end (PR 4715 review)', { timeout: 60_000 }, () => {
  let fx;
  beforeEach(() => { fx = cliFixture(); });
  afterEach(() => fx.cleanup());

  it('`publish` with NO local marker refuses and pushes nothing (it must never mint frozen:false)', () => {
    const r = fx.run(['publish']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refus/i);
    expect(fx.shared()).toBeNull();
  });

  it('`publish` with a CORRUPT local marker refuses and does not clear a standing shared freeze', () => {
    expect(fx.run(['freeze', '--reason=red']).status).toBe(0);
    expect(fx.shared()).toMatchObject({ frozen: true });
    writeFileSync(fx.marker, '{not json');
    const r = fx.run(['publish']);
    expect(r.status).not.toBe(0);
    expect(fx.shared()).toMatchObject({ frozen: true, reason: 'red' });
  });

  it('`freeze` publishes frozen:true and keeps the local marker', () => {
    const r = fx.run(['freeze', '--reason=post-land red', '--merge-sha=abc']);
    expect(r.status).toBe(0);
    expect(fx.shared()).toMatchObject({ frozen: true, reason: 'post-land red', mergeSha: 'abc' });
    expect(JSON.parse(readFileSync(fx.marker, 'utf8'))).toMatchObject({ frozen: true, reason: 'post-land red' });
  });

  it('`unfreeze` is the explicit clear: publishes frozen:false and removes the local marker', () => {
    fx.run(['freeze', '--reason=red']);
    const r = fx.run(['unfreeze']);
    expect(r.status).toBe(0);
    expect(fx.shared()).toMatchObject({ frozen: false });
    expect(existsSync(fx.marker)).toBe(false);
  });

  it('a failed publish on `freeze` keeps the local marker, exits 1, and `publish` then retries it', () => {
    fx.breakOrigin();
    const r = fx.run(['freeze', '--reason=red']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/NOT published.*red-main-remediation\.mjs publish/s);
    expect(JSON.parse(readFileSync(fx.marker, 'utf8'))).toMatchObject({ frozen: true, reason: 'red' });
    fx.fixOrigin();
    expect(fx.run(['publish']).status).toBe(0);
    expect(fx.shared()).toMatchObject({ frozen: true, reason: 'red' });
  });

  it('a REJECTED freeze push over a standing shared CLEAR is retried until it lands — CI holds, never passes on the stale clear', () => {
    fx.run(['freeze', '--reason=old']);
    expect(fx.run(['unfreeze']).status).toBe(0);
    expect(gate(readSharedFreeze({ board: fx.board, branch: BRANCH }))).toMatchObject({ status: 'pass' });
    const rejectsLeft = fx.rejectNextPushes(2);
    const r = fx.run(['freeze', '--reason=red']);
    expect(rejectsLeft()).toBe(0); // both rejections really happened
    expect(r.status).toBe(0);
    expect(fx.shared()).toMatchObject({ frozen: true, reason: 'red' });
    expect(gate(readSharedFreeze({ board: fx.board, branch: BRANCH }))).toMatchObject({ status: 'hold' });
  });

  it('a rejected CLEAR push is NOT retried: exit 1, CI stays frozen (fail closed) until `unfreeze` is re-run', () => {
    fx.run(['freeze', '--reason=red']);
    const rejectsLeft = fx.rejectNextPushes(2);
    const r = fx.run(['unfreeze']);
    expect(r.status).toBe(1);
    expect(rejectsLeft()).toBe(1); // exactly one attempt
    expect(gate(readSharedFreeze({ board: fx.board, branch: BRANCH }))).toMatchObject({ status: 'hold' });
  });

  it('`unfreeze` never wipes a DIFFERENT freeze another writer pushed after this host froze — CI keeps holding', () => {
    expect(fx.run(['freeze', '--reason=mine']).status).toBe(0);
    // Another writer (its own marker) raises after us: the shared tip now carries ITS freeze, not ours.
    expect(fx.run(['freeze', '--reason=theirs'], { WE_RED_MAIN_FREEZE: join(fx.root, 'other-marker.json') }).status).toBe(0);
    const r = fx.run(['unfreeze']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refusing to clear .*DIFFERENT freeze.*theirs/);
    expect(fx.shared()).toMatchObject({ frozen: true, reason: 'theirs' });
    expect(gate(readSharedFreeze({ board: fx.board, branch: BRANCH }))).toMatchObject({ status: 'hold' });
    // An explicit second unfreeze (no local marker left to compare) is the operator's deliberate clear.
    expect(fx.run(['unfreeze']).status).toBe(0);
    expect(fx.shared()).toMatchObject({ frozen: false });
  });

  it('a failed publish on `unfreeze` retries with `unfreeze` (publish would refuse: no marker) and leaves the shared freeze standing', () => {
    fx.run(['freeze', '--reason=red']);
    fx.breakOrigin();
    const r = fx.run(['unfreeze']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/red-main-remediation\.mjs unfreeze/);
    expect(existsSync(fx.marker)).toBe(false);
    fx.fixOrigin();
    expect(fx.shared()).toMatchObject({ frozen: true });
    expect(fx.run(['unfreeze']).status).toBe(0);
    expect(fx.shared()).toMatchObject({ frozen: false });
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('`unfreeze` refuses to publish a clear while the local marker could not be removed', () => {
    const dir = join(fx.root, 'locked');
    mkdirSync(dir);
    const marker = join(dir, 'm.json');
    expect(fx.run(['freeze', '--reason=red'], { WE_RED_MAIN_FREEZE: marker }).status).toBe(0);
    chmodSync(dir, 0o555); // rm of the marker now fails (and unfreezeDispatch swallows that)
    try {
      const r = fx.run(['unfreeze'], { WE_RED_MAIN_FREEZE: marker });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/did not clear the local marker/);
      expect(fx.shared()).toMatchObject({ frozen: true, reason: 'red' });
    } finally { chmodSync(dir, 0o755); }
  });

  it('`freeze` writes the LOCAL marker before the first push even starts (a hung publish can never delay the drain stop)', () => {
    const atPush = fx.recordMarkerAtPush();
    expect(fx.run(['freeze', '--reason=red']).status).toBe(0);
    expect(atPush()).toEqual(['present']);
    expect(fx.shared()).toMatchObject({ frozen: true, reason: 'red' });
  });

  it('a hung git call is cut off by the publish timeout: the CLI exits 1 with the local marker already written', () => {
    const hook = join(fx.root, 'remote.git', 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nsleep 30\nexit 0\n');
    chmodSync(hook, 0o755);
    const t0 = Date.now();
    const r = fx.run(['freeze', '--reason=red'], { WE_RED_MAIN_FREEZE_SHARED_GIT_TIMEOUT_MS: '1500', WE_RED_MAIN_FREEZE_SHARED_DEADLINE_MS: '2000' });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/NOT published/);
    expect(JSON.parse(readFileSync(fx.marker, 'utf8'))).toMatchObject({ frozen: true, reason: 'red' });
  });

  it('the publish DEADLINE caps a hung FIRST git call too — the per-call timeout never outlives the deadline (PR 4715 ruling, shared:130)', () => {
    const hook = join(fx.root, 'remote.git', 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nsleep 30\nexit 0\n');
    chmodSync(hook, 0o755);
    const t0 = Date.now();
    // Per-call timeout far ABOVE the deadline: before the fix the first push ran the full 15s, the deadline only being checked between attempts.
    const r = fx.run(['freeze', '--reason=red'], { WE_RED_MAIN_FREEZE_SHARED_GIT_TIMEOUT_MS: '15000', WE_RED_MAIN_FREEZE_SHARED_DEADLINE_MS: '1000' });
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/NOT published/);
    expect(JSON.parse(readFileSync(fx.marker, 'utf8'))).toMatchObject({ frozen: true, reason: 'red' });
  });

  it('every freeze push rejected over a standing shared CLEAR still cannot hide a red main: the gate reads main CI and HOLDS (shared:95, shared:151, remediation:322)', () => {
    expect(fx.run(['freeze', '--reason=old']).status).toBe(0);
    expect(fx.run(['unfreeze']).status).toBe(0);
    expect(fx.shared()).toMatchObject({ frozen: false });
    fx.rejectNextPushes(100);
    const r = fx.run(['freeze', '--reason=red'], { WE_RED_MAIN_FREEZE_SHARED_DEADLINE_MS: '5000' });
    expect(r.status).toBe(1);
    expect(fx.shared()).toMatchObject({ frozen: false }); // exhausted: the stale clear stands on the shared branch
    expect(JSON.parse(readFileSync(fx.marker, 'utf8'))).toMatchObject({ frozen: true }); // the drain (sole merger) is stopped
    const freeze = readSharedFreeze({ board: fx.board, branch: BRANCH });
    expect(freeze).toMatchObject({ frozen: false });
    const redRuns = [
      { databaseId: 1, status: 'completed', conclusion: 'success', createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z', headSha: 'a'.repeat(40) },
      { databaseId: 2, status: 'completed', conclusion: 'failure', createdAt: '2026-10-11T01:00:00Z', updatedAt: '2026-10-11T01:00:00Z', headSha: 'b'.repeat(40) },
    ];
    const mainCi = readMainCiFact({ repo: 'o/r', defaultBranch: 'main', exec: () => JSON.stringify(redRuns) });
    expect(combineRedMain(freeze, mainCi, PR)).toMatchObject({ frozen: true, reason: expect.stringMatching(/main CI red/) });
    expect(gate(combineRedMain(freeze, mainCi, PR))).toMatchObject({ status: 'hold' });
  });

  it('a local write failure still publishes the shared freeze (it can never leave the shared copy clear)', () => {
    const blocker = join(fx.root, 'blocker');
    writeFileSync(blocker, 'a file where a directory is needed');
    const r = fx.run(['freeze', '--reason=red'], { WE_RED_MAIN_FREEZE: join(blocker, 'sub', 'marker.json') });
    expect(r.status).not.toBe(0); // the local write cannot succeed
    expect(fx.shared()).toMatchObject({ frozen: true, reason: 'red' });
  });

  it('`decide --apply` (an AUTOMATIC red-main freeze) stops the drain locally but publishes NOTHING — the shared copy is for manual freezes only; main CI is the authority', () => {
    expect(fx.run(['freeze', '--reason=old']).status).toBe(0);
    expect(fx.run(['unfreeze']).status).toBe(0);
    const r = fx.run(['decide', '--trigger=push', '--ref=main', '--result=red', '--merge-sha=abc', '--apply']);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(fx.marker, 'utf8'))).toMatchObject({ frozen: true, kind: 'auto', mergeSha: 'abc' });
    expect(fx.shared()).toMatchObject({ frozen: false });
    // so a trusted main-fix PR keeps its exemption while main CI is red (it is not mistaken for a manual stop)
    const freeze = readSharedFreeze({ board: fx.board, branch: BRANCH });
    const red = { source: 'ci.yml@main', red: true, firstRedSha: 'b'.repeat(40), redShas: ['b'.repeat(40)] };
    const fixPr = { ...PR, headRefName: 'lane/main-fix-bbbbbbbbb', isCrossRepository: false, author: { login: 'app/web-everything' } };
    expect(gate(combineRedMain(freeze, red, fixPr))).toMatchObject({ status: 'pass' });
    expect(gate(combineRedMain(freeze, red, { ...PR, headRefName: 'lane/x' }))).toMatchObject({ status: 'hold' });
  });

  it('`decide --apply` never DOWNGRADES a standing manual freeze whose publish failed — `publish` still lands it as manual', () => {
    fx.breakOrigin();
    expect(fx.run(['freeze', '--reason=operator stop'], { WE_RED_MAIN_FREEZE_SHARED_DEADLINE_MS: '1' }).status).toBe(1);
    fx.fixOrigin();
    const d = fx.run(['decide', '--trigger=push', '--ref=main', '--result=red', '--merge-sha=abc', '--apply']);
    expect(d.status).toBe(0);
    expect(d.stderr).toMatch(/MANUAL freeze is already standing.*kept/);
    expect(JSON.parse(readFileSync(fx.marker, 'utf8'))).toMatchObject({ kind: 'manual', reason: 'operator stop' });
    expect(fx.run(['publish']).status).toBe(0);
    expect(fx.shared()).toMatchObject({ frozen: true, kind: 'manual', reason: 'operator stop' });
  });

  it('`publish` refuses to republish an AUTOMATIC local freeze (it would become a manual stop that blocks the main-fix PR)', () => {
    fx.run(['decide', '--trigger=push', '--ref=main', '--result=red', '--apply']);
    const r = fx.run(['publish']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/automatic.*not published/i);
    expect(fx.shared()).toBeNull();
  });

  describe('a LEGACY kind-less local marker (written before `kind` existed) — remediation:372', () => {
    const legacy = (reason) => writeFileSync(fx.marker, `${JSON.stringify({ frozen: true, at: '2026-10-01T00:00:00Z', reason, redRef: 'main', mergeSha: 'abc', revertAuthority: true })}\n`);

    it('the old `decide --apply` marker (reason "decide --apply") counts as AUTOMATIC: `publish` refuses it, nothing is published', () => {
      legacy('decide --apply');
      const r = fx.run(['publish']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/automatic.*not published/i);
      expect(fx.shared()).toBeNull();
    });

    it('the old `decide --apply` marker is not mistaken for a standing MANUAL freeze: `decide --apply` re-stamps it as auto', () => {
      legacy('decide --apply');
      const d = fx.run(['decide', '--trigger=push', '--ref=main', '--result=red', '--merge-sha=def', '--apply']);
      expect(d.status).toBe(0);
      expect(d.stderr).not.toMatch(/MANUAL freeze is already standing/);
      expect(JSON.parse(readFileSync(fx.marker, 'utf8'))).toMatchObject({ frozen: true, kind: 'auto', mergeSha: 'def' });
    });

    it('any OTHER kind-less marker (the old operator `freeze`) stays MANUAL — fail closed: `publish` lands it as a manual stop', () => {
      legacy('operator stop');
      expect(fx.run(['publish']).status).toBe(0);
      expect(fx.shared()).toMatchObject({ frozen: true, kind: 'manual', reason: 'operator stop' });
    });
  });

  it('`freeze` (the operator\'s stop-the-line) publishes a MANUAL freeze', () => {
    expect(fx.run(['freeze', '--reason=hold everything']).status).toBe(0);
    expect(fx.shared()).toMatchObject({ frozen: true, kind: 'manual', reason: 'hold everything' });
  });

  it('`decide --apply` on a PROCEED result changes nothing and publishes nothing (it must not clear the shared freeze)', () => {
    fx.run(['freeze', '--reason=red']);
    rmSync(fx.marker); // a clone with no marker
    const r = fx.run(['decide', '--trigger=push', '--ref=main', '--result=green', '--apply']);
    expect(r.status).toBe(0);
    expect(fx.shared()).toMatchObject({ frozen: true, reason: 'red' });
  });
});

describe('merge-gate reads main\'s OWN CI status from GitHub (operator ruling 2026-10-11, PR 4715)', () => {
  const RED_SHA = 'b'.repeat(40);
  const run = (conclusion, createdAt, headSha = RED_SHA, status = 'completed') => ({ databaseId: Date.parse(createdAt), status, conclusion, createdAt, updatedAt: createdAt, headSha });
  const RED_RUNS = [run('success', '2026-10-11T00:00:00Z', 'a'.repeat(40)), run('failure', '2026-10-11T01:00:00Z')];
  const GREEN_RUNS = [run('failure', '2026-10-11T00:00:00Z'), run('success', '2026-10-11T01:00:00Z', 'c'.repeat(40))];
  const CLEAR = { source: `${BRANCH}:${SHARED_FREEZE_FILE}`, frozen: false, reason: null, publishedAt: 't0' };
  const MANUAL = { source: `${BRANCH}:${SHARED_FREEZE_FILE}`, frozen: true, reason: 'operator stop', publishedAt: 't1' };
  const ghRuns = (runs) => (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'run' && args[1] === 'list') { if (runs instanceof Error) throw runs; return JSON.stringify(runs); }
    throw new Error(`stub: ${cmd} ${args.join(' ')}`);
  };
  const prExec = (pr) => (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') return JSON.stringify(pr);
    throw new Error(`stub: ${cmd} ${args.join(' ')}`);
  };
  const row = ({ freeze = CLEAR, runs = GREEN_RUNS, pr = { ...PR, headRefName: 'lane/x' } } = {}) => {
    const mainCi = readMainCiFact({ repo: 'o/r', defaultBranch: 'main', exec: ghRuns(runs) });
    const f = gatherPrFacts({ repo: 'o/r', num: 1, cwd: '/nowhere', defaultBranch: 'main', ledgerConfig: { authority: 'labels' }, exec: prExec(pr), redMain: freeze, mainCi });
    return evaluatePrGates(f).results.find((r) => r.id === 'red-main-freeze');
  };
  const TRUSTED = { login: 'app/web-everything' };
  const FIX_PR = { ...PR, headRefName: 'lane/main-fix-bbbbbbbbb', isCrossRepository: false, author: TRUSTED };

  it('shared copy CLEAR but main\'s own CI is RED → HOLD (a failing freeze publisher can never hide a red main)', () => {
    expect(row({ runs: RED_RUNS })).toMatchObject({ status: 'hold' });
    expect(row({ runs: RED_RUNS }).reason).toMatch(/main CI red since bbbbbbbbb/);
  });

  it('shared clear and main CI green → pass', () => {
    expect(row()).toMatchObject({ status: 'pass' });
  });

  it.each([
    ['the runs read fails', Object.assign(new Error('HTTP 403'), { stderr: 'HTTP 403: Resource not accessible by integration' }), /main CI unreadable.*403/],
    ['no finished run in the window', [run('', '2026-10-11T01:00:00Z', RED_SHA, 'in_progress')], /main CI status unknown \(no-finished-run\)/],
    ['the reply is not a list', { nope: true }, /main CI status unknown \(runs-unreadable\)/],
  ])('main CI status unreadable (%s) → FAIL CLOSED', (_n, runs, msg) => {
    const r = row({ runs });
    expect(r).toMatchObject({ status: 'fail-closed' });
    expect(r.reason).toMatch(msg);
  });

  it('a hostile freeze reason (newline + workflow command, huge) is flattened and capped before it reaches the log', () => {
    const LS = String.fromCharCode(0x2028);
    const redMain = readSharedFreeze({ board: '/b', branch: BRANCH, run: reader({ text: JSON.stringify({ frozen: true, reason: `x\n::add-mask::secret\r${LS}::error::y${'z'.repeat(5000)}` }) }) });
    expect(/[\n\r]/.test(redMain.reason) || redMain.reason.includes(LS)).toBe(false);
    expect(redMain.reason.length).toBeLessThanOrEqual(200);
    expect(row({ freeze: redMain }).reason).not.toMatch(/\n::/);
  });

  it('main CI not read at all → FAIL CLOSED (never treated as green)', () => {
    const f = gatherPrFacts({ repo: 'o/r', num: 1, cwd: '/nowhere', defaultBranch: 'main', ledgerConfig: { authority: 'labels' }, exec: prExec(PR), redMain: CLEAR });
    expect(evaluatePrGates(f).results.find((r) => r.id === 'red-main-freeze')).toMatchObject({ status: 'fail-closed' });
  });

  it('a MANUAL freeze on the shared copy still holds while main CI is green', () => {
    expect(row({ freeze: MANUAL })).toMatchObject({ status: 'hold' });
    expect(row({ freeze: MANUAL }).reason).toMatch(/manual freeze: operator stop/);
  });

  it('the trusted main-fix PR (lane/main-fix-*, same repo) passes while main CI is red — the drain\'s "only the main-fix PR lands"', () => {
    expect(isTrustedPrAuthor({ author: TRUSTED })).toBe(true);
    expect(row({ runs: RED_RUNS, pr: FIX_PR })).toMatchObject({ status: 'pass' });
  });

  it.each([
    ['an untrusted author', { ...FIX_PR, author: { login: 'someone-else' } }],
    ['no author', { ...FIX_PR, author: undefined }],
    ['a fork (cross-repository)', { ...FIX_PR, isCrossRepository: true }],
    ['another branch prefix', { ...FIX_PR, headRefName: 'lane/x-main-fix-b' }],
  ])('the main-fix exemption is refused for %s → HOLD', (_n, pr) => {
    expect(row({ runs: RED_RUNS, pr })).toMatchObject({ status: 'hold' });
  });

  it('a newer GREEN run from a fork PR whose branch is also named `main` (event pull_request) cannot hide a red main', () => {
    const forkGreen = { ...run('success', '2026-10-11T02:00:00Z', 'f'.repeat(40)), event: 'pull_request' };
    expect(row({ runs: [...RED_RUNS.map((r) => ({ ...r, event: 'push' })), forkGreen] })).toMatchObject({ status: 'hold' });
  });

  it('a RE-RUN of main\'s red run (back in progress, attempt 2) does not let the older green run speak → FAIL CLOSED', () => {
    const rerun = { ...run('', '2026-10-11T01:00:00Z', RED_SHA, 'in_progress'), attempt: 2 };
    const r = row({ runs: [run('success', '2026-10-11T00:00:00Z', 'a'.repeat(40)), rerun] });
    expect(r).toMatchObject({ status: 'fail-closed' });
    expect(r.reason).toMatch(/being re-run \(attempt 2\)/);
  });

  it('a STALE main-fix branch (its sha is not in the current red window) is not exempt → HOLD', () => {
    expect(row({ runs: RED_RUNS, pr: { ...FIX_PR, headRefName: 'lane/main-fix-ddddddddd' } })).toMatchObject({ status: 'hold' });
    expect(isMainFixPr(FIX_PR, [RED_SHA])).toBe(true);
    expect(isMainFixPr(FIX_PR, [])).toBe(false);
    expect(isMainFixPr({ ...FIX_PR, headRefName: 'lane/main-fix-bbbb' }, [RED_SHA])).toBe(false);
  });

  it('a shared doc with NO kind (or junk) reads as MANUAL — fail closed; only an explicit "auto" is automatic', () => {
    for (const kind of [undefined, 'MANUAL', 'nope', 1]) {
      expect(readSharedFreeze({ board: '/b', branch: BRANCH, run: reader({ text: JSON.stringify({ frozen: true, reason: 'r', kind }) }) }).kind).toBe('manual');
    }
    expect(readSharedFreeze({ board: '/b', branch: BRANCH, run: reader({ text: JSON.stringify({ frozen: true, reason: 'r', kind: 'auto' }) }) }).kind).toBe('auto');
  });

  it('an AUTOMATIC shared freeze holds normal PRs but lets the current main-fix PR through (it is not a manual stop)', () => {
    const auto = { ...MANUAL, kind: 'auto', reason: 'decide --apply' };
    expect(row({ freeze: auto, runs: RED_RUNS, pr: FIX_PR })).toMatchObject({ status: 'pass' });
    expect(row({ freeze: auto, runs: RED_RUNS })).toMatchObject({ status: 'hold' });
    expect(row({ freeze: auto }).reason).toMatch(/automatic red-main freeze: decide --apply/);
  });

  it('the writer refuses to publish an automatic marker at all', () => {
    expect(() => publishSharedFreeze({ marker: { reason: 'r', kind: 'auto' }, board: '/b', branch: BRANCH, run: () => '' })).toThrow(/automatic freeze/);
  });

  it('a MANUAL freeze holds even the main-fix PR', () => {
    expect(row({ freeze: MANUAL, runs: RED_RUNS, pr: FIX_PR })).toMatchObject({ status: 'hold' });
  });

  it('readMainCiFact reads main\'s CI WORKFLOW by name, bounded (timeout + maxBuffer)', () => {
    let seen;
    readMainCiFact({ repo: 'o/r', defaultBranch: 'trunk', exec: (cmd, args, opts) => { seen = { cmd, args, opts }; return '[]'; } });
    expect(seen.cmd).toBe('gh');
    expect(seen.args).toEqual(expect.arrayContaining(['run', 'list', '--repo', 'o/r', '--workflow', 'ci.yml', '--branch', 'trunk', '--event', 'push']));
    expect(seen.args[seen.args.indexOf('--json') + 1]).toMatch(/\bevent\b.*\battempt\b/);
    expect(seen.opts).toMatchObject({ timeout: expect.any(Number), maxBuffer: expect.any(Number) });
  });

  describe('main CI is RE-READ right before the verdict too', () => {
    const PASS = { ok: true, reason: 'all pass' };
    const green = { source: 'ci', red: false };
    it('main went red during the run → HOLD', () => {
      const v = applyFreezeRecheck(PASS, CLEAR, CLEAR, { mainCi: green, mainCiRecheck: { source: 'ci', red: true, firstRedSha: RED_SHA } });
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(/main CI went RED during this run/);
    });
    it('main CI unreadable at verdict time → HOLD', () => {
      expect(applyFreezeRecheck(PASS, CLEAR, CLEAR, { mainCi: green, mainCiRecheck: { source: 'ci', error: 'HTTP 502' } }).reason).toMatch(/main CI unreadable at verdict time: HTTP 502/);
    });
    it('a run made only of main-fix PRs keeps its PASS while main is red', () => {
      expect(applyFreezeRecheck(PASS, CLEAR, CLEAR, { mainCi: { source: 'ci', red: true }, mainCiRecheck: { source: 'ci', red: true }, exempt: true })).toEqual(PASS);
    });
    it('the verdict-time re-read honours the same auto/manual rule: an AUTOMATIC freeze spares an all-main-fix run, a MANUAL one never', () => {
      const red = { source: 'ci', red: true, redShas: ['b'.repeat(40)] };
      const auto = { ...CLEAR, frozen: true, kind: 'auto', reason: 'decide --apply' };
      const manual = { ...CLEAR, frozen: true, kind: 'manual', reason: 'operator stop' };
      expect(applyFreezeRecheck(PASS, auto, auto, { mainCi: red, mainCiRecheck: red, exempt: true })).toEqual(PASS);
      expect(applyFreezeRecheck(PASS, auto, auto, { mainCi: red, mainCiRecheck: red, exempt: false }).ok).toBe(false);
      expect(applyFreezeRecheck(PASS, manual, manual, { mainCi: red, mainCiRecheck: red, exempt: true }).ok).toBe(false);
    });
    it('main still green → PASS stands', () => {
      expect(applyFreezeRecheck(PASS, CLEAR, CLEAR, { mainCi: green, mainCiRecheck: green })).toEqual(PASS);
    });
  });
});

describe('merge-gate-check threads the shared freeze into the gate facts (PR 4715 review)', () => {
  const stubExec = (prJson) => (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && /^number,title/.test(args[args.indexOf('--json') + 1] || '')) return JSON.stringify(prJson);
    throw new Error(`stub: ${cmd} ${args.join(' ')}`);
  };
  const facts = (redMain) => gatherPrFacts({ repo: 'o/r', num: 1, cwd: '/nowhere', defaultBranch: 'main', ledgerConfig: { authority: 'labels' }, exec: stubExec({ ...PR, headRefName: 'lane/x' }), ...(redMain === undefined ? {} : { redMain }) });

  it('a supplied shared freeze lands in facts.redMain combined with main CI (a frozen copy holds as a MANUAL freeze)', () => {
    const redMain = { source: `${BRANCH}:${SHARED_FREEZE_FILE}`, frozen: true, reason: 'post-land red' };
    const f = gatherPrFacts({ repo: 'o/r', num: 1, cwd: '/nowhere', defaultBranch: 'main', ledgerConfig: { authority: 'labels' }, exec: stubExec({ ...PR, headRefName: 'lane/x' }), redMain, mainCi: { source: 'ci.yml@main', red: false } });
    expect(f.redMain).toMatchObject({ frozen: true, reason: 'manual freeze: post-land red' });
    expect(f.redMain.source).toContain(`${BRANCH}:${SHARED_FREEZE_FILE}`);
  });

  it('no redMain supplied → {source:null}, which the gate fails closed on', () => {
    const f = facts();
    expect(f.redMain).toEqual({ source: null });
    expect(evaluatePrGates({ ...f, redMain: f.redMain }).results.find((r) => r.id === 'red-main-freeze')).toMatchObject({ status: 'fail-closed' });
  });

  it('readRedMainFact reads the SAME branch the writer publishes to (the policy knob), from the run checkout', () => {
    let seen;
    const out = readRedMainFact({ cwd: '/checkout', policy: { redMainFreezeBranch: 'ops/other-freeze' }, read: (o) => { seen = o; return { source: 'x', frozen: false }; } });
    expect(seen).toEqual({ board: '/checkout', branch: 'ops/other-freeze' });
    expect(out).toEqual({ source: 'x', frozen: false });
  });

  it('the default policy and the writer resolve to one branch', () => {
    const policy = loadMergeDeliveryPolicy({ toolSettings: {} });
    expect(policy.redMainFreezeBranch).toBe(resolveFreezeBranch({ toolSettings: {} }));
  });

  describe('the freeze is RE-READ right before the verdict (slow fact-gathering cannot pass on a stale clear)', () => {
    const PASS = { ok: true, reason: 'all pass' };
    const clearAt = (publishedAt) => ({ source: 's', frozen: false, reason: null, publishedAt });
    it('unchanged clear → the PASS stands', () => {
      expect(applyFreezeRecheck(PASS, clearAt('t0'), clearAt('t0'))).toEqual(PASS);
    });
    it.each([
      ['frozen meanwhile', { source: 's', frozen: true, reason: 'post-land red', publishedAt: 't1' }, /went RED during this run.*post-land red/],
      ['unreadable at verdict time', { source: 's', error: 'branch unreadable: timeout' }, /unreadable at verdict time.*timeout/],
      ['re-published (frozen then cleared) meanwhile', clearAt('t2'), /changed during this run/],
      ['not read', null, /unreadable at verdict time: not read/],
    ])('%s → HOLD (fail closed)', (_n, recheck, msg) => {
      const v = applyFreezeRecheck(PASS, clearAt('t0'), recheck);
      expect(v.ok).toBe(false);
      expect(v.reason).toMatch(msg);
    });
    it('a verdict already held is left as it is', () => {
      const held = { ok: false, reason: 'held' };
      expect(applyFreezeRecheck(held, clearAt('t0'), { source: 's', frozen: true, reason: 'x' })).toBe(held);
    });
    it('main() re-reads the freeze after gathering facts and feeds it to applyFreezeRecheck', () => {
      const src = readFileSync(resolve(HERE, '..', '..', 'merge-gate-check.mjs'), 'utf8');
      const main = src.slice(src.indexOf('async function main()'));
      expect(main.indexOf('applyFreezeRecheck(preRecheck, redMain, readRedMainFact(')).toBeGreaterThan(main.indexOf('gatherPrFacts('));
      expect(main).toMatch(/const verdict = preRecheck\.ok\s*\?\s*applyFreezeRecheck\(/);
    });
    it('main() reads main CI once before the facts, passes it to every gatherPrFacts, and re-reads it for the verdict', () => {
      const src = readFileSync(resolve(HERE, '..', '..', 'merge-gate-check.mjs'), 'utf8');
      const main = src.slice(src.indexOf('async function main()'));
      const firstRead = main.indexOf('const mainCi = readMainCiFact(');
      expect(firstRead).toBeGreaterThan(-1);
      expect(firstRead).toBeLessThan(main.indexOf('gatherPrFacts('));
      expect(main).toMatch(/gatherPrFacts\(\{[^}]*\bredMain, mainCi\b/);
      expect(main).toMatch(/const mainCiRecheck = preRecheck\.ok \? readMainCiFact\(/);
      expect(main).toMatch(/mainCi, mainCiRecheck, exempt: factsOf\.length > 0 && factsOf\.every\(\(x\) => isMainFixPr\(x\.pr, mainCiRecheck\?\.redShas \|\| \[\]\)\)/);
    });
  });
});
