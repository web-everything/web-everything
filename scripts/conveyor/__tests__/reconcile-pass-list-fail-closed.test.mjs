/**
 * @file scripts/conveyor/__tests__/reconcile-pass-list-fail-closed.test.mjs
 * @description The production open-PR list read (defaultReadPrs): cheap (snapshot / small pages, author via the
 * ETag-cached REST reader), 5xx retried with backoff, and every incomplete, failed or empty read FAILS CLOSED with a
 * named reason (504 incident 2026-11-03). Split out of reconcile-pass.test.mjs so it never collides with that file.
 */
import { vi, it, expect, describe } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(), execFileSync: vi.fn(),
}));
vi.mock('../../lib/gh-throttle.mjs', async (importOriginal) => {
  const { execFileSync } = await import('node:child_process');
  // execFileSync is the vi.fn() above, so this gh is a fake: no real process is ever spawned.
  const fakeGh = (args, opts) => execFileSync('gh', args, opts);
  return {
    ...await importOriginal(),
    execFileSyncThrottled: vi.fn((file, args, opts) => execFileSync(file, args, opts)),
    runGhSync: vi.fn(fakeGh),
  };
});
vi.mock('../../lib/write-all-sync.mjs', () => ({ writeAllSync: vi.fn(), writeLineSync: vi.fn() }));
vi.mock('../../lib/required-status-checks.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getRequiredStatusChecks: vi.fn(() => ({ checks: [...actual.FALLBACK_REQUIRED_STATUS_CHECKS], source: 'fixture' })),
  };
});

describe('defaultReadPrs production list path is cheap and loud (504 incident 2026-11-03)', () => {
  it('drops author from the snapshot request and fills it per PR through the cached REST reader', async () => {
    const { defaultReadPrs } = await import('../reconcile-pass.mjs');
    const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
    let asked;
    const rest = vi.fn(() => ({ status: 200, json: { user: { login: 'dependabot[bot]', type: 'Bot' } } }));
    const prs = defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readCommits: () => [],
      readShared: ({ fields }) => { asked = fields; return [{ number: 7, labels: [], comments: [], statusCheckRollup: [] }]; },
      readRest: rest });
    expect(asked.split(',')).not.toContain('author');
    expect(rest).toHaveBeenCalledWith('repos/o/r/pulls/7', expect.any(Object));
    expect(prs[0].author).toMatchObject({ login: 'dependabot[bot]', is_bot: true });
  });
  it('falls back to small pages (never a 200-row heavy gh pr list) and surfaces a persistent 504', async () => {
    const { defaultReadPrs } = await import('../reconcile-pass.mjs');
    const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
    const e504 = Object.assign(new Error('x'), { stderr: 'HTTP 504: 504 Gateway Timeout' });
    const listPaged = vi.fn(() => { throw e504; });
    let err;
    try { defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readShared: () => null, listPaged,
      retryOpts: { sleep: () => {}, persist: false, onEvent: () => {} }, readRest: () => ({}) }); } catch (e) { err = e; }
    expect(String(err?.stderr)).toMatch(/504/);
    expect(listPaged).toHaveBeenCalledTimes(3);
  });
});

it('a truncated paged fallback is refused loudly, never planned as a complete inventory', async () => {
  const { defaultReadPrs } = await import('../reconcile-pass.mjs');
  const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
  const rows = [{ number: 1, labels: [], comments: [], statusCheckRollup: [], author: { login: 'x' } }];
  expect(() => defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readCommits: () => [], readShared: () => null,
    listPaged: () => ({ rows, truncated: true, totalCount: 900, cache: {} }), readRest: () => ({ json: {} }) })).toThrow(/truncated/);
});

it('a truncated shared snapshot is refused loudly too', async () => {
  const { defaultReadPrs } = await import('../reconcile-pass.mjs');
  const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
  const rows = [{ number: 1 }];
  Object.defineProperty(rows, 'discoveryIncomplete', { value: true });
  expect(() => defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readShared: () => rows })).toThrow(/truncated/);
});

