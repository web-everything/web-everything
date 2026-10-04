/**
 * @file scripts/conveyor/__tests__/ci-heal-owed.test.mjs
 * @description Pins the owed-write primitive's own edges (we:backlog/4352): which failures count as a budget
 *   refusal, how a CLI's target repo resolves without a GitHub read, what a record must carry, and that a
 *   malformed file on the shared host dir is skipped rather than breaking every tick's flush. The end-to-end
 *   flush (post / dedupe / moot / bound) is pinned through its real caller in `ci-heal-pr-dispatch.test.mjs`.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isBudgetRefusal, resolveOwedRepo, recordOwedWrite, readOwedWrites, clearOwedWrite, owedWriteAlreadyLive, owedDir, flushOwedWrites,
} from '../ci-heal-owed.mjs';
import { budgetBlockedMessage } from '../../lib/gh-throttle.mjs';

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';

describe('isBudgetRefusal', () => {
  it('reads gh-throttle budget_blocked (thrown or stderr-only) and a raw GitHub rate limit as budget refusals', () => {
    expect(isBudgetRefusal(Object.assign(new Error('x'), { budgetBlocked: { resource: 'graphql' } }))).toBe(true);
    expect(isBudgetRefusal({ message: 'Command failed', stderr: budgetBlockedMessage({ resource: 'graphql', until: 'soon' }) })).toBe(true);
    expect(isBudgetRefusal(new Error('GraphQL: API rate limit exceeded for installation ID 1'))).toBe(true);
  });

  it('does not read an ordinary failure (404, auth, network) as a budget refusal', () => {
    expect(isBudgetRefusal(new Error('HTTP 404: Not Found'))).toBe(false);
    expect(isBudgetRefusal(new Error('gh: To use GitHub CLI, please authenticate'))).toBe(false);
    expect(isBudgetRefusal(null)).toBe(false);
  });
});

describe('resolveOwedRepo', () => {
  it('a --repo slug or key resolves to the constellation key + canonical slug', () => {
    expect(resolveOwedRepo({ repoFlag: 'web-everything/web-everything' })).toEqual({ key: 'we', slug: 'web-everything/web-everything' });
    expect(resolveOwedRepo({ repoFlag: 'plateau-app' })).toEqual({ key: 'plateau-app', slug: 'plateauapp/plateau-app' });
  });

  it('without --repo, reads the LOCAL origin remote (ssh or https), never GitHub', () => {
    expect(resolveOwedRepo({ exec: () => 'git@github.com:frontier-ui/frontierui.git\n' })).toEqual({ key: 'frontierui', slug: 'frontier-ui/frontierui' });
    expect(resolveOwedRepo({ exec: () => 'https://github.com/web-everything/web-everything\n' })).toEqual({ key: 'we', slug: 'web-everything/web-everything' });
  });

  it('a repo outside the constellation, or no remote at all, is null', () => {
    expect(resolveOwedRepo({ repoFlag: 'someone/else' })).toBeNull();
    expect(resolveOwedRepo({ exec: () => { throw new Error('no remote'); } })).toBeNull();
  });
});

describe('recordOwedWrite / readOwedWrites / clearOwedWrite', () => {
  const base = { repo: 'we', slug: 'web-everything/web-everything', pr: 5, kind: 'ci-heal', headSha: HEAD, body: 'b' };

  it('one file per (repo, pr, kind): a repeat refusal refreshes the same record, a different kind is its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owed-'));
    try {
      recordOwedWrite(base, { dir });
      recordOwedWrite({ ...base, body: 'newer' }, { dir });
      recordOwedWrite({ ...base, kind: 'ci-heal-escalation' }, { dir });
      const all = readOwedWrites({ dir });
      expect(all).toHaveLength(2);
      expect(all.find((r) => r.kind === 'ci-heal').body).toBe('newer');
      clearOwedWrite(all[0], { dir });
      clearOwedWrite(all[0], { dir }); // idempotent
      expect(readOwedWrites({ dir })).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a kind outside OWED_KINDS (advisory-fix is deliberately not one) and a record with no head', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owed-'));
    try {
      expect(() => recordOwedWrite({ ...base, kind: 'advisory-fix' }, { dir })).toThrow(/kind/);
      expect(() => recordOwedWrite({ ...base, headSha: '' }, { dir })).toThrow(/headSha/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a malformed file in the shared dir is skipped, not thrown; a missing dir reads as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owed-'));
    try {
      writeFileSync(join(dir, 'garbage.json'), '{not json');
      recordOwedWrite(base, { dir });
      expect(readOwedWrites({ dir })).toHaveLength(1);
      expect(readOwedWrites({ dir: join(dir, 'nope') })).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('lives under the gh-throttle lock root', () => {
    expect(owedDir({ WE_GH_THROTTLE_LOCK_ROOT: '/tmp/lr' })).toBe('/tmp/lr/ci-heal-owed');
  });
});

describe('owedWriteAlreadyLive', () => {
  const rec = { kind: 'ci-heal', headSha: HEAD, body: 'MARK\nhead: ' + HEAD + '\n\nbody' };
  it('matches only a TRUSTED, marker-leading comment for the SAME head', () => {
    expect(owedWriteAlreadyLive([{ body: rec.body, author: { login: 'web-everything' } }], rec)).toBe(true);
    expect(owedWriteAlreadyLive([{ body: rec.body, author: { login: 'mallory' } }], rec)).toBe(false);
    expect(owedWriteAlreadyLive([{ body: `> ${rec.body}`, author: { login: 'web-everything' } }], rec)).toBe(false);
    expect(owedWriteAlreadyLive([{ body: 'MARK\n\nno head line', author: { login: 'web-everything' } }], rec)).toBe(false);
  });
});

describe('readOwedWrites — repo/slug consistency guard', () => {
  const base = { repo: 'we', slug: 'web-everything/web-everything', pr: 5, kind: 'ci-heal', headSha: HEAD, body: 'b' };
  const withTmp = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'owed-'));
    try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  /** Persist a canonical record, then overwrite its file with `mutate(record)` — tampering on disk, not via the writer. */
  const tamper = (dir, mutate, rec = base) => {
    const written = recordOwedWrite(rec, { dir });
    const file = join(dir, `${rec.repo}__${rec.pr}__${rec.kind}.json`);
    writeFileSync(file, JSON.stringify(mutate({ ...written })) + '\n');
    return file;
  };

  it.each([
    ['an outside slug', { slug: 'outsider/wrong' }],
    ['another constellation repo slug', { slug: 'frontier-ui/frontierui' }],
    ['a case-variant slug', { slug: 'Chalbert/Web-Everything' }],
    ['a missing slug', { slug: undefined }],
    ['an empty slug', { slug: '' }],
    ['a non-string slug', { slug: 42 }],
    ['an unknown repo key with a missing slug', { repo: 'nope', slug: undefined }],
    ['an unknown repo key', { repo: 'nope' }],
    ['a missing repo key', { repo: undefined }],
    ['a non-string repo key', { repo: 7 }],
    ['an inherited-property repo key (toString)', { repo: 'toString', slug: undefined }],
    ['an inherited-property repo key (__proto__)', { repo: '__proto__', slug: undefined }],
  ])('skips a record with %s, with and without the repo filter, keeping a valid neighbour', (_label, patch) => {
    withTmp((dir) => {
      tamper(dir, (r) => ({ ...r, ...patch }));
      recordOwedWrite({ ...base, pr: 6 }, { dir });
      expect(readOwedWrites({ dir }).map((r) => r.pr)).toEqual([6]);
      expect(readOwedWrites({ dir, repo: 'we' }).map((r) => r.pr)).toEqual([6]);
      if (typeof patch.repo === 'string') expect(readOwedWrites({ dir, repo: patch.repo })).toEqual([]);
    });
  });

  it.each([
    ['we', 'web-everything/web-everything'],
    ['frontierui', 'frontier-ui/frontierui'],
    ['plateau-app', 'plateauapp/plateau-app'],
  ])('accepts the canonical %s record for both kinds and keeps the repo filter', (repo, slug) => {
    withTmp((dir) => {
      for (const kind of ['ci-heal', 'ci-heal-escalation']) recordOwedWrite({ ...base, repo, slug, kind }, { dir });
      const all = readOwedWrites({ dir });
      expect(all).toHaveLength(2);
      for (const r of all) expect(r).toMatchObject({ repo, slug, pr: 5, headSha: HEAD, body: 'b' });
      expect(readOwedWrites({ dir, repo })).toHaveLength(2);
      expect(readOwedWrites({ dir, repo: repo === 'we' ? 'frontierui' : 'we' })).toEqual([]);
    });
  });

  it('flush on a tampered-only dir makes zero gh calls, reports nothing, and leaves the file untouched', () => {
    withTmp((dir) => {
      const file = tamper(dir, (r) => ({ ...r, slug: 'outsider/wrong' }));
      const before = readFileSync(file, 'utf8');
      const calls = [];
      const res = flushOwedWrites({ repo: 'we', dir, exec: (...a) => { calls.push(a); return '{}'; } });
      expect(calls).toHaveLength(0);
      expect(res).toEqual({ posted: [], cleared: [], dropped: [], kept: [] });
      expect(readFileSync(file, 'utf8')).toBe(before);
    });
  });

  it('control: flush on a canonical record reads and posts through the canonical slug, then clears', () => {
    withTmp((dir) => {
      recordOwedWrite(base, { dir });
      const calls = [];
      const exec = (cmd, args) => { calls.push(args); return args[1] === 'view' ? JSON.stringify({ state: 'OPEN', comments: [] }) : ''; };
      const res = flushOwedWrites({ repo: 'we', dir, exec });
      expect(res.posted).toHaveLength(1);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('web-everything/web-everything');
      expect(calls[1]).toContain('--repo=web-everything/web-everything');
      expect(readOwedWrites({ dir })).toEqual([]);
    });
  });
});


it('xp0lsdi: distinct attempt writes survive repeated failures and never age out uncounted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owed-attempts-'));
  try {
    for (const attemptId of ['one', 'two']) recordOwedWrite({ repo: 'we', slug: 'web-everything/web-everything', pr: 3373, kind: 'ci-heal', headSha: HEAD,
      attemptId, body: `🩹 conveyor CI-heal — failed attempt\nhead: ${HEAD}\nattempt: ${attemptId}` }, { dir, now: 1 });
    expect(readOwedWrites({ dir })).toHaveLength(2);
    const records = readOwedWrites({ dir });
    expect(owedWriteAlreadyLive([{ body: records[0].body, author: { login: 'web-everything' } }], records[1])).toBe(false);
    const out = flushOwedWrites({ dir, repo: 'we', now: 99_999_999, maxAgeMs: 1, maxAttempts: 0,
      exec: () => { throw new Error('unreachable'); } });
    expect(out.kept).toHaveLength(2);
    expect(out.dropped).toHaveLength(0);
    expect(readOwedWrites({ dir })).toHaveLength(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
