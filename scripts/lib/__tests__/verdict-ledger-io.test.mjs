/**
 * @file verdict-ledger-io.test.mjs - ledger plan slice C1 (#3255 part 1): the git io-shell of the verdict ledger.
 *   Unit tests with an injected `git`, plus REAL-git tests against a bare origin (the contention test the plan
 *   names as a hard gate: one rejected push, a retry, and a third clone that sees both rows).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  appendGitRowsSync, createGitLedgerStore, appendLedgerRows, readLedgerFromGit, ledgerGitPath, LedgerAppendExhaustedError, LEDGER_TRANSPORT_BRANCH,
  resolveLedgerReadSettings, formatLedgerReadSettings, sizedLedgerRun, DEFAULT_LEDGER_READ_MAX_BYTES, LEDGER_READ_MAX_BYTES_ENV,
  DEFAULT_APPEND_ATTEMPTS,
} from '../verdict-ledger-io.mjs';
import { buildVerdictRecord, buildLedgerEvent } from '../verdict-ledger.mjs';
import { withBareOrigin, git, writeLocalIdentity } from '../../operations/__tests__/helpers/real-repo.mjs';

const REPO = 'web-everything/web-everything';
const row = (pr, extra = {}) => buildVerdictRecord({
  repo: REPO, pr, verdict: 'accepted', at: '2026-10-07T12:00:00.000Z', source: 'test', ...extra,
});
const noSleep = () => {};

describe('readLedgerFromGit: unreadable is never empty', () => {
  it('returns unreadable when the git call throws (transport unreachable)', () => {
    const run = () => { throw new Error('fatal: unable to access remote'); };
    const r = readLedgerFromGit({ board: '/board', repo: REPO, run });
    expect(r.status).toBe('unreadable');
    expect(r.records).toBeUndefined();
    expect(r.error).toMatch(/unable to access/);
  });

  it('returns ok with zero records only when the tip was read and the file is absent', () => {
    const run = () => ''; // fetch ok, ls-tree lists nothing
    expect(readLedgerFromGit({ board: '/board', repo: REPO, run })).toMatchObject({ status: 'ok', records: [] });
  });

  it('parses the rows of a file that exists', () => {
    const text = `${JSON.stringify(row(7))}\n`;
    const run = (args) => (args[0] === 'ls-tree' ? 'verdict-ledger/x\n' : args[0] === 'show' ? text : '');
    const r = readLedgerFromGit({ board: '/board', repo: REPO, run });
    expect(r.status).toBe('ok');
    expect(r.records).toHaveLength(1);
  });
});

describe('appendLedgerRows: bounded retry, loud on exhaustion', () => {
  const failing = (n) => {
    let pushes = 0;
    const run = (args) => {
      if (args[0] === 'push') { pushes += 1; if (pushes <= n) throw new Error('! [rejected] non-fast-forward'); }
      return args[0] === 'diff' ? 'verdict-ledger/x.jsonl' : '';
    };
    return { run, pushes: () => pushes };
  };
  const base = (over) => ({
    board: '/board', repo: REPO, records: [row(1)], sleep: noSleep, clock: () => 0,
    mkdir: () => {}, write: () => {}, rm: () => {}, read: () => null, now: () => 1, ...over,
  });

  it('retries a rejected push and then succeeds', () => {
    const f = failing(2);
    const retries = [];
    const r = appendLedgerRows(base({ run: f.run, onRetry: (x) => retries.push(x.attempt) }));
    expect(r).toMatchObject({ status: 'appended', attempts: 3 });
    expect(retries).toEqual([1, 2]);
  });

  it('THROWS LedgerAppendExhaustedError when every attempt fails (never a quiet value)', () => {
    const f = failing(99);
    expect(() => appendLedgerRows(base({ run: f.run, attempts: 3 }))).toThrow(LedgerAppendExhaustedError);
    expect(f.pushes()).toBe(3);
  });

  it('default attempt cap is 8', () => {
    expect.soft(DEFAULT_APPEND_ATTEMPTS).toBe(8);
    const f = failing(Infinity);
    expect(() => appendLedgerRows(base({ run: f.run }))).toThrow(LedgerAppendExhaustedError);
    expect(f.pushes()).toBe(8);
  });

  it('backoff grows past the old 1600ms ceiling and is jittered across the whole window', () => {
    const collect = (value) => {
      const f = failing(Infinity);
      const sleeps = [];
      expect(() => appendLedgerRows(base({
        run: f.run, attempts: 8, random: () => value, sleep: (ms) => sleeps.push(ms),
      }))).toThrow(LedgerAppendExhaustedError);
      expect(f.pushes()).toBe(8);
      expect(sleeps).toHaveLength(7); // no sleep after the final failed attempt
      return sleeps;
    };
    // Probe both ends and the middle of the proposed injected random seam. The near-one
    // sample approximates each cap within a millisecond, allowing integer rounding.
    const lower = collect(0);
    const middle = collect(0.5);
    const upper = collect(1 - Number.EPSILON);
    expect.soft(upper.at(-1)).toBeGreaterThan(1600);
    for (let i = 0; i < upper.length; i += 1) {
      const cap = upper[i];
      expect.soft(Number.isFinite(cap)).toBe(true);
      expect.soft(cap).toBeGreaterThan(0);
      if (i > 0) expect.soft(cap).toBeGreaterThanOrEqual(upper[i - 1]);
      expect.soft(Math.abs(lower[i] - cap / 2)).toBeLessThanOrEqual(1);
      expect.soft(Math.abs(middle[i] - cap * 0.75)).toBeLessThanOrEqual(1);
      expect.soft(lower[i]).toBeGreaterThanOrEqual(cap / 2 - 1);
      expect.soft(middle[i]).toBeGreaterThan(lower[i]);
      expect.soft(middle[i]).toBeLessThan(cap);
    }
    // A fixed random stream must reproduce the same waits, without ambient Math.random.
    expect(collect(0.5)).toEqual(middle);
  });

  it('a genuine auth/network failure still throws LedgerAppendExhaustedError after the cap, naming the last error', () => {
    let pushes = 0;
    const failures = [];
    const sleeps = [];
    const run = (args) => {
      if (args[0] === 'push') {
        pushes += 1;
        const error = new Error(`git push failed on attempt ${pushes}: Permission denied (publickey)`);
        error.stderr = `Permission denied (publickey) on attempt ${pushes}`;
        failures.push(error);
        throw error;
      }
      return args[0] === 'diff' ? 'verdict-ledger/x.jsonl' : '';
    };
    let caught;
    try {
      appendLedgerRows(base({ run, attempts: 3, sleep: (ms) => sleeps.push(ms) }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LedgerAppendExhaustedError);
    expect(caught.attempts).toBe(3);
    expect(caught.errors.map(({ message }) => message))
      .toEqual(failures.map(({ stderr }) => expect.stringContaining(stderr)));
    expect(caught.message).toMatch(/last error: .*Permission denied \(publickey\) on attempt 3/);
    expect(pushes).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it.each([0, 0.5, 1])('slow failed attempts set the jitter floor even beyond 6400ms (random=%s)', (random) => {
    let elapsed = 0;
    const waits = [];
    const f = failing(Infinity);
    const run = (args, opts) => {
      if (args[0] === 'fetch') elapsed += 20_000;
      return f.run(args, opts);
    };
    expect(() => appendLedgerRows(base({
      run, attempts: 3, clock: () => elapsed, random: () => random,
      sleep: (ms) => { waits.push(ms); elapsed += ms; },
    }))).toThrow(LedgerAppendExhaustedError);
    expect(waits).toEqual([20_000 * (1 + random), 20_000 * (1 + random)]);
    expect(f.pushes()).toBe(3);
  });

  it('the duration-scaled backoff is capped at 60s so the retry never waits unboundedly', () => {
    let elapsed = 0;
    const waits = [];
    const f = failing(Infinity);
    const run = (args, opts) => {
      if (args[0] === 'fetch') elapsed += 600_000;
      return f.run(args, opts);
    };
    expect(() => appendLedgerRows(base({
      run, attempts: 3, clock: () => elapsed, random: () => 1,
      sleep: (ms) => { waits.push(ms); elapsed += ms; },
    }))).toThrow(LedgerAppendExhaustedError);
    expect(waits).toEqual([60_000, 60_000]);
  });

  it('accepts a v2 event row (ruling, send-back) with the same validation', () => {
    const f = failing(0);
    const at = '2026-10-07T12:00:00.000Z';
    const records = [
      buildLedgerEvent({ type: 'ruling', repo: REPO, pr: 1, at, source: 'test', findingKey: 'f1', ruling: 'block' }),
      buildLedgerEvent({ type: 'send-back', repo: REPO, pr: 1, at, source: 'test', cause: 'block-ruling' }),
    ];
    expect(appendLedgerRows(base({ run: f.run, records }))).toMatchObject({ status: 'appended', rows: 2 });
    expect(() => appendLedgerRows(base({ run: f.run, records: [{ ...records[0], ruling: 'maybe' }] }))).toThrow(/invalid record/);
  });

  it('refuses an invalid record before touching git', () => {
    const run = () => { throw new Error('git must not be called'); };
    expect(() => appendLedgerRows(base({ run, records: [{ nope: true }] }))).toThrow(/invalid record/);
  });

  // THE REFSPEC GUARD (operator decision 2026-10-08): the applier workflow holds `contents: write`, so the one
  // push path may write refs/heads/ops/review-requests and nothing else - no other branch, no force.
  describe('push-ref guard: only refs/heads/ops/review-requests, never forced', () => {
    const bad = ['main', 'lane/x', 'refs/heads/main', 'refs/heads/ops/review-requests', '+ops/review-requests',
      'ops/review-requests:main', 'ops/review-requests main', '--force', 'ops/review-requests-2', 'ops/'];
    for (const branch of bad) {
      it(`refuses branch ${JSON.stringify(branch)} before any git call`, () => {
        const calls = [];
        const run = (args) => { calls.push(args); return ''; };
        expect(() => appendLedgerRows(base({ run, branch }))).toThrow(/refusing to push/);
        expect(calls).toEqual([]);
      });
    }

    it('pushes the full ref and never a force', () => {
      const f = failing(0);
      const calls = [];
      const run = (args, o) => { calls.push(args); return f.run(args, o); };
      appendLedgerRows(base({ run }));
      const push = calls.find((a) => a[0] === 'push');
      expect(push).toEqual(['push', '--quiet', 'origin', 'HEAD:refs/heads/ops/review-requests']);
      for (const a of calls.filter((c) => c[0] === 'push').flat()) expect(a).not.toMatch(/^(-f|--force.*|\+.*)$/);
    });

    it('a caller cannot loosen the allowed ref through the passed-through seams', () => {
      const run = () => '';
      expect(() => appendLedgerRows(base({ run, allowRef: 'refs/heads/main', branch: 'main' }))).toThrow(/refusing to push/);
    });
  });
});

/** A second working clone of the same bare origin. */
const cloneOf = (ctx, name) => {
  const dir = join(ctx.tmp, name);
  git(['clone', '--quiet', ctx.origin, dir], { cwd: ctx.tmp });
  writeLocalIdentity(dir);
  return dir;
};