describe('direct (snapshot-disabled) list path: retried and truncation-safe', () => {
  const withDisabled = async (fn) => {
    const prev = process.env.WE_PR_SNAPSHOT; process.env.WE_PR_SNAPSHOT = '0';
    try { return await fn(); } finally { if (prev === undefined) delete process.env.WE_PR_SNAPSHOT; else process.env.WE_PR_SNAPSHOT = prev; }
  };
  const row = (n) => ({ number: n, labels: [], comments: [], statusCheckRollup: [], author: { login: 'x' } });
  const e504 = () => Object.assign(new Error('gh failed'), { stderr: 'HTTP 504: 504 Gateway Timeout' });
  it('refuses a capped 200-row inventory (after retrying the 504 before it)', () => withDisabled(async () => {
    const { defaultReadPrs, PR_LIST_LIMIT } = await import('../reconcile-pass.mjs');
    const { execFileSync } = await import('node:child_process');
    const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
    let n = 0;
    execFileSync.mockReset().mockImplementation(() => { if (++n === 1) throw e504(); return JSON.stringify(Array.from({ length: PR_LIST_LIMIT }, (_, i) => row(i + 1))); });
    expect(() => defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readCommits: () => [], readShared: () => null,
      retryOpts: { sleep: () => {}, persist: false, onEvent: () => {} } })).toThrow(/cap — refusing/);
    expect(n).toBe(2);
  }));
  it('valid JSON that is not an array is a failure, never an empty inventory', () => withDisabled(async () => {
    const { defaultReadPrs } = await import('../reconcile-pass.mjs');
    const { execFileSync } = await import('node:child_process');
    const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
    execFileSync.mockReset().mockReturnValue(JSON.stringify({ message: 'oops' }));
    expect(() => defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readCommits: () => [], readShared: () => null,
      retryOpts: { sleep: () => {}, persist: false, onEvent: () => {} } })).toThrow(/not a list/);
  }));
  it('empty subprocess output is a failure, never an empty inventory', () => withDisabled(async () => {
    const { defaultReadPrs } = await import('../reconcile-pass.mjs');
    const { execFileSync } = await import('node:child_process');
    const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
    execFileSync.mockReset().mockReturnValue('');
    expect(() => defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readCommits: () => [], readShared: () => null,
      retryOpts: { sleep: () => {}, persist: false, onEvent: () => {} } })).toThrow(/empty output/);
  }));
  it('returns a normal listing after a retried 504', () => withDisabled(async () => {
    const { defaultReadPrs } = await import('../reconcile-pass.mjs');
    const { execFileSync } = await import('node:child_process');
    const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
    let n = 0;
    execFileSync.mockReset().mockImplementation(() => { if (++n === 1) throw e504(); return JSON.stringify([row(1)]); });
    const prs = defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readCommits: () => [], readShared: () => null,
      retryOpts: { sleep: () => {}, persist: false, onEvent: () => {} } });
    expect(prs.map(p => p.number)).toEqual([1]);
  }));
});

it('a paged fallback that returns fewer rows than GitHub reported is refused', async () => {
  const { defaultReadPrs } = await import('../reconcile-pass.mjs');
  const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
  expect(() => defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readCommits: () => [], readShared: () => null,
    listPaged: () => ({ rows: [], truncated: false, totalCount: 7, cache: {} }), readRest: () => ({ json: {} }) })).toThrow(/0 of 7/);
});

it('an author lookup failure fails the whole read; a row is never accepted without its author', async () => {
  const { defaultReadPrs } = await import('../reconcile-pass.mjs');
  const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
  const rows = [{ number: 41, labels: [], comments: [], statusCheckRollup: [] }];
  expect(() => defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readCommits: () => [], readShared: () => rows,
    readRest: () => { throw Object.assign(new Error('boom'), { stderr: 'HTTP 404' }); },
    retryOpts: { sleep: () => {}, persist: false, onEvent: () => {} } })).toThrow(/author/);
  expect(() => defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readCommits: () => [], readShared: () => [{ ...rows[0], number: 42 }],
    readRest: () => ({ json: {} }),
    retryOpts: { sleep: () => {}, persist: false, onEvent: () => {} } })).toThrow(/author/);
});

describe('a declared smoke sample is not truncation (follow-up regression, 2026-11-03 16:23 ET)', () => {
  const rowsWith = (flags) => { const r = [{ number: 1, labels: [], comments: [], statusCheckRollup: [], author: { login: 'x' } }]; for (const [k, v] of Object.entries(flags)) Object.defineProperty(r, k, { value: v }); return r; };
  const read = async (flags, env, smokeClone) => {
    const prev = process.env.WE_PR_SNAPSHOT_SAMPLE, prevClone = process.env.WE_SMOKE_LIVE_CLONE;
    if (smokeClone) process.env.WE_SMOKE_LIVE_CLONE = smokeClone; else delete process.env.WE_SMOKE_LIVE_CLONE;
    if (env === undefined) delete process.env.WE_PR_SNAPSHOT_SAMPLE; else process.env.WE_PR_SNAPSHOT_SAMPLE = env;
    try {
      const { defaultReadPrs } = await import('../reconcile-pass.mjs');
      const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
      return defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readCommits: () => [], readShared: () => rowsWith(flags) });
    } finally {
      if (prev === undefined) delete process.env.WE_PR_SNAPSHOT_SAMPLE; else process.env.WE_PR_SNAPSHOT_SAMPLE = prev;
      if (prevClone === undefined) delete process.env.WE_SMOKE_LIVE_CLONE; else process.env.WE_SMOKE_LIVE_CLONE = prevClone;
    }
  };
  it('accepts sampled rows in a rebuild-smoke child (sample injected from settings, not process.env)', async () => {
    expect((await read({ sampled: true }, undefined, '/clone')).map(p => p.number)).toEqual([1]);
  });
  it('keeps the sampled flag through the author fill', async () => {
    const { withRestAuthors } = await import('../reconcile-pass.mjs');
    const r = [{ number: 5 }]; Object.defineProperty(r, 'sampled', { value: true });
    expect(withRestAuthors(r, { repo: 'o/r', readRest: () => ({ json: { user: { login: 'u', type: 'User' } } }) }).sampled).toBe(true);
  });
  it('accepts rows marked sampled when the sample env is declared', async () => {
    expect((await read({ sampled: true }, '12')).map(p => p.number)).toEqual([1]);
  });
  it('refuses a sampled flag when no sample env is set', async () => {
    await expect(read({ sampled: true }, undefined)).rejects.toThrow(/sample/);
  });
  it('refuses a truncated snapshot even when a sample is declared', async () => {
    await expect(read({ discoveryIncomplete: true }, '12')).rejects.toThrow(/truncated/);
  });
});
