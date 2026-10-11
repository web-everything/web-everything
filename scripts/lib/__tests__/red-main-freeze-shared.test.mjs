// @vitest-environment node
/**
 * @file red-main-freeze-shared.test.mjs — card xyd06qo: the red-main freeze is published to a shared ops/* branch
 *   by the same CLI that raises/clears it locally, and the merge-gate reads that branch: pass while clear, hold while
 *   frozen, FAIL CLOSED whenever the shared copy is missing or unreadable. Every git/fs call is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLISH_ATTEMPTS, SHARED_FREEZE_FILE, buildSharedFreezeDoc, publishSharedFreeze, publishFreezeFromCli, readSharedFreeze, resolveFreezeBranch,
} from '../red-main-freeze-shared.mjs';
import { evaluatePrGates } from '../merge-gate-ci.mjs';
import { loadMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';
import { gatherPrFacts, readRedMainFact } from '../../merge-gate-check.mjs';

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
  return { root, board, marker, shared, run, breakOrigin, fixOrigin, rejectNextPushes, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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

  it('`freeze` publishes BEFORE it writes the local marker (a local write failure cannot leave the shared copy clear)', () => {
    const blocker = join(fx.root, 'blocker');
    writeFileSync(blocker, 'a file where a directory is needed');
    const r = fx.run(['freeze', '--reason=red'], { WE_RED_MAIN_FREEZE: join(blocker, 'sub', 'marker.json') });
    expect(r.status).not.toBe(0); // the local write cannot succeed
    expect(fx.shared()).toMatchObject({ frozen: true, reason: 'red' });
  });

  it('`decide --apply` on a stop-the-line result freezes and publishes frozen:true', () => {
    const r = fx.run(['decide', '--trigger=push', '--ref=main', '--result=red', '--merge-sha=abc', '--apply']);
    expect(r.status).toBe(0);
    expect(fx.shared()).toMatchObject({ frozen: true, mergeSha: 'abc' });
    expect(existsSync(fx.marker)).toBe(true);
  });

  it('`decide --apply` on a PROCEED result changes nothing and publishes nothing (it must not clear the shared freeze)', () => {
    fx.run(['freeze', '--reason=red']);
    rmSync(fx.marker); // a clone with no marker
    const r = fx.run(['decide', '--trigger=push', '--ref=main', '--result=green', '--apply']);
    expect(r.status).toBe(0);
    expect(fx.shared()).toMatchObject({ frozen: true, reason: 'red' });
  });
});

describe('merge-gate-check threads the shared freeze into the gate facts (PR 4715 review)', () => {
  const stubExec = (prJson) => (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view' && /^number,title/.test(args[args.indexOf('--json') + 1] || '')) return JSON.stringify(prJson);
    throw new Error(`stub: ${cmd} ${args.join(' ')}`);
  };
  const facts = (redMain) => gatherPrFacts({ repo: 'o/r', num: 1, cwd: '/nowhere', defaultBranch: 'main', ledgerConfig: { authority: 'labels' }, exec: stubExec({ ...PR, headRefName: 'lane/x' }), ...(redMain === undefined ? {} : { redMain }) });

  it('a supplied redMain lands in facts.redMain unchanged', () => {
    const redMain = { source: `${BRANCH}:${SHARED_FREEZE_FILE}`, frozen: true, reason: 'post-land red' };
    expect(facts(redMain).redMain).toBe(redMain);
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
});