describe('real git', () => {
  it.each([false, true])('slow repeated push races: duration-aware waits=%s', async (adaptive) => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const rival = cloneOf(ctx, 'slow-rival');
      // Model loaded attempt time without sleeping on the host. Git operations and push
      // rejections are real; only elapsed time and the competing writers' quiet window
      // are controlled. Rivals keep arriving until we yield one whole attempt duration.
      const duration = 10_000;
      let elapsed = 0;
      let quiet = 0;
      let pushes = 0;
      const rejected = [];
      const waits = [];
      const run = (args, opts) => {
        if (args[0] === 'fetch') elapsed += duration;
        if (args[0] === 'push') {
          pushes++;
          expect(args).toEqual(['push', '--quiet', 'origin', 'HEAD:refs/heads/ops/review-requests']);
          if (quiet < duration) {
            appendLedgerRows({ board: rival, repo: REPO, records: [row(100 + pushes)], sleep: noSleep });
          }
        }
        try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }
        catch (e) { if (args[0] === 'push') rejected.push(String(e.stderr)); throw e; }
      };
      const append = () => appendLedgerRows({
        board: ctx.clone, repo: REPO, records: [row(200)], run,
        clock: () => elapsed, random: () => 0,
        sleep: (ms) => {
          // Retain an executable witness of the old policy: its longest wait is
          // still shorter than one loaded attempt, so all eight real pushes lose.
          quiet = adaptive ? ms : Math.min(ms, 3200);
          waits.push(quiet);
          elapsed += quiet;
        },
      });
      if (adaptive) {
        expect(append()).toMatchObject({ status: 'appended', attempts: 2 });
        expect(waits[0]).toBeGreaterThanOrEqual(duration);
      } else {
        let failure;
        try { append(); } catch (e) { failure = e; }
        expect(failure).toBeInstanceOf(LedgerAppendExhaustedError);
        expect(appendGitRowsSync([row(200)], { repo: REPO }, {
          appendRows: () => { throw failure; },
        })).toMatchObject({ ok: false, appended: 0, error: expect.stringMatching(/\[rejected\].*fetch first/) });
        expect(pushes).toBe(8);
      }
      expect(rejected).toHaveLength(adaptive ? 1 : 8);
      for (const error of rejected) expect(error).toMatch(/rejected/);
      const landed = ctx.showOnOrigin(LEDGER_TRANSPORT_BRANCH, ledgerGitPath(REPO))
        .trim().split('\n').map(JSON.parse);
      expect(landed.map(({ pr }) => pr)).toEqual(adaptive ? [101, 200] : [101, 102, 103, 104, 105, 106, 107, 108]);
      expect(new Set(landed.map(({ id }) => id)).size).toBe(landed.length);
    });
  }, 30_000);

  it('appends, and reads back through a different clone', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(1), row(2)] });
      const other = cloneOf(ctx, 'other');
      const r = readLedgerFromGit({ board: other, repo: REPO });
      expect(r.status).toBe('ok');
      expect(r.records.map((x) => x.pr)).toEqual([1, 2]);
    });
  });

  it('TWO WRITERS: one rejected push, a retry, and a third clone sees both rows', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const clientA = ctx.clone;
      const clientB = cloneOf(ctx, 'writer-b');
      const third = cloneOf(ctx, 'third');

      // Writer B reads the tip, then - just before its first push - writer A lands a row. B's push is rejected.
      let rivalDone = false;
      let rejected = 0;
      const run = (args, opts) => {
        if (args[0] === 'push' && !rivalDone) {
          rivalDone = true;
          appendLedgerRows({ board: clientA, repo: REPO, records: [row(100)] });
        }
        try {
          return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
        } catch (e) {
          if (args[0] === 'push') rejected += 1;
          throw e;
        }
      };
      const retries = [];
      const r = appendLedgerRows({ board: clientB, repo: REPO, records: [row(200)], run, sleep: noSleep, onRetry: (x) => retries.push(x.attempt) });

      expect(rejected).toBe(1);
      expect(retries).toEqual([1]);
      expect(r.attempts).toBe(2);
      const seen = readLedgerFromGit({ board: third, repo: REPO });
      expect(seen.status).toBe('ok');
      expect(seen.records.map((x) => x.pr).sort()).toEqual([100, 200]);
      // The origin's file holds exactly two rows: no row was overwritten, none duplicated.
      expect(ctx.showOnOrigin(LEDGER_TRANSPORT_BRANCH, ledgerGitPath(REPO)).trim().split('\n')).toHaveLength(2);
    });
  });

  it('SIX LOST RACES: a writer that loses 6 pushes in a row still lands, and every rival row survives', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const rival = cloneOf(ctx, 'six-races-rival');
      const records = Array.from({ length: 7 }, (_, i) => row(100 + i));
      let pushes = 0;
      let rejected = 0;
      const run = (args, opts) => {
        if (args[0] === 'push') {
          pushes += 1;
          expect(args).toEqual(['push', '--quiet', 'origin', 'HEAD:refs/heads/ops/review-requests']);
          if (pushes <= 6) {
            appendLedgerRows({ board: rival, repo: REPO, records: [records[pushes - 1]], sleep: noSleep });
          }
        }
        try {
          return git(args, opts);
        } catch (error) {
          if (args[0] === 'push') rejected += 1;
          throw error;
        }
      };
      const retries = [];
      // Leave attempts omitted: sustained contention must succeed under the default policy.
      const result = appendLedgerRows({
        board: ctx.clone, repo: REPO, records: [records[6]], run, sleep: noSleep,
        onRetry: ({ attempt }) => retries.push(attempt),
      });
      expect(result).toMatchObject({ status: 'appended', attempts: 7, rows: 1, duplicates: 0 });
      expect(pushes).toBe(7);
      expect(rejected).toBe(6);
      expect(retries).toEqual([1, 2, 3, 4, 5, 6]);
      const landed = ctx.showOnOrigin(LEDGER_TRANSPORT_BRANCH, ledgerGitPath(REPO))
        .trim().split('\n').map((line) => JSON.parse(line));
      expect(landed).toHaveLength(7);
      expect(landed.map(({ pr }) => pr).sort((a, b) => a - b)).toEqual(records.map(({ pr }) => pr));
      // Re-appending the same records proves the origin retains each record id exactly once.
      expect(appendLedgerRows({ board: rival, repo: REPO, records, sleep: noSleep }))
        .toMatchObject({ rows: 0, duplicates: 7 });
    });
  });

  it('an unreachable transport reads as unreadable, never empty', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      git(['remote', 'set-url', 'origin', join(ctx.tmp, 'does-not-exist.git')], { cwd: ctx.clone });
      const r = readLedgerFromGit({ board: ctx.clone, repo: REPO });
      expect(r.status).toBe('unreadable');
      expect(r.records).toBeUndefined();
    });
  });

  it('an absent transport branch is unreadable, not an empty ledger', async () => {
    await withBareOrigin(async (ctx) => {
      expect(readLedgerFromGit({ board: ctx.clone, repo: REPO }).status).toBe('unreadable');
    });
  });

  it('an unreachable transport makes append throw loudly', async () => {
    await withBareOrigin(async (ctx) => {
      git(['remote', 'set-url', 'origin', join(ctx.tmp, 'does-not-exist.git')], { cwd: ctx.clone });
      expect(() => appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(1)], attempts: 2, sleep: noSleep }))
        .toThrow(LedgerAppendExhaustedError);
    });
  });
});


