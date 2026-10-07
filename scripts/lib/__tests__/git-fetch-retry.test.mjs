import { describe, it, expect, vi } from 'vitest';
import { retryTransientGit, withFetchRetry, GIT_LOCK_REASON } from '../git-fetch-retry.mjs';
import { isTransientRefLockError } from '../lane-lease.mjs';
import { classifyPrepareFailure } from '../../conveyor/prepare-failure-policy.mjs';

const lockErr = () => Object.assign(new Error("Command failed: git fetch -q origin main\nerror: cannot lock ref 'refs/remotes/origin/main': is at a04b734f but expected 1234"), {});
const noSleep = { sleep: () => {}, random: () => 0.5 };

describe('retryTransientGit (held item 127)', () => {
  it('ref-lock error then success gives success', () => {
    let n = 0;
    const out = retryTransientGit(() => { if (++n === 1) throw lockErr(); return 'ok'; }, noSleep);
    expect(out).toBe('ok'); expect(n).toBe(2);
  });
  it('retries a .lock-exists error, reading stderr too', () => {
    let n = 0;
    const e = Object.assign(new Error('failed'), { stderr: "fatal: Unable to create '/x/refs/remotes/origin/main.lock': File exists." });
    expect(retryTransientGit(() => { if (++n < 3) throw e; return 1; }, noSleep)).toBe(1);
    expect(isTransientRefLockError(e.stderr)).toBe(true);
  });
  it('backs off with jitter via the injected sleep', () => {
    const sleep = vi.fn(); let n = 0;
    retryTransientGit(() => { if (++n < 3) throw lockErr(); }, { sleep, random: () => 0, baseMs: 100 });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([50, 100]);
  });
  it('after the bound, throws tagged transient', () => {
    let n = 0;
    try { retryTransientGit(() => { n++; throw lockErr(); }, { ...noSleep, attempts: 3 }); } catch (e) {
      expect(n).toBe(3); expect(e.transient).toBe(true); expect(e.reason).toBe(GIT_LOCK_REASON);
      expect(classifyPrepareFailure({ error: e.message }, 'stamp')).toBe('infra-transient');
      return;
    }
    throw new Error('should throw');
  });
  it('does not retry other errors', () => {
    let n = 0;
    expect(() => retryTransientGit(() => { n++; throw new Error('fatal: could not resolve host'); }, noSleep)).toThrow(/resolve host/);
    expect(n).toBe(1);
  });
  it('knob via env', () => {
    let n = 0;
    expect(() => retryTransientGit(() => { n++; throw lockErr(); }, { ...noSleep, env: { WE_GIT_LOCK_RETRY_ATTEMPTS: '2' } })).toThrow();
    expect(n).toBe(2);
  });
  it('withFetchRetry only wraps git fetch', () => {
    let n = 0;
    const exec = withFetchRetry((c, a) => { if (a[0] === 'fetch' && ++n === 1) throw lockErr(); return 'x'; }, noSleep);
    expect(exec('git', ['fetch', 'origin'])).toBe('x');
  });
});

describe('call sites retry the race', () => {
  it('landPrepareStamp survives one ref-lock fetch failure', async () => {
    const { landPrepareStamp } = await import('../../operations/prepare-stamp-land.mjs');
    let fetches = 0;
    const run = (cmd, args) => {
      if (args[0] === 'fetch' && ++fetches === 1) throw lockErr();
      if (args[0] === 'rev-parse') return 'sha';
      return '';
    };
    let reached = false;
    await landPrepareStamp({ num: 1 }, {
      run, acquire: () => ({ path: '/x' }), release: () => {},
      readStatus: async () => ({ path: 'backlog/1-a.md', hasSections: true }),
      read: () => { reached = true; throw new Error('stop-after-fetch'); },
    }).catch(() => {});
    expect(reached).toBe(true);
  });
});
