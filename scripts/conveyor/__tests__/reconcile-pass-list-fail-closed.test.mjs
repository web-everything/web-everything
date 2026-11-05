/**
 * @file scripts/conveyor/__tests__/reconcile-pass-list-fail-closed.test.mjs
 * @description The production open-PR list read (defaultReadPrs): cheap (snapshot / small pages, author via the
 * ETag-cached REST reader), 5xx retried with backoff, and every incomplete, failed or empty read FAILS CLOSED with a
 * named reason (504 incident 2026-11-03). Split out of reconcile-pass.test.mjs so it never collides with that file.
 */
import { vi, it, expect, describe, beforeAll } from 'vitest';

// Every test below pays a dynamic `import('../reconcile-pass.mjs')`. Under a loaded host that first import alone exceeds
// the 5 s default test timeout; the timed-out test's still-running body then leaks a live `gh pr list` into the hermetic
// guard and cascades red onto its neighbours (verify of PR #6407, load average ~48). Warm the module graph once, here,
// with a budget sized for load, so the per-test timeouts measure the test and not the cold import.
beforeAll(async () => {
  await import('../reconcile-pass.mjs');
  await import('../../lib/gh-throttle.mjs');
  await import('../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
}, 180_000);

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

describe('author lookup: a gh slot throttle DEFERS the read; it is never a hard failure and never accepts a row without its author', () => {
  const throttled = () => Object.assign(new Error('gh-throttle: throttled — no gh slot within 8.122s (class=background); retry next tick\n'),
    { status: 1, stdout: '', stderr: 'gh-throttle: throttled — no gh slot within 8.122s (class=background); retry next tick\n', ghThrottled: { class: 'background', waitedMs: 8122 } });
  const read = async (number, readRest) => {
    const { defaultReadPrs } = await import('../reconcile-pass.mjs');
    const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
    return defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readCommits: () => [], readRest,
      readShared: () => [{ number, labels: [], comments: [], statusCheckRollup: [] }],
      retryOpts: { sleep: () => {}, persist: false, onEvent: () => {} } });
  };
  it('a throttled author lookup returns the deferred marker (retry next tick), not rows and not a throw', async () => {
    const { isGhDeferred } = await import('../../lib/gh-deferred.mjs');
    const out = await read(9101, () => { throw throttled(); });
    expect(Array.isArray(out)).toBe(false);
    expect(isGhDeferred(out)).toBe(true);
    expect(out.deferred).toBe(true);
  });
  it('a genuine 4xx still fails closed', async () => {
    await expect(read(9102, () => { throw Object.assign(new Error('x'), { stderr: 'HTTP 404: Not Found', httpStatus: 404 }); })).rejects.toThrow(/author/);
  });
  it('a missing login still fails closed', async () => {
    await expect(read(9103, () => ({ json: {} }))).rejects.toThrow(/author/);
  });
  it('a resolved author is remembered: the second read of the same PR makes no REST call', async () => {
    const rest = vi.fn(() => ({ json: { user: { login: 'u', type: 'User' } } }));
    expect((await read(9104, rest)).map(p => p.author.login)).toEqual(['u']);
    expect((await read(9104, rest)).map(p => p.author.login)).toEqual(['u']);
    expect(rest).toHaveBeenCalledTimes(1);
  });
});

describe('author lookups are bounded so a tick cannot wedge the daemon loop', () => {
  it('defers once the per-read budget is spent, keeping the lookups already done', async () => {
    const { withRestAuthors } = await import('../reconcile-pass.mjs');
    const rest = vi.fn(() => ({ json: { user: { login: 'u', type: 'User' } } }));
    const rows = Array.from({ length: 5 }, (_, i) => ({ number: 9200 + i }));
    let err; try { withRestAuthors(rows, { repo: 'o/r', readRest: rest, budget: 3 }); } catch (e) { err = e; }
    expect(err?.authorLookupDeferred).toBe(true);
    expect(rest).toHaveBeenCalledTimes(3);
    // the next tick continues where this one stopped (memoised), within budget
    expect(withRestAuthors(rows, { repo: 'o/r', readRest: rest, budget: 3 })).toHaveLength(5);
    expect(rest).toHaveBeenCalledTimes(5);
  });
  it('defers once the wall-clock deadline is spent, and passes a short per-call timeout', async () => {
    const { withRestAuthors } = await import('../reconcile-pass.mjs');
    let t = 0;
    const rest = vi.fn(() => { t += 15_000; return { json: { user: { login: 'u', type: 'User' } } }; });
    const rows = Array.from({ length: 6 }, (_, i) => ({ number: 9300 + i }));
    let err; try { withRestAuthors(rows, { repo: 'o/r', readRest: rest, budget: 99, deadlineMs: 20_000, now: () => t }); } catch (e) { err = e; }
    expect(err?.authorLookupDeferred).toBe(true);
    expect(rest).toHaveBeenCalledTimes(2);
    expect(rest.mock.calls[0][1].execOpts.timeout).toBeLessThanOrEqual(15_000);
  });
});