describe('idempotent git writes', () => {
  it('duplicate-only append makes no commit or push, including legacy unstamped rows', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { [ledgerGitPath(REPO)]: JSON.stringify(row(1)) + '\n' });
      const calls = [];
      const run = (args, opts) => { calls.push(args[0]); return git(args, opts); };
      const result = appendGitRowsSync([row(1), row(1)], { board: ctx.clone, repo: REPO, run });
      expect(result).toEqual({ ok: true, appended: 0, duplicates: 2 });
      expect(calls).not.toContain('commit');
      expect(calls).not.toContain('push');
      expect(readLedgerFromGit({ board: ctx.clone, repo: REPO }).records).toHaveLength(1);
    });
  });

  it('a retry recomputes duplicates against the new tip', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const other = cloneOf(ctx, 'idempotent-rival');
      let raced = false;
      let pushes = 0;
      const run = (args, opts) => {
        if (args[0] === 'push') {
          pushes++;
          if (!raced) {
            raced = true;
            // A distinct commit message prevents identical rows in the same second producing the same commit.
            appendLedgerRows({ board: other, repo: REPO, records: [row(1)], message: 'rival append' });
          }
        }
        return git(args, opts);
      };
      const result = appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(1)], run, sleep: noSleep });
      expect(result).toEqual({ status: 'appended', attempts: 2, rows: 0, duplicates: 1 });
      expect(pushes).toBe(1);
      expect(readLedgerFromGit({ board: other, repo: REPO }).records).toHaveLength(1);
    });
  });

  it('sync helper contains throws and async read contains a throwing transport seam', async () => {
    expect(appendGitRowsSync([{}], { repo: REPO })).toMatchObject({ ok: false, appended: 0 });
    const store = createGitLedgerStore({ readRows: () => { throw new Error('offline'); } });
    await expect(store.read({ repo: REPO })).resolves.toMatchObject({ status: 'unreadable', error: 'offline' });
  });
});

