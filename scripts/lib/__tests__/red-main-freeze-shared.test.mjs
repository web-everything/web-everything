// @vitest-environment node
/**
 * @file red-main-freeze-shared.test.mjs — card xyd06qo: the red-main freeze is published to a shared ops/* branch
 *   by the same CLI that raises/clears it locally, and the merge-gate reads that branch: pass while clear, hold while
 *   frozen, FAIL CLOSED whenever the shared copy is missing or unreadable. Every git/fs call is stubbed.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHARED_FREEZE_FILE, buildSharedFreezeDoc, publishSharedFreeze, publishFreezeFromCli, readSharedFreeze, resolveFreezeBranch,
} from '../red-main-freeze-shared.mjs';
import { evaluatePrGates } from '../merge-gate-ci.mjs';

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
      publish: () => { throw new Error('push rejected'); },
    });
    expect(r).toMatchObject({ ok: false, error: 'push rejected' });
    expect(code).toBe(1);
    expect(lines.join('')).toMatch(/SHARED copy was NOT published.*red-main-remediation\.mjs publish/s);
  });

  it('CLI hook: never pushes from inside a test run unless a board is injected', async () => {
    let called = false;
    const r = await publishFreezeFromCli({ marker: null, env: { VITEST: 'true' }, publish: () => { called = true; } });
    expect(r).toEqual({ ok: true, skipped: 'test-run' });
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