describe('resolved authors persist across processes (a cold one-shot pass converges under the budget)', () => {
  it('writes the memo next to the PR snapshot and a cold process reads it without a REST call', async () => {
    const { mkdtempSync, readFileSync, existsSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'pr-authors-'));
    const prev = process.env.WE_PR_SNAPSHOT_DIR; process.env.WE_PR_SNAPSHOT_DIR = dir;
    try {
      vi.resetModules();
      const a = await import('../reconcile-pass.mjs');
      a.withRestAuthors([{ number: 9401 }], { repo: 'o/r', readRest: () => ({ json: { user: { login: 'persisted', type: 'User' } } }) });
      expect(existsSync(join(dir, 'pr-authors.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, 'pr-authors.json'), 'utf8'))['o/r#9401'].login).toBe('persisted');
      vi.resetModules(); // a fresh process: empty in-process memo
      const b = await import('../reconcile-pass.mjs');
      const rest = vi.fn(() => { throw new Error('must not be called'); });
      expect(b.withRestAuthors([{ number: 9401 }], { repo: 'o/r', readRest: rest })[0].author.login).toBe('persisted');
      expect(rest).not.toHaveBeenCalled();
    } finally { if (prev === undefined) delete process.env.WE_PR_SNAPSHOT_DIR; else process.env.WE_PR_SNAPSHOT_DIR = prev; rmSync(dir, { recursive: true, force: true }); }
  });
});

it('an unwritable author memo is reported (once), not swallowed', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pr-authors-ro-'));
  writeFileSync(join(dir, 'blocker'), 'x'); // a FILE where the snapshot dir should be → mkdir fails
  const prev = process.env.WE_PR_SNAPSHOT_DIR; process.env.WE_PR_SNAPSHOT_DIR = join(dir, 'blocker');
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    vi.resetModules();
    const m = await import('../reconcile-pass.mjs');
    m.withRestAuthors([{ number: 9501 }, { number: 9502 }], { repo: 'o/r', readRest: () => ({ json: { user: { login: 'u', type: 'User' } } }) });
    const warns = err.mock.calls.map(c => String(c[0])).filter(t => /author memo not persisted/.test(t));
    expect(warns).toHaveLength(1);
  } finally { err.mockRestore(); if (prev === undefined) delete process.env.WE_PR_SNAPSHOT_DIR; else process.env.WE_PR_SNAPSHOT_DIR = prev; rmSync(dir, { recursive: true, force: true }); }
});