/** A ledger text of `bytes`+ bytes of valid rows (the live web-everything ledger passed 1 MiB on 2026-10-10). */
const bigLedger = (bytes) => {
  const lines = [];
  let size = 0;
  for (let pr = 1; size < bytes; pr += 1) {
    const line = JSON.stringify(row(pr, { note: 'x'.repeat(120) }));
    lines.push(line);
    size += line.length + 1;
  }
  return { text: `${lines.join('\n')}\n`, rows: lines.length };
};

describe('ledger read cap: a setting through the cascade, source named', () => {
  it('defaults to the standard cap', () => {
    const s = resolveLedgerReadSettings({ repo: {}, env: {} });
    expect(s).toMatchObject({ maxBytes: DEFAULT_LEDGER_READ_MAX_BYTES, sources: { maxBytes: 'standard' }, invalid: [] });
    expect(DEFAULT_LEDGER_READ_MAX_BYTES).toBeGreaterThan(1024 * 1024);
  });

  it('repo settings override the standard; env overrides repo; the source is named', () => {
    const repo = { verdictLedger: { readMaxBytes: 5_000_000 } };
    expect(resolveLedgerReadSettings({ repo, env: {} })).toMatchObject({ maxBytes: 5_000_000, sources: { maxBytes: 'repo' } });
    const both = resolveLedgerReadSettings({ repo, env: { [LEDGER_READ_MAX_BYTES_ENV]: '7000000' } });
    expect(both).toMatchObject({ maxBytes: 7_000_000, sources: { maxBytes: 'env' } });
    expect(formatLedgerReadSettings(both)).toMatch(/verdictLedger\.readMaxBytes=7000000 \(env\)/);
  });

  it('an invalid layer is ignored and reported; the layer below answers', () => {
    const s = resolveLedgerReadSettings({ repo: { verdictLedger: { readMaxBytes: -1 } }, env: { [LEDGER_READ_MAX_BYTES_ENV]: 'lots' } });
    expect(s).toMatchObject({ maxBytes: DEFAULT_LEDGER_READ_MAX_BYTES, sources: { maxBytes: 'standard' } });
    expect(s.invalid).toEqual(['repo.verdictLedger.readMaxBytes', `env.${LEDGER_READ_MAX_BYTES_ENV}`]);
  });
});

