import { describe, it, expect, vi } from 'vitest';
import { excusePrMergeGateHolds, readReviewGateLog } from '../merge-gate-hold-class.mjs';
import { waitingOnReview } from '../../conveyor/ci-heal-verdict-recheck.mjs';
import { runReconcilePass } from '../../conveyor/reconcile-pass.mjs';
import { checkNeedsHumanEscalable, checkNotCiBreakRecordable } from '../../conveyor/ci-heal-escalation-mark.mjs';
import { sweepCiRedRecovery } from '../../conveyor/ci-red-recovery-watch.mjs';

const repo = 'web-everything/web-everything';
const head = 'a'.repeat(40);
const holdLine = 'check-review-gate held - a review hold stands: review:pending, review:human';
const requiredChecks = ['test', 'review-gate'];
const makeRow = (extra = {}) => ({ id: 123, name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE',
  detailsUrl: `https://github.com/${repo}/actions/runs/100/job/123`, ...extra });
const makePr = (row = makeRow()) => ({ number: 7037, headRefOid: head, headRefName: 'lane/review-hold',
  baseRefName: 'main', labels: [{ name: 'review:pending' }], comments: [],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, row,
    { id: 1, name: 'review-gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
const evidence = (log = holdLine, job = {}) => ({ log,
  job: { name: 'review-gate', head_sha: head, status: 'completed', conclusion: 'failure', ...job } });
const enrich = (pr, readLog) => excusePrMergeGateHolds([pr], {
  repo, mergeGateSetting: 'off', readReviewGateLog: readLog,
})[0];
const waiting = pr => waitingOnReview({ rollup: pr.statusCheckRollup, requiredChecks, labels: pr.labels });

describe('review-gate hold log enrichment', () => {
  it.each([holdLine, 'check-review-gate ✗ held — a review hold stands: review:pending'])(
    'annotates the exact timestamped hold verdict and waits on review: %s', line => {
      const pr = makePr();
      const readLog = vi.fn(() => evidence(`2026-11-17T22:40:00.1234567Z ${line}\r\n##[error]Process completed with exit code 1.`));
      const out = enrich(pr, readLog);
      expect(out.statusCheckRollup[1].output).toEqual({ summary: line });
      expect(waiting(out)).toBe(true);
      expect(readLog).toHaveBeenCalledTimes(1);
      expect(readLog).toHaveBeenCalledWith({ repo, jobId: 123 });
      expect(pr.statusCheckRollup[1].output).toBeUndefined();
    },
  );

  it.each(['checkout: repository not found', 'setup-node: download failed', 'npm ERR! ci failed'])(
    'keeps a setup failure red: %s', log => {
      const out = enrich(makePr(), () => evidence(log));
      expect(out.statusCheckRollup[1].output).toBeUndefined();
      expect(waiting(out)).toBe(false);
    },
  );

  it('keeps a throwing log reader red', () => {
    const pr = makePr();
    const out = enrich(pr, () => { throw Error('log unreadable'); });
    expect(out).toBe(pr);
    expect(out.statusCheckRollup[1].output).toBeUndefined();
    expect(waiting(out)).toBe(false);
  });

  it.each([
    ['wrong head', evidence(holdLine, { head_sha: 'b'.repeat(40) })],
    ['missing head', evidence(holdLine, { head_sha: undefined })],
    ['wrong job', evidence(holdLine, { name: 'checkout' })],
    ['unfinished job', evidence(holdLine, { status: 'in_progress' })],
    ['cancelled job', evidence(holdLine, { conclusion: 'cancelled' })],
    ['unreadable log', { error: 'HTTP 403' }],
    ['missing log', { job: evidence().job }],
  ])('keeps %s evidence red', (_name, result) => {
    const out = enrich(makePr(), () => result);
    expect(out.statusCheckRollup[1].output).toBeUndefined();
    expect(waiting(out)).toBe(false);
  });

  it.each([
    `echo "${holdLine}"`, `##[group]Run echo "${holdLine}"`, ` ${holdLine}`,
    `${holdLine}, review:unknown`, `${holdLine}, `, `${holdLine}\u001b[0m`,
    `${holdLine}\n${holdLine}`, `${holdLine}\ncheck-review-gate ok - no review hold present`,
  ])('rejects echoed, malformed or ambiguous verdicts: %j', log => {
    expect(waiting(enrich(makePr(), () => evidence(log)))).toBe(false);
  });

  it.each([
    { conclusion: 'CANCELLED' }, { conclusion: 'STARTUP_FAILURE' }, { conclusion: 'TIMED_OUT' },
    { status: 'IN_PROGRESS' }, { conclusion: null }, { conclusion: 'SUCCESS' },
    { detailsUrl: undefined, id: 123 },
    { detailsUrl: `https://github.com/${repo}/actions/runs/100` },
    { detailsUrl: 'https://github.com/another/repo/actions/runs/100/job/123' },
  ])('does not read logs for ineligible rollup evidence: %j', extra => {
    const readLog = vi.fn(() => evidence());
    const out = enrich(makePr(makeRow(extra)), readLog);
    expect(waiting(out)).toBe(false);
    expect(readLog).not.toHaveBeenCalled();
  });

  it('accepts case-insensitive completed failure and exact head matching', () => {
    const out = enrich(makePr(makeRow({ status: 'completed', conclusion: 'failure' })),
      () => evidence(holdLine, { head_sha: head.toUpperCase() }));
    expect(waiting(out)).toBe(true);
  });

  it('requires a current matching label even after log annotation', () => {
    expect(waiting(enrich({ ...makePr(), labels: [] }, () => evidence()))).toBe(false);
  });

  it('annotates each row independently, retaining a second checkout failure', () => {
    const pr = makePr();
    pr.statusCheckRollup.push(makeRow({ detailsUrl: `https://github.com/${repo}/actions/runs/101/job/456` }));
    const readLog = vi.fn(({ jobId }) => evidence(jobId === 123 ? holdLine : 'checkout failed'));
    const out = enrich(pr, readLog);
    expect(out.statusCheckRollup[1].output.summary).toBe(holdLine);
    expect(out.statusCheckRollup[3].output).toBeUndefined();
    expect(waiting(out)).toBe(false);
    expect(readLog).toHaveBeenCalledTimes(2);
  });
});

describe('bounded throttled review-gate job reads', () => {
  it('reads immutable logs once per repo/job and shares them across PRs', () => {
    const cache = new Map();
    const runGh = vi.fn(args => args[1].endsWith('/logs') ? holdLine : JSON.stringify(evidence().job));
    const readLog = args => readReviewGateLog({ ...args, cache, runGh });
    expect(waiting(enrich(makePr(), readLog))).toBe(true);
    expect(waiting(enrich({ ...makePr(), number: 7038 }, readLog))).toBe(true);
    expect(runGh).toHaveBeenCalledTimes(2);
    expect(runGh).toHaveBeenCalledWith(['api', `repos/${repo}/actions/jobs/123/logs`],
      expect.objectContaining({ timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
        throttle: { op: 'review-gate-hold', repo } }));
    readReviewGateLog({ repo: 'another/repo', jobId: 123, cache, runGh });
    expect(runGh).toHaveBeenCalledTimes(4);
  });

  it.each(['HTTP 403', 'spawnSync gh ENOBUFS: log exceeds maxBuffer'])(
    'caches unreadable/oversized logs and leaves repair ownership for %s', message => {
      const cache = new Map();
      const runGh = vi.fn(args => {
        if (args[1].endsWith('/logs')) throw Error(message);
        return JSON.stringify(evidence().job);
      });
      const readLog = args => readReviewGateLog({ ...args, cache, runGh });
      expect(waiting(enrich(makePr(), readLog))).toBe(false);
      expect(waiting(enrich(makePr(), readLog))).toBe(false);
      expect(runGh).toHaveBeenCalledTimes(2);
    },
  );
});

describe('shared enrichment consumers', () => {
  it('passes enriched rows to reconcile downstream readers via the injected log reader', () => {
    const stop = new Error('downstream probe complete');
    const readLog = vi.fn(() => evidence());
    const enrichMainRed = vi.fn(prs => {
      expect(waiting(prs[0])).toBe(true);
      throw stop;
    });
    expect(() => runReconcilePass({ readOnly: true, repo: 'we', readPrs: () => [makePr()],
      readRequiredChecks: () => ({ checks: requiredChecks }), readChecks: () => makePr().statusCheckRollup,
      readReviewGateLog: readLog, mergeGateSetting: 'off', enrichMainRed,
    })).toThrow(stop);
    expect(enrichMainRed).toHaveBeenCalledOnce();
    expect(readLog).toHaveBeenCalledTimes(1);
    expect(readLog).toHaveBeenCalledWith({ repo, jobId: 123 });
  });

  const cliOptions = (readLog, outcome) => ({ pr: 7037, repo, headSha: head, outcome,
    settings: { recheckNotCiBreak: true }, readRequired: () => ({ checks: requiredChecks }),
    prChecksOptions: { runGh: () => JSON.stringify(makePr()), mergeGateSetting: 'off', readReviewGateLog: readLog },
  });

  it('uses the enriched summary in the escalation CLI', async () => {
    const readLog = vi.fn(() => evidence());
    expect(await checkNeedsHumanEscalable(cliOptions(readLog, 'needs-human')))
      .toEqual({ refusal: expect.stringContaining('ordinary review is owed') });
    expect(await checkNotCiBreakRecordable(cliOptions(readLog, 'not-a-ci-break'))).toEqual({ refusal: null });
    expect(readLog).toHaveBeenCalledWith({ repo, jobId: 123 });
  });

  it.each(['checkout failure', 'throws', 'error result'])(
    'keeps the escalation CLI fail-closed for %s', async kind => {
      const readLog = () => {
        if (kind === 'throws') throw Error('log unavailable');
        return kind === 'error result' ? { error: 'log unavailable' } : evidence('checkout failed');
      };
      const notCiBreak = await checkNotCiBreakRecordable(cliOptions(readLog, 'not-a-ci-break'));
      expect(notCiBreak.refusal).toContain('red: review-gate');
      const needsHuman = await checkNeedsHumanEscalable(cliOptions(readLog, 'needs-human'));
      expect(needsHuman.refusal).toBeNull();
      if (kind !== 'checkout failure') expect(notCiBreak.warning).toContain('log unavailable');
    },
  );

  it.each([true, false])('recovery consumes shared enrichment (proven hold: %s)', held => {
    const readLog = vi.fn(() => evidence(held ? holdLine : 'checkout failed'));
    const readAheadBy = vi.fn(() => 0);
    sweepCiRedRecovery({ repo, readOpenPrs: () => [makePr()], requiredCheck: 'review-gate',
      readMainRuns: () => [], readMainLatestCheckRuns: () => [], readAheadBy,
      readPriority: () => null, exhaustedRetrySettings: { enabled: false },
      excuseHolds: (prs, options) => excusePrMergeGateHolds(prs, {
        ...options, mergeGateSetting: 'off', readReviewGateLog: readLog,
      }),
    });
    expect(readLog).toHaveBeenCalledTimes(1);
    expect(readLog).toHaveBeenCalledWith({ repo, jobId: 123 });
    expect(readAheadBy).toHaveBeenCalledTimes(held ? 0 : 1);
  });
});