describe('author lookup: a gh call TIMEOUT defers like a slot throttle; the default limits are pinned', () => {
  const timedOut = () => Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGKILL', status: null, stderr: '' });
  it('an 8 s call timeout (ETIMEDOUT / SIGKILL) defers the whole read, never a hard pr-author-unreadable', async () => {
    const { withRestAuthors } = await import('../reconcile-pass.mjs');
    for (const err of [timedOut(), Object.assign(new Error('x'), { stderr: 'context deadline exceeded (Client.Timeout exceeded)' })]) {
      let thrown;
      try { withRestAuthors([{ number: 9700 + Math.floor(Math.random() * 1e4) }], { repo: 'o/r', readRest: () => { throw err; } }); } catch (e) { thrown = e; }
      expect(thrown?.authorLookupDeferred).toBe(true);
      expect(thrown?.code).not.toBe('pr-author-unreadable');
    }
  });
  it('a read-through timeout in defaultReadPrs returns the deferred marker (retry next tick)', async () => {
    const { defaultReadPrs } = await import('../reconcile-pass.mjs');
    const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
    const out = defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readCommits: () => [],
      readShared: () => [{ number: 9801, labels: [], comments: [], statusCheckRollup: [] }], readRest: () => { throw timedOut(); },
      retryOpts: { sleep: () => {}, persist: false, onEvent: () => {} } });
    expect(out.deferred).toBe(true);
  });
  it('a bare SIGKILL / killed process (OOM, operator kill) is NOT a timeout: it fails closed', async () => {
    const { withRestAuthors } = await import('../reconcile-pass.mjs');
    for (const err of [Object.assign(new Error('killed'), { signal: 'SIGKILL', status: null }), Object.assign(new Error('x'), { killed: true })]) {
      expect(() => withRestAuthors([{ number: 9803 + Math.floor(Math.random() * 1e4) }], { repo: 'o/r', readRest: () => { throw err; } })).toThrow(/author/);
    }
  });
  it('a genuine non-timeout failure (HTTP 404) still fails closed', async () => {
    const { withRestAuthors } = await import('../reconcile-pass.mjs');
    expect(() => withRestAuthors([{ number: 9802 }], { repo: 'o/r', readRest: () => { throw Object.assign(new Error('x'), { stderr: 'HTTP 404: Not Found' }); } })).toThrow(/author/);
  });
  it('pins the default limits: 16 lookups, 12 s total, 8 s per call (passed to the REST reader)', async () => {
    const m = await import('../reconcile-pass.mjs');
    expect(m.AUTHOR_LOOKUP_BUDGET).toBe(16);
    expect(m.AUTHOR_LOOKUP_DEADLINE_MS).toBe(12_000);
    expect(m.AUTHOR_LOOKUP_TIMEOUT_MS).toBe(8_000);
    const rest = vi.fn(() => ({ json: { user: { login: 'u', type: 'User' } } }));
    const rows = Array.from({ length: 17 }, (_, i) => ({ number: 9900 + i }));
    let err; try { m.withRestAuthors(rows, { repo: 'o/r', readRest: rest }); } catch (e) { err = e; }
    expect(err?.authorLookupDeferred).toBe(true);   // the 17th lookup is over the default budget
    expect(rest).toHaveBeenCalledTimes(16);
    expect(rest.mock.calls[0][1].execOpts.timeout).toBe(8_000);
  });
});

