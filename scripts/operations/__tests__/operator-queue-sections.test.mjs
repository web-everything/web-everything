/**
 * @file #4722 — every open `review:human` PR lands in EXACTLY ONE of the operator queue's triage sections (NEEDS YOU,
 * PENDING, NOT READY), over a fixture set that covers every advisory/review label mix — including the live #4722
 * combo (`review:awaiting-advisory` + `advisory:accepted` with the advisory on the live head). Also pins the two
 * ways #4722 went invisible: the comment-heavy listing overflowing Node's 1MB default buffer, and the resulting
 * read error being printed only on stderr.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => {
  const execFileSync = vi.fn();
  return { execFileSync, default: { execFileSync } };
});
if (process.versions.bun) await import('../../lib/gh-throttle.mjs?real');
const mockModule = vi.mock;
mockModule('../../lib/gh-throttle.mjs', async (original) => ({
  ...(typeof original === 'function' ? await original() : await import('../../lib/gh-throttle.mjs?real')),
  execFileSyncThrottled: (...args) => execFileSync(...args),
}));
const { main, PR_LIST_MAX_BUFFER } = await import('../operator-queue.mjs');

afterEach(() => vi.restoreAllMocks());

const NO_UNSUPPORTED = '/nonexistent-operator-queue-test/unsupported-repo.json';
const HEAD = 'ea117e881164c3b6366b0bb78a3660c9a00503b1';
const OLD = 'c'.repeat(40);
const BASE = 'a'.repeat(40);
const TRIAGE = ['ready', 'pending', 'notReady'];

/** The review write-up shape: a `**Verdict:**` line plus a `Net basis` naming the reviewed head. */
const review = (head = HEAD, outcome = null) => ({
  body: ['**Verdict:** ✅ pass — no blocking findings', ...(outcome ? [`**Advisory outcome:** \`${outcome}\``] : []),
    `Net basis: \`${BASE}..${head}\``].join('\n'),
  createdAt: '2026-10-10T01:58:07Z',
  author: { login: 'web-everything' },
});
const GREEN = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' }];

const ADVISORY_MIXES = [[], ['advisory:accepted'], ['advisory:changes'], ['advisory:accepted', 'advisory:changes']];
const REVIEW_MIXES = [[], ['review:pending'], ['review:changes'], ['review:awaiting-advisory'], ['review:awaiting-advisory', 'review:pending'], ['review-round:1']];
const COMMENT_MIXES = [[], [review()], [review(OLD)], [review(HEAD, 'changes')], [review(HEAD, 'inconclusive')]];
const MERGEABLE = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'];

function fixtureSet() {
  const prs = [];
  let number = 1;
  for (const advisory of ADVISORY_MIXES) for (const reviewLabels of REVIEW_MIXES) for (const comments of COMMENT_MIXES) {
    for (const mergeable of MERGEABLE) {
      prs.push({
        number: number++, title: `pr ${number}`, headRefOid: HEAD, mergeable, statusCheckRollup: GREEN, comments,
        labels: ['review:human', ...reviewLabels, ...advisory].map((name) => ({ name })),
      });
    }
  }
  return prs;
}

/** Run `main --json` over one listing; every follow-up `gh pr view` mergeability poll answers UNKNOWN. */
function run(prs) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  execFileSync.mockReset().mockReturnValueOnce(JSON.stringify(prs)).mockReturnValue(JSON.stringify({ mergeable: 'UNKNOWN' }));
  main(['--repo=o/n', '--json'], { sleep: vi.fn(), pollAttempts: 1, unsupportedPath: NO_UNSUPPORTED });
  return JSON.parse(log.mock.calls[0][0]);
}

describe('operator-queue triage sections', () => {
  it('lands every open review:human PR in exactly one triage section, over every label mix', () => {
    const prs = fixtureSet();
    const report = run(prs);
    expect(report.errors).toEqual([]);
    for (const pr of prs) {
      const homes = TRIAGE.filter((section) => report[section].some((row) => row.number === pr.number));
      expect({ number: pr.number, labels: pr.labels.map((l) => l.name), homes: homes.length }).toEqual({
        number: pr.number, labels: pr.labels.map((l) => l.name), homes: 1,
      });
    }
    // Every NOT READY row says why; an empty reason list would be a PR the operator cannot act on.
    for (const row of report.notReady) expect(row.reasons.length).toBeGreaterThan(0);
  });

  it('reports the live #4722 combo in NOT READY, naming the stale review:awaiting-advisory label', () => {
    const report = run([{
      number: 4722, title: 'resource sampler', headRefOid: HEAD, mergeable: 'MERGEABLE', statusCheckRollup: GREEN,
      comments: [review()],
      labels: ['review:human', 'review-round:1', 'review:awaiting-advisory', 'advisory:accepted'].map((name) => ({ name })),
    }]);
    expect(report.ready).toEqual([]);
    expect(report.notReady).toEqual([{
      repo: 'o/n', number: 4722, title: 'resource sampler',
      reasons: ['label/comment disagreement: review:awaiting-advisory is set but advisory comment says accept on this head'],
    }]);
  });

  it('once the owner clears review:awaiting-advisory, the same PR is NEEDS YOU', () => {
    const report = run([{
      number: 4722, title: 'resource sampler', headRefOid: HEAD, mergeable: 'MERGEABLE', statusCheckRollup: GREEN,
      comments: [review()], labels: ['review:human', 'review-round:1', 'advisory:accepted'].map((name) => ({ name })),
    }]);
    expect(report.ready).toEqual([{ repo: 'o/n', number: 4722, title: 'resource sampler' }]);
    expect(report.notReady).toEqual([]);
  });

  it('keeps review:awaiting-advisory silent while no advisory covers the head (the wait is already explained)', () => {
    const report = run([{
      number: 9, title: 'waiting', headRefOid: HEAD, mergeable: 'MERGEABLE', statusCheckRollup: GREEN,
      comments: [], labels: ['review:human', 'review:awaiting-advisory'].map((name) => ({ name })),
    }]);
    expect(report.notReady[0].reasons).toEqual(['no advisory verdict']);
  });

  // Live 2026-10-10: the WE listing (25 open PRs with their comments) passed 1MB, gh threw ENOBUFS, and every WE PR
  // vanished from every section.
  it('reads the comment-heavy listing with a buffer far above the 1MB default', () => {
    run([]);
    expect(execFileSync.mock.calls[0][2].maxBuffer).toBe(PR_LIST_MAX_BUFFER);
    expect(PR_LIST_MAX_BUFFER).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });

  it('prints a failed read on stdout above the sections, not only on stderr', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    execFileSync.mockReset().mockImplementationOnce(() => { throw new Error('spawnSync gh ENOBUFS'); });
    main(['--repo=o/n'], { unsupportedPath: NO_UNSUPPORTED });
    const lines = log.mock.calls.map(([line]) => line);
    expect(lines.slice(0, 2)).toEqual(['ERRORS — the sections below are INCOMPLETE (these reads failed):', 'o/n: spawnSync gh ENOBUFS']);
  });
});