describe('sizedLedgerRun: the blob read buffer is sized to the blob, bounded by the cap', () => {
  const fakeExec = (size, text = 'x') => {
    const calls = [];
    const exec = (args, opts = {}) => {
      calls.push({ args, maxBuffer: opts.maxBuffer });
      if (args[0] === 'rev-parse') return 'abc123\n';
      if (args[0] === 'cat-file' && args[1] === '-s') return `${size}\n`;
      if (args[0] === 'cat-file' && args[1] === 'blob') return text;
      return '';
    };
    return { exec, calls };
  };

  it('reads the blob by its object id with a buffer that fits it', () => {
    const f = fakeExec(3_000_000);
    const run = sizedLedgerRun({ maxBytes: 10_000_000, exec: f.exec });
    run(['show', 'origin/ops/review-requests:verdict-ledger/x.jsonl'], { cwd: '/b' });
    const blob = f.calls.find((c) => c.args[1] === 'blob');
    expect(blob.args).toEqual(['cat-file', 'blob', 'abc123']);
    expect(blob.maxBuffer).toBeGreaterThan(3_000_000);
    expect(blob.maxBuffer).toBeLessThan(3_000_000 * 2);
  });

  it('a blob over the cap THROWS (the reader reports unreadable) and is never read', () => {
    const f = fakeExec(20_000_000);
    const run = sizedLedgerRun({ maxBytes: 10_000_000, exec: f.exec, source: 'env' });
    expect(() => run(['show', 'origin/b:p'], { cwd: '/b' })).toThrow(/20000000 bytes.*exceeds.*10000000.*\(env\)/);
    expect(f.calls.some((c) => c.args[1] === 'blob')).toBe(false);
  });

  it('an unparseable size throws instead of guessing', () => {
    const f = fakeExec('nonsense');
    expect(() => sizedLedgerRun({ maxBytes: 10, exec: f.exec })(['show', 'origin/b:p'], {})).toThrow(/size/);
  });

  it('other git calls pass straight through', () => {
    const f = fakeExec(1);
    sizedLedgerRun({ maxBytes: 10, exec: f.exec })(['fetch', '--quiet', 'origin', 'x'], { cwd: '/b' });
    expect(f.calls.map((c) => c.args[0])).toEqual(['fetch']);
  });
});

