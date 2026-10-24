/**
 * @file scripts/__tests__/remote-verify.test.mjs
 * @description Red-first contract for remote verification. All runtime IO is injected;
 *   workflow checks read committed source without invoking GitHub or a real timer.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import {
  selectRemoteVerifyRun,
  remoteVerdict,
  buildRemoteMarker,
  waitForRemoteVerify,
} from '../lib/remote-verify.mjs';
import { verifyStartBody, verifyFinishBody } from '../lib/lane-verify.mjs';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const T0 = Date.parse('2026-10-24T00:00:00.000Z');
const run = (overrides = {}) => ({
  id: 123,
  head_sha: SHA,
  status: 'completed',
  conclusion: 'success',
  event: 'push',
  created_at: new Date(T0).toISOString(),
  ...overrides,
});

function fakeClock() {
  let time = T0;
  return {
    now: () => time,
    sleep: vi.fn(async (ms) => {
      // A broken polling interval must fail promptly rather than hang the test.
      expect(Number.isFinite(ms) && ms > 0).toBe(true);
      time += ms;
    }),
  };
}

describe('selectRemoteVerifyRun — newest run for the exact full SHA', () => {
  it('returns null for an empty list or only unrelated heads', () => {
    expect(selectRemoteVerifyRun([], SHA)).toBeNull();
    expect(selectRemoteVerifyRun([run({ head_sha: OTHER })], SHA)).toBeNull();
  });

  it('sorts by created_at, independent of array order, run id, event or conclusion', () => {
    const old = run({ id: 999, created_at: new Date(T0 - 1000).toISOString() });
    const newest = run({ id: 1, event: 'workflow_dispatch', status: 'queued', conclusion: null });
    const unrelated = run({ head_sha: OTHER, created_at: new Date(T0 + 1000).toISOString() });
    for (const runs of [[old, unrelated, newest], [newest, old, unrelated]]) {
      expect(selectRemoteVerifyRun(runs, SHA)).toEqual(newest);
    }
  });

  it('matches full 40-character hexadecimal SHAs case-insensitively in either argument', () => {
    expect(selectRemoteVerifyRun([run({ head_sha: SHA.toUpperCase() })], SHA)?.id).toBe(123);
    expect(selectRemoteVerifyRun([run()], SHA.toUpperCase())?.id).toBe(123);
  });

  it.each([SHA.slice(0, 7), SHA.slice(0, 39), `${SHA}0`, `${SHA.slice(0, 39)}2`, 'g'.repeat(40), '', null, undefined])(
    'never accepts a prefix, different or malformed SHA (%s)', (badSha) => {
      expect(selectRemoteVerifyRun([run({ head_sha: badSha })], SHA)).toBeNull();
      expect(selectRemoteVerifyRun([run()], badSha)).toBeNull();
    },
  );
});

describe('remoteVerdict — only completed success is green', () => {
  it('null means absent', () => {
    expect(remoteVerdict(null)).toEqual({ state: 'absent' });
  });

  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])('%s means pending even with a success conclusion', (status) => {
    expect(remoteVerdict(run({ status, conclusion: null }))).toEqual({ state: 'pending' });
    expect(remoteVerdict(run({ status }))).toEqual({ state: 'pending' });
  });

  it('completed success is green', () => {
    expect(remoteVerdict(run())).toEqual({ state: 'green' });
  });

  it.each(['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required', 'stale', null])(
    'completed %s is red and preserves the conclusion', (conclusion) => {
      expect(remoteVerdict(run({ conclusion }))).toEqual({ state: 'red', conclusion });
    },
  );

  it('fails closed on malformed evidence instead of manufacturing green', () => {
    for (const malformed of [undefined, false, 42, 'success', [], {}, { conclusion: 'success' },
      { status: 'completed' }, run({ conclusion: 'SUCCESS' }), run({ conclusion: true })]) {
      expect(remoteVerdict(malformed).state).not.toBe('green');
    }
  });
});

describe('buildRemoteMarker — shared lane marker bodies with remote provenance', () => {
  it('matches the shared start/finish schema, stamps the injected time and records the run URL', () => {
    const successful = run({ html_url: 'https://github.com/example/repo/actions/runs/123' });
    const instant = new Date(T0).toISOString();
    const expected = verifyFinishBody(
      verifyStartBody({ sha: SHA, treeHash: TREE, suites: 'remote-verify:123', startedAt: instant }),
      { finishedAt: instant, exitCode: 0, sha: SHA, treeHash: TREE },
    );
    const marker = buildRemoteMarker({ sha: SHA, treeHash: TREE, run: successful, now: () => T0 });
    expect(marker).toEqual({
      ...expected,
      remote: { runId: 123, url: successful.html_url },
    });
    expect(marker).toMatchObject({ status: 'green', exitCode: 0, sha: SHA, treeHash: TREE, suites: 'remote-verify:123' });
  });

  it('records the run id when the optional URL is absent', () => {
    const marker = buildRemoteMarker({ sha: SHA, treeHash: TREE, run: run(), now: () => T0 });
    expect(marker.remote.runId).toBe(123);
    expect(marker.remote.url).toBeUndefined();
  });

  it.each([null, run({ status: 'in_progress' }), run({ conclusion: 'failure' }),
    run({ conclusion: 'cancelled' }), run({ conclusion: null }), {}])('refuses non-green evidence (%j)', (evidence) => {
    expect(() => buildRemoteMarker({ sha: SHA, treeHash: TREE, run: evidence, now: () => T0 })).toThrow();
  });

  it.each([OTHER, SHA.slice(0, 7), null])('refuses a green run for a different or incomplete head (%s)', (head_sha) => {
    expect(() => buildRemoteMarker({ sha: SHA, treeHash: TREE, run: run({ head_sha }), now: () => T0 })).toThrow();
  });

  it.each([undefined, null, ''])('refuses a missing tree hash (%s)', (treeHash) => {
    expect(() => buildRemoteMarker({ sha: SHA, treeHash, run: run(), now: () => T0 })).toThrow();
  });
});

describe('waitForRemoteVerify — hermetic bounded polling', () => {
  function options(fetchRuns, overrides = {}) {
    return { fetchRuns, sha: SHA, waitMs: 1000, pollMs: 100, ...fakeClock(), ...overrides };
  }

  it('returns an already green run without sleeping or fetching again', async () => {
    const successful = run();
    const fetchRuns = vi.fn(async () => [successful]);
    const opts = options(fetchRuns);
    expect(await waitForRemoteVerify(opts)).toEqual({ ok: true, state: 'green', run: successful });
    expect(fetchRuns).toHaveBeenCalledTimes(1);
    expect(opts.sleep).not.toHaveBeenCalled();
  });

  it.each(['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', null])('returns red immediately for completed %s', async (conclusion) => {
    const failed = run({ conclusion });
    const opts = options(vi.fn(async () => [failed]));
    expect(await waitForRemoteVerify(opts)).toEqual({ ok: false, state: 'red', run: failed });
    expect(opts.sleep).not.toHaveBeenCalled();
  });

  it('polls through absent and pending evidence until the run turns green', async () => {
    const successful = run();
    const fetchRuns = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([run({ status: 'in_progress', conclusion: null })])
      .mockResolvedValue([successful]);
    const opts = options(fetchRuns);
    expect(await waitForRemoteVerify(opts)).toEqual({ ok: true, state: 'green', run: successful });
    expect(fetchRuns).toHaveBeenCalledTimes(3);
    expect(opts.sleep.mock.calls).toEqual([[100], [100]]);
  });

  it('returns red when a pending run settles unsuccessfully', async () => {
    const failed = run({ conclusion: 'failure' });
    const fetchRuns = vi.fn().mockResolvedValueOnce([run({ status: 'queued', conclusion: null })]).mockResolvedValue([failed]);
    expect(await waitForRemoteVerify(options(fetchRuns))).toEqual({ ok: false, state: 'red', run: failed });
    expect(fetchRuns).toHaveBeenCalledTimes(2);
  });

  it('waits for the newest matching run rather than trusting an older green or another head', async () => {
    const pending = run({ id: 456, status: 'queued', conclusion: null });
    const runs = [run({ created_at: new Date(T0 - 1000).toISOString() }), pending,
      run({ head_sha: OTHER, created_at: new Date(T0 + 1000).toISOString() })];
    expect(await waitForRemoteVerify(options(async () => runs))).toEqual({ ok: false, state: 'timeout', run: pending });
  });

  it.each(['absent', 'pending', 'other-head'])('%s evidence at the deadline times out and never authorizes a marker', async (kind) => {
    const pending = run({ status: 'in_progress', conclusion: null });
    const runs = kind === 'absent' ? [] : kind === 'pending' ? [pending] : [run({ head_sha: OTHER })];
    const opts = options(vi.fn(async () => runs), { waitMs: 250 });
    expect(await waitForRemoteVerify(opts)).toEqual({ ok: false, state: 'timeout', run: kind === 'pending' ? pending : null });
    expect(opts.now() - T0).toBe(250);
    expect(opts.sleep.mock.calls).toEqual([[100], [100], [50]]);
  });

  it('zero wait still probes once, then times out without sleeping', async () => {
    const fetchRuns = vi.fn(async () => []);
    const opts = options(fetchRuns, { waitMs: 0 });
    expect(await waitForRemoteVerify(opts)).toEqual({ ok: false, state: 'timeout', run: null });
    expect(fetchRuns).toHaveBeenCalledTimes(1);
    expect(opts.sleep).not.toHaveBeenCalled();
  });

  it.each([540001, 5_400_000])('caps oversized waitMs=%s at 540000 and returns the explicit timeout fallback', async (waitMs) => {
    const opts = options(vi.fn(async () => []), { waitMs, pollMs: 200000 });
    expect(await waitForRemoteVerify(opts)).toEqual({ ok: false, state: 'timeout', run: null });
    expect(opts.now() - T0).toBe(540000);
    expect(opts.sleep.mock.calls).toEqual([[200000], [200000], [140000]]);
  });

  it('fails closed as error when the initial fetch throws', async () => {
    const opts = options(vi.fn(async () => { throw new Error('unreadable workflow runs'); }));
    expect(await waitForRemoteVerify(opts)).toEqual({ ok: false, state: 'error', run: null });
    expect(opts.sleep).not.toHaveBeenCalled();
  });

  it('fails closed as error when a later fetch throws instead of trusting the pending result', async () => {
    const pending = run({ status: 'queued', conclusion: null });
    const fetchRuns = vi.fn().mockResolvedValueOnce([pending]).mockRejectedValue(new Error('API unavailable'));
    const result = await waitForRemoteVerify(options(fetchRuns));
    expect(result).toMatchObject({ ok: false, state: 'error' });
    expect(result).toHaveProperty('run');
    expect(fetchRuns).toHaveBeenCalledTimes(2);
  });
});

describe('remote-verify workflow — source contract', () => {
  const source = () => readFileSync(new URL('../../.github/workflows/remote-verify.yml', import.meta.url), 'utf8');

  it('triggers workflow_dispatch and pushes to lane/**', () => {
    const text = source();
    expect(text).toMatch(/\bworkflow_dispatch\s*:/);
    const workflow = yaml.safeLoad(text);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.on.push.branches).toContain('lane/**');
  });

  it('grants contents read only and permits no job-level escalation', () => {
    const text = source();
    expect(text).toMatch(/\bcontents:\s*read\b/);
    const workflow = yaml.safeLoad(text);
    const checkPermissions = (permissions) => {
      expect(permissions).toBeTruthy();
      expect(typeof permissions).toBe('object');
      expect(permissions.contents).toBe('read');
      for (const [name, level] of Object.entries(permissions)) {
        if (name !== 'contents') {
          expect(['checks', 'statuses']).toContain(name);
          expect(level).toBe('none');
        }
      }
    };
    checkPermissions(workflow.permissions);
    for (const job of Object.values(workflow.jobs)) {
      if (job.permissions !== undefined) checkPermissions(job.permissions);
    }
  });

  it('uses the configured shard runner with ubuntu-latest as fallback', () => {
    const workflow = yaml.safeLoad(source());
    const jobs = Object.values(workflow.jobs);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job['runs-on']).toMatch(/^\$\{\{\s*vars\.WE_SHARD_RUNNER\s*\|\|\s*['"]ubuntu-latest['"]\s*\}\}$/);
    }
  });

  it('references no secrets except secrets.GITHUB_TOKEN', () => {
    expect(source().replace(/\bsecrets\.GITHUB_TOKEN\b/g, '')).not.toMatch(/secrets\./i);
  });

  it('contains no model-provider or agent references, case-insensitively', () => {
    expect(source()).not.toMatch(/claude|codex|anthropic|openai/i);
  });
});