describe('fresh read (the fix daemon plans from a read taken AFTER its baseline probe): small pages, never the shared snapshot, never the heavy list', () => {
  const run = async (extra) => {
    const { defaultReadPrs } = await import('../reconcile-pass.mjs');
    const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
    const readShared = vi.fn(() => { throw new Error('the shared snapshot may predate the baseline probe'); });
    const issued = [];
    const exec = (...a) => { issued.push(a); return execFileSyncThrottled(...a); };
    void exec;
    return { readShared, call: (listPaged) => defaultReadPrs({ repo: 'o/r', exec: execFileSyncThrottled, readCommits: () => [],
      readShared, listPaged, readRest: () => ({ json: { user: { login: 'u', type: 'User' } } }),
      retryOpts: { sleep: () => {}, persist: false, onEvent: () => {} }, ...extra }) };
  };
  it('fresh:true skips the shared snapshot and reads small pages (the planner always sees post-probe evidence)', async () => {
    const { readShared, call } = await run({ fresh: true });
    const listPaged = vi.fn(() => ({ rows: [{ number: 9601, labels: [], comments: [], statusCheckRollup: [] }], cache: {}, totalCount: 1 }));
    expect(call(listPaged).map(p => p.number)).toEqual([9601]);
    expect(readShared).not.toHaveBeenCalled();
    expect(listPaged).toHaveBeenCalledTimes(1);
  });
  it('fresh:true fails closed like every other list read: a persistent 504 throws, a short inventory is refused', async () => {
    const { call } = await run({ fresh: true });
    const e504 = Object.assign(new Error('x'), { stderr: 'HTTP 504: 504 Gateway Timeout' });
    expect(() => call(() => { throw e504; })).toThrow();
    expect(() => call(() => ({ rows: [], cache: {}, totalCount: 7 }))).toThrow(/0 of 7|unique/);
  });
  it('the fix daemon planning read passes fresh:true and the REAL throttled exec (a wrapper exec forced the heavy list)', async () => {
    const daemon = await import('../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
    const read = vi.fn(() => []);
    daemon.planFreshReadPrs(read)({ repo: 'web-everything/web-everything' });
    const arg = read.mock.calls[0][0];
    expect(arg.fresh).toBe(true);
    expect(arg.exec).toBeUndefined();
    expect(arg.attributionRepo).toBe('web-everything/web-everything');
  });
});

describe('fresh read wiring: the cache handed to listPaged and the paged path itself are pinned', () => {
  const U = Date.parse('2026-11-03T22:00:00Z');
  const entry = (serverSeenMs) => ({ updatedAt: '2026-11-03T22:00:00Z', headRefOid: 'a', fetchedAtMs: 0, serverSeenMs, comments: [], body: '', files: [] });
  const base = { exec: undefined, readCommits: () => [], readShared: () => null,
    readRest: () => ({ json: { user: { login: 'u', type: 'User' } } }),
    retryOpts: { sleep: () => {}, persist: false, onEvent: () => {} } };
  const page = (cache) => vi.fn(() => ({ rows: [{ number: 1, labels: [], comments: [], statusCheckRollup: [] }], cache, totalCount: 1 }));

  it('a fresh read hands listPaged only the SETTLED heavy entries; a non-fresh read hands it the whole cache', async () => {
    const { defaultReadPrs } = await import('../reconcile-pass.mjs');
    const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
    const seeded = { 1: entry(U + 500), 2: entry(U + 5000) }; // 1 = cached inside its updatedAt second; 2 = settled
    const read = (listPaged, fresh) => defaultReadPrs({ ...base, repo: 'o/cache-wiring', exec: execFileSyncThrottled, listPaged, fresh });
    read(page(seeded), false); // seeds pagedHeavyCache for the repo
    const nonFresh = page(seeded);
    read(nonFresh, false);
    expect(Object.keys(nonFresh.mock.calls[0][0].cache).sort()).toEqual(['1', '2']);
    const fresh = page(seeded);
    read(fresh, true);
    expect(Object.keys(fresh.mock.calls[0][0].cache)).toEqual(['2']); // the unsettled entry 1 is NOT reusable
  });

  it('fresh:true with the DEFAULT listPaged and the snapshot disabled reads small pages — never the heavy `gh pr list`', async () => {
    const { defaultReadPrs } = await import('../reconcile-pass.mjs');
    const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
    const { execFileSync } = await import('node:child_process');
    const prev = process.env.WE_PR_SNAPSHOT;
    process.env.WE_PR_SNAPSHOT = '0'; // snapshot explicitly disabled: only `fresh ||` can select the paged path
    execFileSync.mockClear();
    execFileSync.mockImplementation(() => { throw Object.assign(new Error('x'), { stderr: 'HTTP 504: 504 Gateway Timeout' }); });
    try {
      expect(() => defaultReadPrs({ ...base, repo: 'o/default-paged', exec: execFileSyncThrottled, fresh: true })).toThrow();
      const argvs = execFileSync.mock.calls.map(c => c[1]);
      expect(argvs.length).toBeGreaterThan(0);
      expect(argvs.some(a => a[0] === 'pr' && a[1] === 'list')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.WE_PR_SNAPSHOT; else process.env.WE_PR_SNAPSHOT = prev;
      execFileSync.mockReset();
    }
  });
});

it('a fresh read reuses a cached heavy read only once SERVER time had passed its PR updatedAt second (same-second comments stay visible)', async () => {
  const { settledHeavyCache, FRESH_SETTLE_MS } = await import('../reconcile-pass.mjs');
  const U = Date.parse('2026-11-03T22:00:00Z');
  const cache = {
    1: { updatedAt: '2026-11-03T22:00:00Z', serverSeenMs: U + 500, comments: ['maybe stale'] },
    2: { updatedAt: '2026-11-03T22:00:00Z', serverSeenMs: U + FRESH_SETTLE_MS, comments: ['settled'] },
    3: { updatedAt: 'garbage', serverSeenMs: U + 99999 },
    4: { updatedAt: '2026-11-03T22:00:00Z', fetchedAtMs: U + 99999, comments: ['no server stamp: fails closed'] },
  };
  expect(Object.keys(settledHeavyCache(cache))).toEqual(['2']);
  expect(settledHeavyCache(undefined)).toEqual({});
});

describe('clock skew: settlement is proven by server timestamps only, never the local clock', () => {
  const U = Date.parse('2026-11-03T22:00:00Z');
  const row = (number, updatedAt) => ({ number, updatedAt, labels: [], comments: [], statusCheckRollup: [] });
  const iso = (ms) => new Date(ms).toISOString();

  it('a client clock 5 s AHEAD cannot make a same-second cache entry look settled', async () => {
    const { stampServerSeen, settledHeavyCache } = await import('../reconcile-pass.mjs');
    // Heavy read at server U+300 ms, client clock +5 s: the old check saw fetchedAtMs - updatedAt = 5300 ms >= 2000 ms.
    const fresh = { updatedAt: iso(U), headRefOid: 'a', fetchedAtMs: U + 5300, comments: [] };
    const stamped = stampServerSeen({}, { 1: fresh }, [row(1, iso(U))]); // newest server updatedAt in the listing = U itself
    expect(stamped[1].serverSeenMs).toBe(U);
    expect(settledHeavyCache(stamped)).toEqual({});
  });
  it('an entry is settled when the same listing proves server time moved >= 2 s past its updatedAt (skew-free)', async () => {
    const { stampServerSeen, settledHeavyCache } = await import('../reconcile-pass.mjs');
    const stamped = stampServerSeen({}, { 1: { updatedAt: iso(U), fetchedAtMs: -1e9 }, 2: { updatedAt: iso(U + 2500), fetchedAtMs: 1e18 } },
      [row(1, iso(U)), row(2, iso(U + 2500))]);
    expect(Object.keys(settledHeavyCache(stamped))).toEqual(['1']); // 2 is the newest PR itself: not provably settled
  });
  it('a REUSED entry keeps its original stamp (a later listing proves nothing about the earlier heavy read); a missing updatedAt stamps nothing', async () => {
    const { stampServerSeen } = await import('../reconcile-pass.mjs');
    const reused = { updatedAt: iso(U), serverSeenMs: U };
    const out = stampServerSeen({ 1: reused }, { 1: reused, 2: { updatedAt: iso(U) } }, [row(1, iso(U + 60_000))]);
    expect(out[1].serverSeenMs).toBe(U);
    expect(out[2].serverSeenMs).toBe(U + 60_000);
    expect(stampServerSeen({}, { 3: { updatedAt: iso(U) } }, [{ number: 3 }])[3].serverSeenMs).toBeUndefined();
  });
  it('end to end through defaultReadPrs: skewed cache is not handed to listPaged on a fresh read; a server-proven one is', async () => {
    const { defaultReadPrs } = await import('../reconcile-pass.mjs');
    const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
    const base = { readCommits: () => [], readShared: () => null, readRest: () => ({ json: { user: { login: 'u', type: 'User' } } }),
      retryOpts: { sleep: () => {}, persist: false, onEvent: () => {} }, repo: 'o/skew-wiring', exec: execFileSyncThrottled };
    // First (non-fresh) read: listing shows PR 1 at U and PR 2 at U (newest = U), so entry 1 is stamped U -> unsettled. PR 3 is 3 s newer.
    const heavy = (n) => ({ updatedAt: iso(U), headRefOid: 'a', fetchedAtMs: U + 9000, comments: [], body: '', files: [], n });
    const first = vi.fn(() => ({ rows: [row(1, iso(U)), row(2, iso(U))], cache: { 1: heavy(1), 2: heavy(2) }, totalCount: 2 }));
    defaultReadPrs({ ...base, listPaged: first, fresh: false });
    const probe = vi.fn(() => ({ rows: [row(1, iso(U)), row(2, iso(U))], cache: {}, totalCount: 2 }));
    defaultReadPrs({ ...base, listPaged: probe, fresh: true });
    expect(probe.mock.calls[0][0].cache).toEqual({}); // fetchedAtMs says "9 s old", server stamps say unsettled
    const second = vi.fn(() => ({ rows: [row(1, iso(U)), row(3, iso(U + 3000))], cache: { 1: heavy(1), 3: { ...heavy(3), updatedAt: iso(U + 3000) } }, totalCount: 2 }));
    defaultReadPrs({ ...base, listPaged: second, fresh: false });
    const probe2 = vi.fn(() => ({ rows: [row(1, iso(U))], cache: {}, totalCount: 1 }));
    defaultReadPrs({ ...base, listPaged: probe2, fresh: true });
    // entry 1 was re-fetched in a listing whose newest server updatedAt is U+3000 (>= 2 s past U): settled; entry 3 is that newest PR: not
    expect(Object.keys(probe2.mock.calls[0][0].cache)).toEqual(['1']);
  });
});