describe('real git: a ledger larger than the 1 MiB default buffer (live ENOBUFS, 2026-10-10)', () => {
  it('reads a >1 MiB ledger as ok with every row, not unreadable (spawnSync git ENOBUFS)', async () => {
    const big = bigLedger(1.5 * 1024 * 1024);
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { [ledgerGitPath(REPO)]: big.text });
      const r = readLedgerFromGit({ board: ctx.clone, repo: REPO, log: () => {} });
      expect(r.error).toBeUndefined();
      expect(r.status).toBe('ok');
      expect(r.records).toHaveLength(big.rows);
      const store = await createGitLedgerStore().read({ board: ctx.clone, repo: REPO, log: () => {} });
      expect(store.status).toBe('ok');
      expect(store.rows).toHaveLength(big.rows);
    });
  });

  it('a ledger over the configured cap is unreadable with the cap and its source named', async () => {
    const big = bigLedger(300 * 1024);
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { [ledgerGitPath(REPO)]: big.text });
      const logs = [];
      const r = readLedgerFromGit({ board: ctx.clone, repo: REPO, env: { [LEDGER_READ_MAX_BYTES_ENV]: '100000' }, settings: {}, log: (l) => logs.push(l) });
      expect(r.status).toBe('unreadable');
      expect(r.reason).toBe('ledger-exceeds-read-cap');
      expect(r.error).toMatch(/exceeds.*100000.*\(env\)/);
      expect(logs.join('\n')).toMatch(/verdictLedger\.readMaxBytes=100000 \(env\)/);
    });
  });
});
