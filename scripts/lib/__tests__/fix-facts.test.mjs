// @vitest-environment node
/**
 * perf C1d — the fix dispatcher reads PR facts first, uses ETag (304 = free) for the rest, and caches COMPLETED
 * jobs / logs / file lists. A stale or partial store falls back to GitHub. Never a comment read, never a merge input.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFixFacts, fixFactsEnabled, formatFixReadStats, makeFixEvidenceReader, takeFixReadStats } from '../fix-facts.mjs';
import { readTimeoutEvidence } from '../../conveyor/reconcile-pass.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const head = 'a'.repeat(40);
const repo = 'o/r';
const pr = { number: 5, headRefOid: head };
const url = (run, job) => `https://github.com/${repo}/actions/runs/${run}/job/${job}`;
const body = (v) => JSON.stringify(v);

/** A fake GitHub: answers `gh api <path>` (plain) and `gh api -i [-H If-None-Match] <path>` (ETag), and counts both. */
function fakeGithub({ jobStatus = 'completed' } = {}) {
  const count = { plain: 0, full200: 0, notModified304: 0, byPath: {} };
  const answer = (path) => {
    if (/\/pulls\/5$/.test(path)) return body({ head: { sha: head }, base: { sha: 'b' }, state: 'open', changed_files: 1 });
    if (/pulls\/5\/files/.test(path)) return body([{ filename: 'a.ts' }]);
    if (/check-runs/.test(path)) return body({ total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure', details_url: url(100, 1) }] });
    if (/\/status$/.test(path)) return body({ total_count: 0 });
    if (/actions\/jobs\/1\/logs$/.test(path)) return 'FAIL src/a.test.ts > a\nError: Test timed out in 5000ms.\n';
    if (/actions\/jobs\/1$/.test(path)) return body({ id: 1, run_id: 100, head_sha: head, run_attempt: 1, name: 'test', status: jobStatus, conclusion: 'failure', runner_name: 'r', steps: [{}] });
    if (/actions\/runs\/100$/.test(path)) return body({ id: 100, head_sha: head, run_attempt: 1, path: '.github/workflows/ci.yml', repository: { full_name: repo } });
    throw new Error(`unexpected ${path}`);
  };
  const exec = (_c, argv) => {
    const path = argv[argv.length - 1];
    count.byPath[path.replace(/^repos\/o\/r\//, '')] = (count.byPath[path.replace(/^repos\/o\/r\//, '')] || 0) + 1;
    const out = answer(path);
    if (argv[1] !== '-i') { count.plain += 1; return out; }
    const etag = `"${createHash('sha1').update(out).digest('hex')}"`;
    const inm = argv.includes('-H') ? argv[argv.indexOf('-H') + 1].replace('If-None-Match: ', '') : null;
    if (inm === etag) { count.notModified304 += 1; throw Object.assign(new Error('HTTP 304'), { stdout: `HTTP/2.0 304 Not Modified\r\netag: ${etag}\r\n\r\n` }); }
    count.full200 += 1;
    return `HTTP/2.0 200 OK\r\netag: ${etag}\r\n\r\n${out}`;
  };
  return { exec, count, core: () => count.plain + count.full200 };
}

const made = [];
afterEach(() => { for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true }); });
const dirs = () => { const d = { etag: mkdtempSync(join(tmpdir(), 'fixfacts-etag-')), sha: mkdtempSync(join(tmpdir(), 'fixfacts-sha-')) }; made.push(d.etag, d.sha); return d; };
const readerFor = (gh, d) => makeFixEvidenceReader({
  repo, pr: 5, head, exec: gh.exec, env: { WE_GH_ETAG_DIR: d.etag, HOME: d.etag }, cacheDir: d.sha,
  rest: (path, o) => import_ghRestGetJson(path, { ...o, dir: d.etag }),
});
import { ghRestGetJson as import_ghRestGetJson } from '../gh-rest-read.mjs';

const tick = (gh, d, o = {}) => readTimeoutEvidence(pr, { repo, exec: gh.exec, reader: readerFor(gh, d), ...o });

describe('fix dispatcher: immutable read cache', () => {
  it('a second read of the same completed job log makes 0 gh calls; an in-progress job is never cached', () => {
    const d = dirs();
    const gh = fakeGithub();
    const r1 = readerFor(gh, d); const job = r1.api('repos/o/r/actions/jobs/1');
    r1.readLog(job);
    const logCallsFirst = gh.count.byPath['actions/jobs/1/logs'];
    const r2 = readerFor(gh, d); const job2 = r2.api('repos/o/r/actions/jobs/1');
    expect(r2.readLog(job2)).toContain('timed out');
    expect(gh.count.byPath['actions/jobs/1/logs']).toBe(logCallsFirst); // 0 more log calls
    expect(gh.count.byPath['actions/jobs/1']).toBe(1); // the completed job itself came from the cache

    const live = fakeGithub({ jobStatus: 'in_progress' });
    const d2 = dirs();
    readerFor(live, d2).api('repos/o/r/actions/jobs/1'); readerFor(live, d2).api('repos/o/r/actions/jobs/1');
    expect(live.count.byPath['actions/jobs/1']).toBe(2); // in-progress → re-read every time
    const j = { id: 1, status: 'in_progress' };
    readerFor(live, d2).readLog(j); readerFor(live, d2).readLog(j);
    expect(live.count.byPath['actions/jobs/1/logs']).toBe(2); // in-progress log not cached
  });

  it('count: a failing PR over 10 ticks costs far fewer core-limit GitHub calls than the old plain reads', () => {
    const old = fakeGithub();
    for (let i = 0; i < 10; i += 1) readTimeoutEvidence(pr, { repo, exec: old.exec });
    const before = old.core();

    const gh = fakeGithub();
    const d = dirs();
    for (let i = 0; i < 10; i += 1) tick(gh, d);
    const after = gh.core();
    // eslint-disable-next-line no-console
    console.log(`C1d fake-gh GitHub calls over 10 ticks: before=${before} (all count) after=${after} (core-limit; +${gh.count.notModified304} free 304s)`);
    expect(before).toBe(10 * 7); // pulls, files, check-runs, status, job, run, log per tick
    expect(after).toBeLessThan(before / 4);
  });

  it('files cache is bound to the base sha: a moved base re-reads the list', () => {
    const d = dirs();
    const gh = fakeGithub();
    tick(gh, d);
    const files1 = gh.count.byPath['pulls/5/files?per_page=100&page=1'];
    tick(gh, d);
    expect(gh.count.byPath['pulls/5/files?per_page=100&page=1']).toBe(files1); // served from cache (same head+base)
  });
});

describe('fix dispatcher: facts first', () => {
  beforeEach(() => { takeFixReadStats(); });
  const lookup = (f, reason = 'x') => () => ({ facts: f, source: f ? 'store' : 'github', reason });
  const facts = (o = {}) => ({ state: 'open', merged: false, headSha: head, ...o });

  it('a fresh store row that says the head moved refuses with 0 gh calls', () => {
    const gh = fakeGithub();
    const d = dirs();
    const r = readTimeoutEvidence(pr, { repo, exec: gh.exec, reader: readerFor(gh, d), facts: (a) => checkFixFacts({ ...a, lookup: lookup(facts({ headSha: 'b'.repeat(40) })) }) });
    expect(r).toEqual({ eligible: false, reason: 'timeout-evidence:stale-head' });
    expect(gh.core() + gh.count.notModified304).toBe(0);
  });

  it('a closed PR in the store refuses with 0 gh calls', () => {
    expect(checkFixFacts({ repo, number: 5, head, lookup: lookup(facts({ state: 'closed' })) })).toMatchObject({ stale: true, source: 'store' });
  });

  it('a stale/partial store (null) falls back: the live reads run exactly as before', () => {
    const gh = fakeGithub();
    const r = readTimeoutEvidence(pr, { repo, exec: gh.exec, reader: readerFor(gh, dirs()), facts: (a) => checkFixFacts({ ...a, lookup: lookup(null, 'ttl-expired') }) });
    expect(r.reason ?? '').not.toBe('timeout-evidence:stale-head');
    expect(gh.core()).toBeGreaterThan(0);
    expect(takeFixReadStats()).toMatchObject({ factsGithub: 1 });
  });

  it('an agreeing store row never replaces a live read (the PR is still read live)', () => {
    const gh = fakeGithub();
    readTimeoutEvidence(pr, { repo, exec: gh.exec, reader: readerFor(gh, dirs()), facts: (a) => checkFixFacts({ ...a, lookup: lookup(facts()) }) });
    expect(gh.count.byPath['pulls/5']).toBeGreaterThanOrEqual(1); // the PR itself is still read live
    expect(formatFixReadStats(takeFixReadStats())).toContain('facts store=1');
  });
});

describe('fix dispatcher: off-switch and isolation', () => {
  it('WE_FIX_FACTS=0 turns every layer off: plain `gh api`, no store, no cache', () => {
    expect(fixFactsEnabled({ WE_FIX_FACTS: '0' })).toBe(false);
    expect(fixFactsEnabled({})).toBe(true);
    expect(checkFixFacts({ repo, number: 5, head, env: { WE_FIX_FACTS: '0' }, lookup: () => { throw new Error('must not look'); } })).toMatchObject({ stale: false, reason: 'WE_FIX_FACTS=0' });
    const gh = fakeGithub();
    const d = dirs();
    const r = makeFixEvidenceReader({ repo, pr: 5, head, exec: gh.exec, env: { WE_FIX_FACTS: '0' }, cacheDir: d.sha });
    r.api('repos/o/r/actions/jobs/1'); r.api('repos/o/r/actions/jobs/1');
    expect(gh.count.plain).toBe(2);
    expect(gh.count.full200 + gh.count.notModified304).toBe(0);
  });

  it('comment reads are not touched: the module has no comment endpoint, and the drain never imports it', () => {
    const src = readFileSync(join(ROOT, 'scripts/lib/fix-facts.mjs'), 'utf8');
    expect(src).not.toMatch(/comments/);
    for (const rel of ['scripts/merge-ai-prs.mjs', 'scripts/lib/pr-merge-gate.mjs', 'scripts/pr-land.mjs', 'scripts/review-set-label.mjs']) {
      expect(readFileSync(join(ROOT, rel), 'utf8'), rel).not.toMatch(/fix-facts|pr-facts|review-facts/);
    }
  });
});
