// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ghThrottle from '../gh-throttle.mjs';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunRecord, readRun, writeRun } from '../../operations/run-store.mjs';
import { readRedTeamPublicationHold } from '../drain-red-team-evidence.mjs';
import { historicalCardOnlySkipCandidate, readDrainRedTeamEvidence, recordRedTeamStatus, readRedTeamStatus, redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { redTeamOwedFor } from '../review-red-team-policy.mjs';
import { pidStartTime } from '../pid-alive.mjs';
import { readRedTeamCarry, resumeRedTeamCarry } from '../red-team-carry-machine.mjs';
import { evaluateRedTeamCheckFact, withRedTeamCheckLock } from '../red-team-check-run.mjs';
import { publishStoredRedTeamResult, needsPublish } from '../red-team-withheld-publish.mjs';
import { RED_TEAM_UNSEALED_HOLD_PREFIX, RED_TEAM_NO_RESULT_HOLD_PREFIX, statusOwesPublication } from '../drain-red-team-evidence.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'drain-red-team-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  return { repo: 'web-everything/web-everything', pr: 5439, head: 'b'.repeat(40), runsDir,
    readScorecards: () => [], env: { WE_SHARED_RUNS_DIR: runsDir } };
}
const cleanResultComment = f => ({ author: { login: 'web-everything' }, body:
  `<!-- we:red-team-advisory pr=${f.pr} rev=${f.head} -->\n### Post-accept red team — no break found` });
// Seal at finish (#6535, operator ruling R907): the seat's sealer is the shared publisher in seal-only mode over the
// exact-head seat row. This one runs it for real over a fixture row and thread.
const seatRow = (head, findings = []) => ({ rev: head, findings, provider: 'fixture', model: 'fixture', callId: 'c',
  foldedVerdict: findings.some(x => x.confirmedByRecheck) ? 'changes' : 'accept',
  confirmedMissCount: findings.filter(x => x.confirmedByRecheck).length });
const sealAtFinish = (f, { findings = [], comments = [cleanResultComment(f)], calls = [] } = {}) => key => {
  calls.push(key);
  return publishStoredRedTeamResult({ status: key, sealOnly: true, statusDir: redTeamStatusDir(f.env),
    listComments: () => comments, postComment: () => { throw Error('seal at finish never posts'); },
    readSeatRow: () => seatRow(key.head, findings), publishNeedsYou: () => {} });
};
const payload = head => ({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } });

describe('status persistence and check publication share one claim', () => {
  it.each(['pending', 'running', 'finished'])('under-test %s writes without an injected publisher never call gh or create a publication hold', status => {
    const f = fixture();
    const gh = vi.spyOn(ghThrottle, 'runGhSync').mockImplementation(() => { throw Error('real gh forbidden'); });
    try {
      recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status }, { env: f.env });
      expect(readRedTeamStatus(f).status).toBe(status);
      expect(readRedTeamPublicationHold(f)).toBeNull();
      expect(gh).not.toHaveBeenCalled();
    } finally { gh.mockRestore(); }
  });

  it('an explicit WE_UNDER_TEST environment suppresses publication without ambient test markers', () => {
    const f = fixture(), env = { ...f.env, WE_UNDER_TEST: '1' };
    const gh = vi.spyOn(ghThrottle, 'runGhSync').mockImplementation(() => { throw Error('real gh forbidden'); });
    vi.stubEnv('VITEST', '');
    vi.stubEnv('WE_UNDER_TEST', '');
    try {
      recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, { env });
      expect(readRedTeamStatus(f).status).toBe('running');
      expect(readRedTeamPublicationHold(f)).toBeNull();
      expect(gh).not.toHaveBeenCalled();
    } finally { gh.mockRestore(); vi.unstubAllEnvs(); }
  });

  it.each(['running', 'finished'])('an injected %s publisher opts into markers without opting into real gh evidence reads', status => {
    const f = fixture(), checks = [];
    const gh = vi.spyOn(ghThrottle, 'runGhSync').mockImplementation(() => { throw Error('real gh forbidden'); });
    try {
      const result = recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status }, {
        env: f.env, postCheckRun: ({ payload: check }) => {
          expect(readRedTeamPublicationHold(f)).toMatch(/not confirmed published/);
          checks.push(check);
          return { ok: true };
        },
      });
      expect(result).toEqual({ published: true });
      expect(checks).toHaveLength(1);
      expect(checks[0].status).toBe(status === 'finished' ? 'completed' : 'in_progress');
      if (status === 'finished') expect(checks[0].conclusion).toBe('failure');
      expect(readRedTeamPublicationHold(f)).toBeNull();
      expect(gh).not.toHaveBeenCalled();
    } finally { gh.mockRestore(); }
  });

  it.each([
    ['review:human', ['ready-to-merge', 'review:human']],
    ['review:pending', ['ready-to-merge', 'review:pending']],
    ['review:changes', ['ready-to-merge', 'review:changes']],
    ['missing ready-to-merge', ['review:accepted']],
  ])('a finished clean red team ignores %s labels but preserves explicit send-back failure', (_name, labels) => {
    const f = fixture(), checks = [];
    const input = { ...f, loopPayload: payload(f.head), status: 'finished', result: 'ran' };
    const options = { env: f.env, log: () => {}, sealFinished: sealAtFinish(f),
      comments: [{ author: { login: 'web-everything' }, body:
        `<!-- we:red-team-advisory pr=${f.pr} rev=${f.head} -->\n### Post-accept red team — no break found` }],
      gh: () => JSON.stringify({ headRefOid: f.head, labels }),
      postCheckRun: ({ payload: check }) => { checks.push(check); return { ok: true }; } };

    expect(recordRedTeamStatus(input, options)).toEqual({ published: true });
    expect(recordRedTeamStatus({ ...input, sendBack: true }, options)).toEqual({ published: true });
    expect(checks).toMatchObject([
      { name: 'red-team', head_sha: f.head, status: 'completed', conclusion: 'success' },
      { name: 'red-team', head_sha: f.head, status: 'completed', conclusion: 'failure' },
    ]);
  });

  // Operator ruling R907 (#6535): seal at finish. The check is written ONCE, from the sealed result; a bare `ran` result
  // never publishes FAILURE; nothing re-publishes it later.
  describe('seal at finish (R907)', () => {
    const finishOptions = (f, checks, extra = {}) => ({ env: f.env, log: () => {}, comments: [cleanResultComment(f)],
      gh: () => JSON.stringify({ headRefOid: f.head, labels: ['ready-to-merge', 'review:accepted'] }),
      postCheckRun: ({ payload: check }) => { checks.push(check); return { ok: true }; }, ...extra });
    const finished = f => ({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'ran' });

    it('a clean bare `ran` is sealed under the claim, then its check is written once as success', () => {
      const f = fixture(), checks = [], calls = [];
      expect(recordRedTeamStatus(finished(f), finishOptions(f, checks, { sealFinished: sealAtFinish(f, { calls }) })))
        .toEqual({ published: true });
      expect(calls).toEqual([{ repo: f.repo, pr: f.pr, head: f.head }]);
      expect(readRedTeamStatus(f)).toMatchObject({ status: 'finished', result: 'ran', sealedBreaks: [] });
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ status: 'completed', conclusion: 'success', head_sha: f.head });
      expect(readRedTeamPublicationHold(f)).toBeNull();
    });

    it('a sealed confirmed break is written once as failure (send-back), never cleared by a clean-looking thread', () => {
      const f = fixture(), checks = [];
      const findings = [{ category: 'correctness', file: 'a.mjs', line: 3, summary: 'breaks x', confirmedByRecheck: true }];
      recordRedTeamStatus(finished(f), finishOptions(f, checks, { comments: [],
        sealFinished: sealAtFinish(f, { findings, comments: [] }) }));
      expect(readRedTeamStatus(f).sealedBreaks).toHaveLength(1);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ status: 'completed', conclusion: 'failure',
        output: { summary: expect.stringMatching(/confirmed a break/) } });
    });

    it.each([
      ['no sealer', () => ({})],
      ['a sealer that throws', () => ({ sealFinished: () => { throw Error('seat row unreadable'); } })],
      ['a sealer that cannot read the thread', f => ({ sealFinished: key => publishStoredRedTeamResult({ status: key,
        sealOnly: true, statusDir: redTeamStatusDir(f.env), listComments: () => { throw Error('HTTP 502'); }, postComment: () => {} }) })],
    ])('an unsealed bare `ran` (%s) never publishes FAILURE: its one check stays in progress and still holds', (_label, extra) => {
      const f = fixture(), checks = [];
      expect(recordRedTeamStatus(finished(f), finishOptions(f, checks, extra(f)))).toEqual({ published: true });
      expect(readRedTeamStatus(f).sealedBreaks).toBeUndefined();
      expect(checks).toHaveLength(1);
      expect(checks[0].status).toBe('in_progress');
      expect(checks[0]).not.toHaveProperty('conclusion');
      expect(checks[0].output.summary).toContain(RED_TEAM_UNSEALED_HOLD_PREFIX);
      // In progress is not a pass: merge-gate still holds the head.
      expect(evaluateRedTeamCheckFact({ repo: f.repo, pr: f.pr, headSha: f.head, appId: 5037855,
        checkRuns: [{ ...checks[0], id: 1, app: { id: 5037855 } }] }).ok).toBe(false);
    });

    // Self-review must-fix: the seat's comment was withheld (secret scrub) or its post failed, so the thread has no result.
    it('a withheld comment is posted by the finish sealer, then the one check is success', () => {
      const f = fixture(), checks = [], thread = [], posted = [];
      const sealFinished = key => publishStoredRedTeamResult({ status: key, statusDir: redTeamStatusDir(f.env),
        listComments: () => thread, postComment: ({ body }) => { posted.push(body); thread.push({ author: { login: 'web-everything' }, body }); },
        readSeatRow: () => seatRow(key.head), publishNeedsYou: () => {} });
      expect(recordRedTeamStatus(finished(f), finishOptions(f, checks, { comments: thread, sealFinished }))).toEqual({ published: true });
      expect(posted).toHaveLength(1);
      expect(readRedTeamStatus(f)).toMatchObject({ sealedBreaks: [], result: { status: 'ran', comment: 'posted' } });
      expect(checks).toMatchObject([{ status: 'completed', conclusion: 'success' }]);
    });

    it.each([
      ['seal-only (nothing posts)', f => sealAtFinish(f, { comments: [] })],
      ['a post that fails', f => key => publishStoredRedTeamResult({ status: key, statusDir: redTeamStatusDir(f.env),
        listComments: () => [], postComment: () => { throw Error('HTTP 502'); }, readSeatRow: () => seatRow(key.head),
        publishNeedsYou: () => {} })],
    ])('a sealed result whose comment is still unposted (%s) never publishes FAILURE: in progress, still held', (_l, sealer) => {
      const f = fixture(), checks = [];
      recordRedTeamStatus(finished(f), finishOptions(f, checks, { comments: [], sealFinished: sealer(f) }));
      expect(readRedTeamStatus(f).sealedBreaks).toEqual([]);
      expect(checks).toHaveLength(1);
      expect(checks[0].status).toBe('in_progress');
      expect(checks[0].output.summary).toContain(RED_TEAM_NO_RESULT_HOLD_PREFIX);
    });

    it('a result that owes no publication and has no recorded result keeps its FAILURE', () => {
      const f = fixture(), checks = [];
      recordRedTeamStatus({ ...finished(f), result: { status: 'ran', comment: 'posted', findings: [] } },
        finishOptions(f, checks, { comments: [] }));
      expect(checks).toMatchObject([{ status: 'completed', conclusion: 'failure' }]);
    });

    it('statusOwesPublication mirrors the publisher\'s needsPublish', () => {
      for (const status of [{ status: 'finished', result: 'ran' }, { status: 'running', result: 'ran' },
        { status: 'finished', result: { status: 'ran', comment: 'withheld' } }, { status: 'finished', result: { status: 'ran', comment: 'error' } },
        { status: 'finished', result: { status: 'ran', comment: 'posted' } }, { status: 'finished', result: 'failed' }, null]) {
        expect(statusOwesPublication(status)).toBe(needsPublish(status));
      }
    });

    it('an explicit send-back on an unsealed result still publishes FAILURE (only "not sealed" is downgraded)', () => {
      const f = fixture(), checks = [];
      recordRedTeamStatus({ ...finished(f), sendBack: true }, finishOptions(f, checks));
      expect(checks).toMatchObject([{ status: 'completed', conclusion: 'failure' }]);
    });

    it('pins the unsealed-hold prefix to the gate\'s own wording', () => {
      const f = fixture();
      recordRedTeamStatus(finished(f), { env: f.env });
      const hold = redTeamEnqueueHold({ ...finished(f), head: f.head, comments: [cleanResultComment(f)], scheduled: true,
        recorded: true, env: f.env });
      expect(hold).toMatch(new RegExp(`^${RED_TEAM_UNSEALED_HOLD_PREFIX}`));
      sealAtFinish(f, { comments: [] })({ repo: f.repo, pr: f.pr, head: f.head });
      expect(redTeamEnqueueHold({ ...finished(f), head: f.head, comments: [], scheduled: true, recorded: true, env: f.env }))
        .toMatch(new RegExp(`^${RED_TEAM_NO_RESULT_HOLD_PREFIX}`));
    });
  });

  it('successful completion followed by failed publication of a terminal failure keeps the hold and attempts the failure supersede', () => {
    const f = fixture(), appId = 5037855, runs = [], attempts = [];
    const input = { ...f, loopPayload: payload(f.head), status: 'finished' };
    const options = { env: f.env, log: () => {}, sealFinished: sealAtFinish(f),
      comments: [{ author: { login: 'web-everything' }, body:
        `<!-- we:red-team-advisory pr=${f.pr} rev=${f.head} -->\n### Post-accept red team — no break found` }],
      gh: () => JSON.stringify({ headRefOid: f.head, labels: ['ready-to-merge', 'review:accepted'] }),
      postCheckRun: ({ payload: check }) => {
        runs.push({ ...check, id: runs.length + 1, app: { id: appId } });
        return { ok: true };
      } };
    expect(recordRedTeamStatus({ ...input, result: 'ran' }, options)).toEqual({ published: true });
    expect(readRedTeamPublicationHold(f)).toBeNull();
    expect(evaluateRedTeamCheckFact({ repo: f.repo, pr: f.pr, headSha: f.head, appId, checkRuns: runs }).ok).toBe(true);
    const result = recordRedTeamStatus({ ...input, result: 'failed', sendBack: true }, {
      ...options, comments: [], postCheckRun: ({ payload: check }) => {
        expect(readRedTeamPublicationHold(f)).toMatch(/not confirmed published/);
        attempts.push(check);
        return { ok: false, reason: 'GitHub unavailable' };
      },
    });
    expect(result).toMatchObject({ published: false, reason: expect.stringContaining('failure supersede also failed') });
    expect(readRedTeamStatus(f)).toMatchObject({ status: 'finished', result: 'failed' });
    expect(readRedTeamPublicationHold(f)).toMatch(/retry check publication/);
    expect(attempts).toHaveLength(2);
    expect(attempts.every(check => check.head_sha === f.head && check.status === 'completed' && check.conclusion === 'failure')).toBe(true);
    expect(attempts[1].output.summary).toContain('Unpublished finished red-team round');
    // Only a confirmed publication can release this terminal-transition hold.
    expect(recordRedTeamStatus({ ...input, result: 'failed', sendBack: true }, options)).toEqual({ published: true });
    expect(readRedTeamPublicationHold(f)).toBeNull();
    expect(evaluateRedTeamCheckFact({ repo: f.repo, pr: f.pr, headSha: f.head, appId, checkRuns: runs }).ok).toBe(false);
  });

  it('a status write that throws before publication leaves no publication hold of its own (no wedge)', () => {
    const f = fixture(), checks = [];
    const options = { env: f.env, gh: () => '', log: () => {}, postCheckRun: ({ payload: check }) => { checks.push(check); return { ok: true }; } };
    // An invalid retry count makes writeRedTeamStatus throw after the marker would have been written.
    expect(() => recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running', retryCount: -1 }, options))
      .toThrow(/invalid red-team retry count/);
    expect(checks).toHaveLength(0);
    expect(readRedTeamPublicationHold(f)).toBeNull();
  });

  it('a status write that throws keeps an earlier, still-unconfirmed publication hold', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, { env: f.env, gh: () => '', log: () => {},
      postCheckRun: () => ({ ok: false, reason: 'fixture publication failure' }) });
    expect(readRedTeamPublicationHold(f)).toMatch(/retry check publication/);
    expect(() => recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running', retryCount: -1 }, { env: f.env,
      gh: () => '', log: () => {}, postCheckRun: () => ({ ok: true }) })).toThrow(/invalid red-team retry count/);
    expect(readRedTeamPublicationHold(f)).toMatch(/retry check publication/);
  });

  it('publication holds are isolated by head and fail closed on unreadable marker paths', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, { env: f.env, gh: () => '',
      postCheckRun: () => ({ ok: false, reason: 'fixture publication failure' }), log: () => {} });
    expect(readRedTeamPublicationHold(f)).toMatch(/retry check publication/);
    expect(readRedTeamPublicationHold({ ...f, head: 'c'.repeat(40) })).toBeNull();
    // A non-directory ancestor makes the probe unreadable, rather than absent.
    const blocked = join(redTeamStatusDir(f.env), 'not-a-directory');
    writeFileSync(blocked, 'blocked');
    expect(readRedTeamPublicationHold({ ...f, env: { WE_SHARED_RUNS_DIR: join(blocked, 'child', 'runs') } }))
      .toMatch(/unreadable.*operator must inspect/);
  });
  it.each(['pending', 'running'])('success then failed %s publication attempts a failure supersede and reports published:false', status => {
    const f = fixture(), appId = 5037855, runs = [], attempts = [], logs = [];
    const input = { ...f, loopPayload: payload(f.head) };
    const options = {
      env: f.env, sealFinished: sealAtFinish(f),
      comments: [{ author: { login: 'web-everything' }, body:
        `<!-- we:red-team-advisory pr=${f.pr} rev=${f.head} -->\n### Post-accept red team — no break found` }],
      gh: () => JSON.stringify({ headRefOid: f.head, labels: ['ready-to-merge', 'review:accepted'] }),
      log: line => logs.push(JSON.parse(line)),
      postCheckRun: ({ payload: check }) => {
        attempts.push(check);
        if (check.status === 'in_progress') {
          // Both returned failures and thrown errors count against the same bound.
          if (attempts.length === 3) throw Error('HTTP 503');
          return { ok: false, reason: 'HTTP 503' };
        }
        runs.push({ ...check, id: runs.length + 1, app: { id: appId } });
        return { ok: true };
      },
    };
    expect(recordRedTeamStatus({ ...input, status: 'finished', result: 'ran' }, options)).toEqual({ published: true });
    expect(evaluateRedTeamCheckFact({ repo: f.repo, pr: f.pr, headSha: f.head, appId, checkRuns: runs }).ok).toBe(true);
    const result = recordRedTeamStatus({ ...input, status }, options);
    expect(result).toMatchObject({ published: false, reason: expect.stringContaining(`Unpublished ${status} red-team round`) });
    expect(logs).toEqual([result]);
    expect(readRedTeamStatus(f).status).toBe(status);
    expect(attempts).toHaveLength(5); // original success, three pending attempts, one failure supersede
    expect(attempts.slice(1, 4).every(check => check.status === 'in_progress')).toBe(true);
    expect(attempts[4]).toMatchObject({ head_sha: f.head, status: 'completed', conclusion: 'failure',
      output: { summary: expect.stringContaining(`Unpublished ${status} red-team round for PR #${f.pr} on ${f.head}`) } });
    expect(evaluateRedTeamCheckFact({ repo: f.repo, pr: f.pr, headSha: f.head, appId, checkRuns: runs }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/failed/) });
  });

  it('bounds retries and preserves the local write when pending and failure supersede publications both fail', () => {
    const f = fixture(), attempts = [], holds = [];
    const result = recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, {
      env: f.env, gh: () => '', log: () => { throw Error('logger unavailable'); },
      postCheckRun: ({ payload: check }) => { attempts.push(check); throw Error('GitHub unavailable'); },
      postPublicationHold: hold => { holds.push(hold); throw Error('statuses API unavailable'); },
    });
    expect(result).toMatchObject({ published: false,
      reason: expect.stringMatching(/failure supersede also failed.*GitHub-visible hold also failed.*operator must inspect/) });
    expect(attempts.map(check => check.status)).toEqual(['in_progress', 'in_progress', 'in_progress', 'completed']);
    // Set before the first check post, then retried once after the supersede failed.
    expect(holds).toMatchObject([{ repo: f.repo, headSha: f.head, held: true }, { held: true }]);
    expect(readRedTeamStatus(f).status).toBe('running');
    expect(readRedTeamPublicationHold(f)).toMatch(/retry check publication/);
  });

  // Self-review of the send-back item 1 fix (PR #6606): the live helper holds, posts, validates and clears under the
  // host lock, but a round writer's clear landed outside it. A status is last-wins, so a late round clear could land
  // inside the helper's sequence, clear its pending hold and expose its success before validation. The round clear
  // now takes the same lock: a probe from inside the clear finds the lock held.
  it('the round writer clears its GitHub-visible hold only under the writers\' host lock', () => {
    const f = fixture();
    const lockDir = mkdtempSync(join(tmpdir(), 'red-team-locks-'));
    try {
      const env = { ...f.env, WE_RED_TEAM_CHECK_LOCK_DIR: lockDir };
      const probes = [];
      const out = recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, { env, gh: () => '', log: () => {},
        postCheckRun: () => ({ ok: true }),
        postPublicationHold: hold => {
          if (!hold.held) probes.push(withRedTeamCheckLock({ repo: f.repo, pr: f.pr, headSha: f.head, env, lockTimeoutMs: 0 },
            () => ({ ok: true })));
          return { ok: true };
        } });
      expect(out).toEqual({ published: true });
      expect(probes).toEqual([expect.objectContaining({ ok: false, reason: expect.stringMatching(/lock failed/) })]);
    } finally { rmSync(lockDir, { recursive: true, force: true }); }
  });

  it('sets a GitHub-visible hold before any check post, keeps it across later failures, and clears it only on confirmation', () => {
    const f = fixture(), holds = [], order = [];
    const input = { ...f, loopPayload: payload(f.head), status: 'running' };
    const options = postCheckRun => ({ env: f.env, gh: () => '', log: () => {},
      postCheckRun: args => { order.push('check'); return postCheckRun(args); },
      postPublicationHold: hold => { order.push(hold.held ? 'hold' : 'clear'); holds.push(hold.held); return { ok: true }; } });
    expect(recordRedTeamStatus(input, options(() => ({ ok: false, reason: 'checks API down' }))))
      .toMatchObject({ published: false, reason: expect.stringContaining('GitHub-visible publication hold set') });
    expect(order).toEqual(['hold', 'check', 'check', 'check', 'check']);
    expect(holds).toEqual([true]);
    // A later attempt whose failure supersede does post must not drop the set hold.
    let calls = 0;
    expect(recordRedTeamStatus(input, options(() => (++calls > 3 ? { ok: true } : { ok: false, reason: 'flaky' }))))
      .toMatchObject({ published: false, reason: expect.stringContaining('failure check superseded prior success') });
    expect(holds).toEqual([true]);
    // Clearing that fails keeps both holds; the next confirmed publication clears them.
    expect(recordRedTeamStatus(input, { ...options(() => ({ ok: true })), postPublicationHold: () => ({ ok: false, reason: 'statuses API down' }) }))
      .toMatchObject({ published: false, reason: expect.stringContaining('GitHub-visible hold was not cleared') });
    expect(readRedTeamPublicationHold(f)).toMatch(/retry check publication/);
    expect(recordRedTeamStatus(input, options(() => ({ ok: true })))).toEqual({ published: true });
    expect(holds).toEqual([true, false]);
    expect(readRedTeamPublicationHold(f)).toBeNull();
    // A fresh transition sets the hold before its post and clears it after confirmation.
    order.length = 0;
    expect(recordRedTeamStatus(input, options(() => ({ ok: true })))).toEqual({ published: true });
    expect(order).toEqual(['hold', 'check', 'clear']);
  });

  it('a definite rejection of the hold post (no statuses:write) withdraws it, so confirmation needs no clear (no wedge)', () => {
    const f = fixture(), calls = [];
    const input = { ...f, loopPayload: payload(f.head), status: 'running' };
    const reject = hold => { calls.push(hold.held); return { ok: false, reason: 'gh: Resource not accessible by integration (HTTP 403)' }; };
    expect(recordRedTeamStatus(input, { env: f.env, gh: () => '', log: () => {}, postPublicationHold: reject,
      postCheckRun: () => ({ ok: false, reason: 'checks API down' }) }))
      .toMatchObject({ published: false, reason: expect.stringContaining('GitHub-visible hold also failed') });
    expect(readRedTeamPublicationHold(f)).toMatch(/retry check publication/);
    expect(recordRedTeamStatus(input, { env: f.env, gh: () => '', log: () => {}, postPublicationHold: reject,
      postCheckRun: () => ({ ok: true }) })).toEqual({ published: true });
    expect(calls.every(Boolean)).toBe(true); // never a clear: no status was ever created
    expect(readRedTeamPublicationHold(f)).toBeNull();
  });

  it('an unknown hold-post outcome (5xx) keeps the hold until a clear confirms', () => {
    const f = fixture(), calls = [];
    const input = { ...f, loopPayload: payload(f.head), status: 'running' };
    const flaky = hold => { calls.push(hold.held); return hold.held ? { ok: false, reason: 'HTTP 502' } : { ok: true }; };
    expect(recordRedTeamStatus(input, { env: f.env, gh: () => '', log: () => {}, postPublicationHold: flaky,
      postCheckRun: () => ({ ok: true }) })).toEqual({ published: true });
    expect(calls).toEqual([true, false]);
  });

  it('an inherited hold flag is not proof the hold landed: a failed supersede re-posts it before reporting it set', () => {
    const f = fixture(), calls = [];
    const input = { ...f, loopPayload: payload(f.head), status: 'running' };
    // First writer: the hold post outcome is unknown (5xx), so the flag is kept but nothing may be on GitHub.
    recordRedTeamStatus(input, { env: f.env, gh: () => '', log: () => {}, postPublicationHold: () => ({ ok: false, reason: 'HTTP 502' }),
      postCheckRun: () => ({ ok: false, reason: 'down' }) });
    const result = recordRedTeamStatus(input, { env: f.env, gh: () => '', log: () => {},
      postPublicationHold: hold => { calls.push(hold.held); return { ok: false, reason: 'HTTP 502' }; },
      postCheckRun: () => ({ ok: false, reason: 'down' }) });
    expect(calls).toEqual([true]);
    expect(result).toMatchObject({ published: false, reason: expect.stringContaining('GitHub-visible hold also failed') });
  });

  it('a clear the credential definitely cannot make (HTTP 4xx) releases the local hold (no wedge after an unknown pre-post)', () => {
    const f = fixture(), logs = [];
    const input = { ...f, loopPayload: payload(f.head), status: 'running' };
    recordRedTeamStatus(input, { env: f.env, gh: () => '', log: () => {}, postPublicationHold: () => ({ ok: false, reason: 'timeout' }),
      postCheckRun: () => ({ ok: false, reason: 'down' }) });
    expect(readRedTeamPublicationHold(f)).toMatch(/retry check publication/);
    expect(recordRedTeamStatus(input, { env: f.env, gh: () => '', log: line => logs.push(line),
      postPublicationHold: () => ({ ok: false, reason: 'not accessible', definite: true }), postCheckRun: () => ({ ok: true }) }))
      .toEqual({ published: true });
    expect(readRedTeamPublicationHold(f)).toBeNull();
    expect(logs.join('\n')).toMatch(/clear rejected.*keeps CI held/);
  });

  it('a marker written before the remote-hold flag existed never asks for a clear', () => {
    const f = fixture(), calls = [];
    const input = { ...f, loopPayload: payload(f.head), status: 'running' };
    recordRedTeamStatus(input, { env: f.env, gh: () => '', log: () => {}, postPublicationHold: () => ({ ok: false, reason: 'HTTP 403' }),
      postCheckRun: () => ({ ok: false, reason: 'down' }) });
    // Rewrite it in the legacy shape (no remoteHold field), as an older writer left it.
    writeFileSync(join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json.unpublished`), '{"status":"running"}');
    expect(recordRedTeamStatus(input, { env: f.env, gh: () => '', log: () => {},
      postPublicationHold: hold => { calls.push(hold.held); return { ok: false, reason: 'HTTP 403' }; },
      postCheckRun: () => ({ ok: true }) })).toEqual({ published: true });
    expect(calls).toEqual([true]);
  });

  it('stops pending publication retries at the first success without posting a failure supersede', () => {
    const f = fixture(), attempts = [];
    const result = recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'pending' }, {
      env: f.env, gh: () => '',
      postCheckRun: ({ payload: check }) => {
        attempts.push(check);
        return attempts.length === 2 ? { ok: true } : { ok: false, reason: 'HTTP 503' };
      },
    });
    expect(result).toEqual({ published: true });
    expect(attempts.map(check => check.status)).toEqual(['in_progress', 'in_progress']);
  });

  it('prevents reversed publication order so a newer pending hold remains authoritative', () => {
    const f = fixture(), appId = 5037855, runs = [];
    const input = { ...f, loopPayload: payload(f.head) };
    let competingError;
    const publish = ({ payload: check }) => {
      runs.push({ ...check, id: runs.length + 1, app: { id: appId } });
      return { ok: true };
    };
    const newerOptions = { env: f.env, gh: () => '', postCheckRun: publish };
    recordRedTeamStatus({ ...input, status: 'finished', result: 'ran' }, {
      env: f.env, sealFinished: sealAtFinish(f),
      comments: [{ author: { login: 'web-everything' }, body:
        `<!-- we:red-team-advisory pr=${f.pr} rev=${f.head} -->\n### Post-accept red team — no break found` }],
      gh: () => JSON.stringify({ headRefOid: f.head, labels: ['ready-to-merge', 'review:accepted'] }),
      postCheckRun: args => {
        // A is paused after persistence, before its success reaches GitHub. B
        // attempts to persist and publish pending during that exact interval.
        try { recordRedTeamStatus({ ...input, status: 'running' }, newerOptions); }
        catch (error) { competingError = error; }
        expect(readRedTeamStatus(f).status).toBe('finished');
        return publish(args);
      },
    });
    expect(competingError?.code).toBe('RED_TEAM_RETRY_ADMITTED');
    expect(runs).toHaveLength(1);
    expect(runs[0].conclusion).toBe('success');
    // Once A releases the claim, B's next attempt owns both the local write and
    // publication. A has no deferred publication left that could overtake it.
    recordRedTeamStatus({ ...input, status: 'running' }, newerOptions);
    expect(readRedTeamStatus(f).status).toBe('running');
    expect(runs).toHaveLength(2);
    expect(runs[1].status).toBe('in_progress');
    expect(evaluateRedTeamCheckFact({ repo: f.repo, pr: f.pr, headSha: f.head, appId, checkRuns: runs }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/progress|incomplete/) });
  });

  it('keeps the local write and releases the claim when check publication throws', () => {
    const f = fixture(), input = { ...f, loopPayload: payload(f.head) };
    expect(() => recordRedTeamStatus({ ...input, status: 'running' }, {
      env: f.env, gh: () => '', postCheckRun: () => { throw Error('GitHub unavailable'); },
    })).not.toThrow();
    expect(readRedTeamStatus(f).status).toBe('running');
    recordRedTeamStatus({ ...input, status: 'finished', result: 'failed' }, { env: f.env });
    expect(readRedTeamStatus(f)).toMatchObject({ status: 'finished', result: 'failed' });
  });
});

describe('historical fallback predicate clauses', () => {
  const evidence = () => ({ status: { status: 'finished', skipCardOnly: true, result: 'skipped' },
    recorded: false, inFlight: false, queued: false });
  it('accepts a finished unrecorded policy skip', () => {
    expect(historicalCardOnlySkipCandidate(evidence())).toBe(true);
  });
  it.each([
    ['finished status', e => { e.status.status = 'running'; }],
    ['historical policy', e => { e.status.skipCardOnly = false; }],
    ['skipped result', e => { e.status.result = 'ran'; }],
    ['no recorded seat', e => { e.recorded = true; }],
    ['not in flight', e => { e.inFlight = true; }],
    ['not queued', e => { e.queued = true; }],
  ])('independently requires %s', (_clause, mutate) => {
    const old = evidence();
    mutate(old);
    expect(historicalCardOnlySkipCandidate(old)).toBe(false);
  });
});

describe('drain reads actual head-bound review scheduler inputs', () => {
  it.each(['failed', { status: 'failed' }])('holds a failed red-team result with no scorecard row after append failure: %j', result => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result }, f);
    const evidence = readDrainRedTeamEvidence(f);
    expect(evidence).toMatchObject({ recorded: false, seatRecorded: false, completedRecorded: false,
      failedSeatCount: 0, inFlight: false, status: { status: 'finished', result } });
    expect(redTeamEnqueueHold({ ...f, ...evidence, comments: [] })).toMatch(/no recorded result/);
    expect(evidence.scheduled).toBe(true);
  });

  it.each(['missing status', 'real panel status', 'same-head panel', 'different-head panel'])(
    'unfinished journal discovery handles %s without manufacturing a verdict', kind => {
      const f = fixture(), from = 'a'.repeat(40);
      const loopPayload = { verdict: null, carriedFrom: from, findings: { read: {
        netBasis: { rev: f.head }, diffText: '+card', netChangedFiles: ['backlog/123-card.md'],
      } } };
      // Power loss immediately after the journal rename, before the compatibility status.
      expect(() => resumeRedTeamCarry({ ...f, loopPayload }, { env: f.env, eligible: () => true,
        intentRecorded: () => false, recordIntent: () => { throw Error('crash'); },
      })).toThrow('crash');
      if (kind === 'real panel status') {
        recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'ran' }, f);
      } else if (kind.includes('panel')) {
        writeRun({ ...newRunRecord({ id: 'review-pr-later-panel', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }),
          ...payload(kind === 'same-head panel' ? f.head : 'c'.repeat(40)) }, f.runsDir);
      }
      const evidence = readDrainRedTeamEvidence(f);
      if (kind === 'missing status') {
        expect(evidence).toMatchObject({ carry: { step: 'intent' }, loopPayload: { verdict: null },
          status: { status: 'finished', result: { status: 'skipped', policy: 'card-only' } } });
      } else {
        expect(evidence.carryConflict).toBe(true);
        expect(evidence.carry).toBeUndefined();
      }
    });
  it.each(['accept', 'changes'])('a carried %s verdict is never exposed as a live-head panel verdict', verdict => {
    const f = fixture(), carriedFrom = 'c'.repeat(40);
    const loopPayload = { ...payload(f.head), carriedFrom, verdict: { verdict } };
    recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: { status: 'skipped', policy: 'card-only' } }, f);
    const evidence = readDrainRedTeamEvidence(f);
    expect(evidence.loopPayload).toMatchObject({ carriedFrom, verdict: null,
      findings: { read: { netBasis: { rev: f.head } } } });
    expect(redTeamOwedFor(evidence.loopPayload)).toBe(false);
    expect(evidence.status.loopPayload.verdict).toEqual({ verdict });
    expect(loopPayload.verdict).toEqual({ verdict });
  });
  it('preserves spent retry admission through running and finished writes, including an explicit zero', () => {
    const f = fixture(), loopPayload = payload(f.head);
    recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env });
    recordRedTeamStatus({ ...f, loopPayload, status: 'running' }, { env: f.env });
    expect(readRedTeamStatus(f).retryCount).toBe(1);
    recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: 'ran', retryCount: 0 }, { env: f.env });
    expect(readRedTeamStatus(f).retryCount).toBe(1);
  });
  it('refuses an existing retry marker even after stale status restoration, and isolates heads', () => {
    const f = fixture(), loopPayload = payload(f.head);
    recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: 'ran' }, { env: f.env });
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    const stale = readFileSync(path, 'utf8');
    recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env });
    writeFileSync(path, stale);
    expect(() => recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env }))
      .toThrow('retry already admitted');
    expect(readFileSync(path, 'utf8')).toBe(stale);
    recordRedTeamStatus({ ...f, loopPayload, status: 'running' }, { env: f.env });
    expect(readRedTeamStatus(f).retryCount).toBe(1);
    const other = { ...f, head: 'c'.repeat(40) };
    recordRedTeamStatus({ ...other, loopPayload: payload(other.head), status: 'queued', retryCount: 1 }, { env: f.env });
    expect(readRedTeamStatus(other).retryCount).toBe(1);
  });

  it('keeps the retry spent when status persistence fails after the exclusive create', () => {
    const f = fixture(), loopPayload = payload(f.head);
    expect(() => recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 },
      { env: f.env, readPidStart: () => { throw Error('injected metadata failure'); } })).toThrow('injected metadata failure');
    // Readers fail closed on the orphaned marker; the writer below must still record the settlement.
    expect(() => readRedTeamStatus(f)).toThrow('red-team retry marker has no status');
    expect(() => recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env }))
      .toThrow('retry already admitted');
    recordRedTeamStatus({ ...f, loopPayload, status: 'finished', retryCount: 0 }, { env: f.env });
    expect(readRedTeamStatus(f).retryCount).toBe(1);
  });

  it('refuses historical spent retry counts without a marker', () => {
    const f = fixture(), loopPayload = payload(f.head);
    recordRedTeamStatus({ ...f, loopPayload, status: 'finished' }, { env: f.env });
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    writeFileSync(path, JSON.stringify({ ...readRedTeamStatus(f), retryCount: 1 }));
    expect(() => recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env }))
      .toThrow('retry already admitted');
  });

  describe('only the owning, still-queued admission refunds its retry', () => {
    const statusFile = f => join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    const admit = (f, loopPayload) => recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env });
    const settle = (f, loopPayload, input = {}, opts = {}) =>
      recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: 'ran', refundRetry: true, ...input }, { env: f.env, ...opts });

    it('the owning queued admission refunds: the marker goes and a later admission is accepted', () => {
      const f = fixture(), loopPayload = payload(f.head);
      admit(f, loopPayload);
      settle(f, loopPayload);
      expect(existsSync(`${statusFile(f)}.retry-1`)).toBe(false);
      expect(readRedTeamStatus(f).retryCount).toBeUndefined();
      expect(() => admit(f, loopPayload)).not.toThrow();
    });

    it.each([
      ['a prior status record', (f, lp) => {
        // An orphaned marker: the admission's status write never landed.
        admit(f, lp);
        rmSync(statusFile(f));
        return {};
      }],
      ['a queued (not running) prior', (f, lp) => {
        admit(f, lp);
        recordRedTeamStatus({ ...f, loopPayload: lp, status: 'running' }, { env: f.env });
        return {};
      }],
      ['a queued (not finished) prior', (f, lp) => {
        admit(f, lp);
        recordRedTeamStatus({ ...f, loopPayload: lp, status: 'finished', result: 'ran' }, { env: f.env });
        return {};
      }],
      ['a prior that spent the retry', (f, lp) => {
        admit(f, lp);
        const path = statusFile(f);
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), retryCount: 2 }));
        return {};
      }],
      ['refundRetry === true (not merely truthy 1)', (f, lp) => { admit(f, lp); return { input: { refundRetry: 1 } }; }],
      ["refundRetry === true (not merely truthy 'true')", (f, lp) => { admit(f, lp); return { input: { refundRetry: 'true' } }; }],
      ['no retryCount on the refunding write', (f, lp) => { admit(f, lp); return { input: { retryCount: 0 } }; }],
      ['the owning pid', (f, lp) => {
        admit(f, lp);
        const path = statusFile(f);
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), pid: process.pid + 1 }));
        return {};
      }],
      ['the owning process start time (a reused pid)', (f, lp) => {
        admit(f, lp);
        const path = statusFile(f);
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), pidStart: 'an-earlier-process' }));
        return {};
      }],
      ['the owning host', (f, lp) => { admit(f, lp); return { opts: { host: 'another-host' } }; }],
      ['the owning pid namespace', (f, lp) => { admit(f, lp); return { opts: { namespace: 'another-namespace' } }; }],
    ])('refuses to refund without %s, and the retry stays spent', (_clause, arrange) => {
      const f = fixture(), loopPayload = payload(f.head);
      const { input, opts } = arrange(f, loopPayload);
      settle(f, loopPayload, input, opts);
      expect(existsSync(`${statusFile(f)}.retry-1`)).toBe(true);
      expect(readRedTeamStatus(f).retryCount).toBeGreaterThanOrEqual(1);
      expect(() => admit(f, loopPayload)).toThrow('retry already admitted');
    });

    it('a crash after the refund removed the marker still counts the queued retry as spent', () => {
      const f = fixture(), loopPayload = payload(f.head);
      admit(f, loopPayload);
      // The ownership check reads the start time; the status write's read then crashes.
      let reads = 0;
      const readPidStart = pid => { if (++reads > 1) throw Error('crash after refund'); return pidStartTime(pid); };
      expect(() => settle(f, loopPayload, {}, { readPidStart })).toThrow('crash after refund');
      expect(existsSync(`${statusFile(f)}.retry-1`)).toBe(false);
      expect(readRedTeamStatus(f)).toMatchObject({ status: 'queued', retryCount: 1 });
      expect(() => admit(f, loopPayload)).toThrow('retry already admitted');
    });
  });

  it.each(['queued', 'running', 'finished', 'fresh retry', 'refund'].flatMap(kind => [
    [kind, 'truncated JSON', '{broken'],
    [kind, 'null JSON', 'null'],
    [kind, 'wrong identity', JSON.stringify({ repo: 'another/repo', pr: 5439, head: 'b'.repeat(40) })],
    [kind, 'malformed PR identity', JSON.stringify({ repo: 'web-everything/web-everything',
      pr: { toString: null, valueOf: null }, head: 'b'.repeat(40) })],
  ]))('%s writes repair %s only when no retry marker exists', (kind, _damage, contents) => {
    const f = fixture(), loopPayload = payload(f.head);
    recordRedTeamStatus({ ...f, loopPayload, status: 'queued' }, { env: f.env });
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    writeFileSync(path, contents);
    expect(() => readRedTeamStatus(f)).toThrow();
    const status = kind === 'fresh retry' ? 'queued' : kind === 'refund' ? 'finished' : kind;
    recordRedTeamStatus({ ...f, loopPayload, status,
      ...(kind === 'fresh retry' ? { retryCount: 1 } : {}),
      ...(kind === 'refund' ? { refundRetry: true } : {}),
    }, { env: f.env });
    expect(readRedTeamStatus(f)).toMatchObject({ repo: f.repo, pr: f.pr, head: f.head, status });
    expect(readRedTeamStatus(f).retryCount).toBe(kind === 'fresh retry' ? 1 : undefined);
    expect(existsSync(`${path}.retry-1`)).toBe(kind === 'fresh retry');
  });

  it.each(['queued', 'running', 'finished', 'fresh retry', 'refund'].flatMap(kind => [
    [kind, 'truncated JSON', '{broken'],
    [kind, 'null JSON', 'null'],
    [kind, 'wrong identity', JSON.stringify({ repo: 'another/repo', pr: 5439, head: 'b'.repeat(40) })],
    [kind, 'malformed PR identity', JSON.stringify({ repo: 'web-everything/web-everything',
      pr: { toString: null, valueOf: null }, head: 'b'.repeat(40) })],
  ]))('%s writes preserve %s beside a retry marker for operator inspection', (kind, _damage, contents) => {
    const f = fixture(), loopPayload = payload(f.head);
    recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env });
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    writeFileSync(path, contents);
    const status = kind === 'fresh retry' ? 'queued' : kind === 'refund' ? 'finished' : kind;
    expect(() => recordRedTeamStatus({ ...f, loopPayload, status,
      ...(kind === 'fresh retry' ? { retryCount: 1 } : {}),
      ...(kind === 'refund' ? { refundRetry: true } : {}),
    }, { env: f.env })).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(contents);
    expect(existsSync(`${path}.retry-1`)).toBe(true);
  });

  it.each([-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1])(
    'never repairs a valid head-bound record with invalid retryCount %j', retryCount => {
      const f = fixture(), loopPayload = payload(f.head);
      recordRedTeamStatus({ ...f, loopPayload, status: 'queued' }, { env: f.env });
      const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
      const contents = JSON.stringify({ ...readRedTeamStatus(f), retryCount });
      writeFileSync(path, contents);
      expect(() => recordRedTeamStatus({ ...f, loopPayload, status: 'running' }, { env: f.env }))
        .toThrow('invalid red-team retry count');
      expect(readFileSync(path, 'utf8')).toBe(contents);
    });

  it('refuses to overwrite unreadable retry evidence so an operator can inspect it', () => {
    const f = fixture(), loopPayload = payload(f.head);
    recordRedTeamStatus({ ...f, loopPayload, status: 'queued', retryCount: 1 }, { env: f.env });
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    writeFileSync(path, '{broken');
    expect(() => recordRedTeamStatus({ ...f, loopPayload, status: 'running' }, { env: f.env })).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });

  it('does not invent an accept when no review run exists', () => {
    expect(readDrainRedTeamEvidence(fixture())).toEqual({ loopPayload: null, recorded: false,
      seatRecorded: false, completedRecorded: false, failedSeatCount: 0, scheduled: false, inFlight: false });
  });
  it('pins the accepted-label boundary with empty status and run stores', () => {
    const f = fixture();
    const evidence = readDrainRedTeamEvidence(f);
    // #5439/#5443: an acceptance label alone cannot invent scheduler work that never existed.
    expect(redTeamEnqueueHold({ ...f, ...evidence, labels: ['review:accepted'], comments: [] })).toBeNull();
    // A persisted accepting verdict holds before the job publishes its first status: the loop applies the labels
    // before the job can write one. It is not a live queue entry, so the never-scheduled deadline still applies.
    const run = { ...newRunRecord({ id: 'review-pr-5439', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }), ...payload(f.head) };
    writeRun(run, f.runsDir);
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ scheduled: true, inFlight: false, recorded: false });
    expect(readDrainRedTeamEvidence(f).queued).toBeUndefined();
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), labels: ['review:accepted'], comments: [] })).toMatch(/no recorded result/);
    // A disabled scheduler or a non-accepting run schedules nothing; the job's finished status supersedes the run.
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence({ ...f, env: { ...f.env, WE_REVIEW_RED_TEAM: 'off' } }), comments: [] })).toBeNull();
    writeRun({ ...run, verdict: { verdict: 'changes' } }, f.runsDir);
    expect(readDrainRedTeamEvidence(f).scheduled).toBe(false);
    writeRun(run, f.runsDir);
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'skipped' }, f);
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), comments: [] })).toBeNull();
  });
  it('an earlier finished status on the same head never supersedes a newer accepting run', () => {
    const f = fixture();
    // Review 1 of this head did not accept; a re-review of the unchanged head accepts before its job writes a status.
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'not-owed' }, f);
    const statusFile = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    utimesSync(statusFile, new Date(1_000_000), new Date(1_000_000));
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), comments: [] })).toBeNull();
    writeRun({ ...newRunRecord({ id: 'review-pr-2', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }), ...payload(f.head) }, f.runsDir);
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ scheduled: true, inFlight: false });
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), comments: [] })).toMatch(/no recorded result/);
    // The re-review's own later status supersedes the run again.
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'skipped' }, f);
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), comments: [] })).toBeNull();
  });
  it('a newer accepting run does not hide a finished but unpublished result on the same head', () => {
    const f = fixture();
    const result = { status: 'ran', foldedVerdict: 'changes', comment: 'withheld', findings: [] };
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result }, f);
    utimesSync(join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`), new Date(1_000_000), new Date(1_000_000));
    writeRun({ ...newRunRecord({ id: 'review-pr-3', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }), ...payload(f.head) }, f.runsDir);
    expect(readDrainRedTeamEvidence(f).status?.result?.comment).toBe('withheld');
  });
  it('recognizes queued scheduling for the live head only while its writer is alive', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'queued' }, { ...f, readPidStart: () => 'start' });
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => 'start' })).toMatchObject({ scheduled: true, queued: true, inFlight: false, recorded: false });
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), comments: [] })).toMatch(/no recorded result/);
    // A crashed job leaves a dead writer: still held, but not a live queue entry that blocks the deadline escape.
    const dead = readDrainRedTeamEvidence({ ...f, isAlive: () => false });
    expect(dead).toMatchObject({ scheduled: true, inFlight: false });
    expect(dead.queued).toBeUndefined();
  });
  // PR #6784 review: the reader and the recovery probe share one existence check, and unknown is never death.
  it.each([
    ['EINVAL', Object.assign(Error('invalid'), { code: 'EINVAL' })],
    ['a pid Node refuses', Object.assign(TypeError('bad pid'), { code: 'ERR_INVALID_ARG_TYPE' })],
    ['an error with no code', Error('unreadable')],
  ])('keeps a running writer live when the default kill(0) probe fails with %s', (_name, thrown) => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, { ...f, readPidStart: () => 'start' });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw thrown; });
    try {
      expect(readDrainRedTeamEvidence({ ...f, readPidStart: () => 'start' })).toMatchObject({ inFlight: true });
      // The injected-probe form of the same unknown (a throw) holds too, including a throwing birth-time read.
      expect(readDrainRedTeamEvidence({ ...f, isAlive: () => { throw Error('unknown'); } }).inFlight).toBe(true);
      expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => { throw Error('unknown'); } }).inFlight).toBe(true);
    } finally { kill.mockRestore(); }
    // Positive evidence still decides: ESRCH is death.
    const gone = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); });
    try { expect(readDrainRedTeamEvidence({ ...f, readPidStart: () => 'start' }).inFlight).toBe(false); }
    finally { gone.mockRestore(); }
  });
  // PR #5482 self-review: the review job and the drain resolve WE_RED_TEAM_SKIP_CARD_ONLY in separate processes.
  it('carries the writer\'s card-only skip decision to the drain, whatever the drain process resolves', () => {
    const f = fixture();
    const cardOnly = { ...payload(f.head), findings: { read: { netBasis: { rev: f.head }, netChangedFiles: ['backlog/123-card.md'], netRenameSources: [] } } };
    const live = { ...f, isAlive: () => true, readPidStart: () => 'start' };
    recordRedTeamStatus({ ...f, loopPayload: cardOnly, status: 'queued' }, { ...f, env: { ...f.env, WE_RED_TEAM_SKIP_CARD_ONLY: 'false' }, readPidStart: () => 'start' });
    expect(readDrainRedTeamEvidence(live).skipCardOnly).toBe(false);
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(live), comments: [] })).toMatch(/no recorded result/);
    recordRedTeamStatus({ ...f, loopPayload: cardOnly, status: 'queued' }, { ...f, env: { ...f.env, WE_RED_TEAM_SKIP_CARD_ONLY: 'true' }, readPidStart: () => 'start' });
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(live), env: { WE_RED_TEAM_SKIP_CARD_ONLY: 'false' }, comments: [] })).toBeNull();
  });
  it('holds an owing card-only run until the job records its skip decision', () => {
    const f = fixture();
    const read = { netBasis: { rev: f.head }, netChangedFiles: ['backlog/123-card.md'], netRenameSources: [] };
    writeRun({ ...newRunRecord({ id: 'review-pr-5439', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }), verdict: { verdict: 'accept' }, findings: { read } }, f.runsDir);
    expect(readDrainRedTeamEvidence(f).skipCardOnly).toBe(false);
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence(f), env: { WE_RED_TEAM_SKIP_CARD_ONLY: 'true' }, comments: [] })).toMatch(/no recorded result/);
    recordRedTeamStatus({ ...f, loopPayload: { verdict: { verdict: 'accept' }, findings: { read } }, status: 'queued' }, { ...f, env: { ...f.env, WE_RED_TEAM_SKIP_CARD_ONLY: 'true' }, readPidStart: () => 'start' });
    expect(redTeamEnqueueHold({ ...f, ...readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => 'start' }), comments: [] })).toBeNull();
  });
  it('does not mistake a reused pid for the original red-team process', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, { ...f, readPidStart: () => 'original-start' });
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => 'original-start' }).inFlight).toBe(true);
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => 'reused-start' }).inFlight).toBe(false);
  });
  describe('foreign host name with a stale record (host renamed after a crash)', () => {
    const run = (f, ageMs, extra = {}, writer = {}) => {
      recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, { ...f, host: 'old-name', readPidStart: () => 'start', ...writer });
      const at = new Date(Date.now() - ageMs);
      utimesSync(join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`), at, at);
      return readDrainRedTeamEvidence({ ...f, host: 'new-name', isAlive: () => true, ...extra });
    };
    it('counts a foreign-host run with a stale record and no live pid as dead', () => {
      expect(run(fixture(), 31 * 60_000, { isAlive: () => false })).toMatchObject({ inFlight: false, scheduled: true });
    });
    it('keeps a stale foreign-host run live while its pid is alive here with the same birth time', () => {
      expect(run(fixture(), 31 * 60_000, { isAlive: () => true, readPidStart: () => 'start' }).inFlight).toBe(true);
    });
    it('counts a stale foreign-host run as dead when its pid is alive here with a different birth time (reused pid)', () => {
      expect(run(fixture(), 31 * 60_000, { isAlive: () => true, readPidStart: () => 'reused-start' })).toMatchObject({ inFlight: false, scheduled: true });
    });
    it('stale foreign-host record in a different pid namespace stays live even with isAlive:false', () => {
      // Both namespaces are pinned so the guard is exercised on every platform (pidNamespace() is null on macOS).
      expect(run(fixture(), 31 * 60_000, { isAlive: () => false, namespace: 'pid:[new-namespace]' }, { namespace: 'pid:[old-namespace]' }).inFlight).toBe(true);
    });
    it('probes a stale foreign-host record that carries no pid namespace (legacy) and counts it dead when the pid is gone', () => {
      expect(run(fixture(), 31 * 60_000, { isAlive: () => false, namespace: 'pid:[new-namespace]' }, { namespace: null }).inFlight).toBe(false);
    });
    it('probes a stale foreign-host record in the same pid namespace and counts it dead when the pid is gone', () => {
      expect(run(fixture(), 31 * 60_000, { isAlive: () => false, namespace: 'pid:[same]' }, { namespace: 'pid:[same]' }).inFlight).toBe(false);
    });
    it('keeps a stale foreign-host run live while its birth time cannot be read here (unknown is never a kill)', () => {
      expect(run(fixture(), 31 * 60_000, { isAlive: () => true, readPidStart: () => null }).inFlight).toBe(true);
    });
    it('keeps a foreign-host run with a fresh record live', () => {
      expect(run(fixture(), 5 * 60_000).inFlight).toBe(true);
    });
    it('honors the stale-window setting', () => {
      const f = fixture();
      expect(run(f, 12 * 60_000, { isAlive: () => false, env: { ...f.env, WE_RED_TEAM_FOREIGN_HOST_STALE_MS: '600000' } }).inFlight).toBe(false);
    });
    it('keeps same-host behaviour: a stale record with a live pid stays live', () => {
      const f = fixture();
      recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, { ...f, host: 'same', readPidStart: () => 'start' });
      const at = new Date(Date.now() - 3_600_000);
      utimesSync(join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`), at, at);
      expect(readDrainRedTeamEvidence({ ...f, host: 'same', isAlive: () => true, readPidStart: () => 'start' }).inFlight).toBe(true);
    });
  });
  it.each([
    [{ host: 'review-host' }, { host: 'drain-host' }],
    [{ host: 'same-host', namespace: 'pid:[review]' }, { host: 'same-host', namespace: 'pid:[drain]' }],
  ])('does not waive a process outside the local pid table', (writer, reader) => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, { ...f, ...writer, readPidStart: () => 'start' });
    expect(readDrainRedTeamEvidence({ ...f, ...reader, isAlive: () => false }).inFlight).toBe(true);
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'ran' }, { ...f, ...writer });
    expect(readDrainRedTeamEvidence({ ...f, ...reader, isAlive: () => false })).toMatchObject({ inFlight: false, recorded: true });
  });
  it('reads a compact result object like the bare ran string', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: { status: 'ran', foldedVerdict: 'changes', comment: 'withheld' } }, f);
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => false })).toMatchObject({ scheduled: true, recorded: true });
  });
  it('preserves local liveness when the birth-time probe is unavailable or metadata is legacy', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, { ...f, readPidStart: () => 'start' });
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => null }).inFlight).toBe(true);
    const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    const status = JSON.parse(readFileSync(path, 'utf8'));
    delete status.host;
    delete status.pidStart;
    delete status.pidNamespace;
    writeFileSync(path, JSON.stringify(status));
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true }).inFlight).toBe(true);
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => false }).inFlight).toBe(false);
  });
  it('reads a bounded process birth-time probe and treats failures as unknown', () => {
    expect(pidStartTime(42, (cmd, args, opts) => {
      expect(cmd).toBe('ps');
      expect(args).toEqual(['-p', '42', '-o', 'lstart=']);
      expect(opts).toMatchObject({ timeout: 5000, maxBuffer: 4096, env: { LC_ALL: 'C', TZ: 'UTC' } });
      return '  Fri Oct 16 12:34:56 2026\n';
    })).toBe('Fri Oct 16 12:34:56 2026');
    expect(pidStartTime(42, () => { throw new Error('unavailable'); })).toBeNull();
    expect(pidStartTime(42, () => '  ')).toBeNull();
    expect(pidStartTime(-1, () => { throw new Error('must not execute'); })).toBeNull();
  });
  it('reads the persisted review payload and rejects stale heads, other PRs and repos', () => {
    const f = fixture();
    const run = { ...newRunRecord({ id: 'review-pr-5439', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }), ...payload(f.head) };
    writeRun(run, f.runsDir);
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ loopPayload: run, recorded: false, inFlight: false });
    for (const mismatch of [{ head: 'a'.repeat(40) }, { pr: 5443 }, { repo: 'other/repo' }]) {
      expect(readDrainRedTeamEvidence({ ...f, ...mismatch }).loopPayload).toBeNull();
    }
  });
  it('honors an existing seat row even when the result comment was never posted', () => {
    const f = fixture();
    const row = { dispatchKind: 'review-seat', seat: 'red-team', repo: f.repo, pr: f.pr, rev: f.head, status: 'ok' };
    expect(readDrainRedTeamEvidence({ ...f, readScorecards: () => [row] }).recorded).toBe(true);
    for (const mismatch of [{ rev: 'a'.repeat(40) }, { repo: 'other/repo' }, { pr: 5443 }, { dispatchKind: 'review-seat-speculative-discard' }]) {
      expect(readDrainRedTeamEvidence({ ...f, readScorecards: () => [{ ...row, ...mismatch }] }).recorded).toBe(false);
    }
  });
  it.each([
    [{ status: 'ok', foldedVerdict: 'changes', confirmedMissCount: 1 }, true],
    [{ status: 'error' }, false],
    [{ status: 'ok', seatStatus: 'error' }, false],
  ])('separates an existing seat from a completed execution: %j', (fields, completedRecorded) => {
    const f = fixture();
    const row = { dispatchKind: 'review-seat', seat: 'red-team', repo: f.repo, pr: f.pr, rev: f.head, ...fields };
    expect(readDrainRedTeamEvidence({ ...f, readScorecards: () => [row] }))
      .toMatchObject({ recorded: true, seatRecorded: true, completedRecorded });
  });
  it('a review-pr string ran cannot substitute for an actual completed seat', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), op: 'review-pr' }, status: 'finished', result: 'ran' }, f);
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ seatRecorded: false, completedRecorded: false });
  });
  it('a skipped provider pass is not evidence that a red team ran', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'skipped' }, f);
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ recorded: false, inFlight: false });
  });
  it('observes running, crashed and finished passes across reader restarts', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'running' }, f);
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true })).toMatchObject({ recorded: false, inFlight: true });
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => false })).toMatchObject({ recorded: false, inFlight: false });
    expect(readDrainRedTeamEvidence({ ...f, head: 'a'.repeat(40) })).toMatchObject({ recorded: false, inFlight: false });
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'ran' }, f);
    expect(readDrainRedTeamEvidence({ ...f, isAlive: () => true })).toMatchObject({ recorded: true, inFlight: false });
  });
});


it('surfaces a finished old card-only skip when the live head has no read', () => {
  const f = fixture(), oldHead = 'b'.repeat(40);
  f.head = 'a'.repeat(40);
  const loopPayload = { verdict: { verdict: 'changes' }, findings: { read: {
    netBasis: { rev: oldHead }, netChangedFiles: ['backlog/123-card.md'], diffText: '+card',
  } } };
  writeRun({ ...newRunRecord({ id: 'review-pr-old-card', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }),
    ...loopPayload, stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(1000).toISOString() }] }, f.runsDir);
  recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: 'skipped' }, f);
  expect(readDrainRedTeamEvidence(f)).toMatchObject({ loopPayload, recorded: false, seatRecorded: false,
    status: { status: 'finished', head: oldHead, skipCardOnly: true } });
  // The exact live-head read always wins over this historical fallback.
  writeRun({ ...newRunRecord({ id: 'review-pr-live', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }),
    ...payload(f.head), stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(2000).toISOString() }] }, f.runsDir);
  expect(readDrainRedTeamEvidence(f).loopPayload.findings.read.netBasis.rev).toBe(f.head);
});

it.each(['non-card read', 'missing read paths', 'non-card rename source', 'skipCardOnly false',
  'skipCardOnly missing', 'recorded seat', 'live-head seat', 'running', 'queued', 'not skipped', 'missing status'])(
  'historical fallback refuses %s and returns no live-head read', variant => {
    const f = fixture(), oldHead = 'c'.repeat(40);
    const loopPayload = { verdict: { verdict: 'changes' }, findings: { read: {
      netBasis: { rev: oldHead }, netChangedFiles: ['backlog/123-card.md'], diffText: '+card',
    } } };
    if (variant === 'non-card read') loopPayload.findings.read.netChangedFiles = ['scripts/code.mjs'];
    if (variant === 'missing read paths') delete loopPayload.findings.read.netChangedFiles;
    if (variant === 'non-card rename source') loopPayload.findings.read.netRenameSources = ['scripts/code.mjs'];
    writeRun({ ...newRunRecord({ id: 'review-pr-old-card-negative', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }),
      ...loopPayload }, f.runsDir);
    if (variant !== 'missing status') {
      recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: 'skipped' }, f);
      const path = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${oldHead}.json`);
      const status = JSON.parse(readFileSync(path, 'utf8'));
      if (variant === 'skipCardOnly false') status.skipCardOnly = false;
      if (variant === 'skipCardOnly missing') delete status.skipCardOnly;
      if (['running', 'queued'].includes(variant)) status.status = variant;
      if (variant === 'not skipped') status.result = 'error';
      writeFileSync(path, JSON.stringify(status));
    }
    const hasSeat = ['recorded seat', 'live-head seat'].includes(variant);
    const evidence = readDrainRedTeamEvidence({ ...f, isAlive: () => true, readPidStart: () => null,
      readScorecards: () => hasSeat ? [{ dispatchKind: 'review-seat', seat: 'red-team', repo: f.repo,
        pr: f.pr, rev: variant === 'live-head seat' ? f.head : oldHead }] : [] });
    expect(evidence).toEqual({ loopPayload: null, recorded: variant === 'live-head seat',
      seatRecorded: variant === 'live-head seat', completedRecorded: false,
      failedSeatCount: variant === 'live-head seat' ? 1 : 0, scheduled: variant === 'live-head seat', inFlight: false });
  });

it.each([['unparseable', 1, false], ['error', 1, false], ['ok', 0, true]])(
  'counts failed %s seats only for the exact repo/PR/head', (status, failedSeatCount, completedRecorded) => {
    const f = fixture();
    const row = { dispatchKind: 'review-seat', seat: 'red-team', repo: f.repo, pr: f.pr, rev: f.head, status };
    f.readScorecards = () => [row, { ...row, rev: 'a'.repeat(40) }, { ...row, repo: 'another/repo' }];
    expect(readDrainRedTeamEvidence(f)).toMatchObject({ failedSeatCount, completedRecorded, seatRecorded: true });
  });

import { readRecoveryWitness, RUN_MTIME_SLACK_MS, ABANDONED_REVIEW_AFTER_MS } from '../drain-red-team-evidence.mjs';
import { MAX_RUN_RECORDS_PARSED } from '../stream-filter-runs.mjs';
describe('bounded review evidence scans', () => {
  // Records 10 s apart by mtime. A record is written after its read step starts, so its mtime bounds that start.
  const big = { list: () => Array.from({ length: 5000 }, (_, i) => `review-pr-${i}`),
    stat: path => ({ mtimeMs: Number(path.match(/review-pr-(\d+)/)[1]) * 10_000 }) };
  const startedAt = ms => ({ stepTimings: [{ step: 'read', startedAt: new Date(ms).toISOString() }] });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s resolves the newest finished exact-head run among 5000 records without reaching the cap', (_name, reader) => {
    const f = fixture();
    let reads = 0;
    const run = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), ...startedAt(4999 * 10_000 - 1000) };
    const result = reader({ ...f, ...big, read: id => { reads++; return id === 'review-pr-4999' ? run : null; } });
    expect(result.ok).not.toBe(false);
    expect(result.newest ?? result.loopPayload).toEqual(run);
    expect(reads).toBe(1);
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s stops as soon as no unscanned record can have started after the match', (_name, reader) => {
    const f = fixture();
    let reads = 0;
    // The match started 35 s before its own last write, so the three newer-by-mtime records must be read first.
    const run = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), ...startedAt(4996 * 10_000 - 1000) };
    const result = reader({ ...f, ...big, read: id => { reads++; return id === 'review-pr-4996' ? run : null; } });
    expect(result.newest ?? result.loopPayload).toEqual(run);
    expect(reads).toBe(4);
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s holds when the newest exact-head match lies outside the parse window', (_name, reader) => {
    const f = fixture();
    let reads = 0;
    const run = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), ...startedAt(0) };
    const result = reader({ ...f, ...big, read: id => { reads++; return id === 'review-pr-0' ? run : null; } });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(reads).toBe(MAX_RUN_RECORDS_PARSED);
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s holds a match touched late whose old start cannot rule out the omitted records', (_name, reader) => {
    const f = fixture();
    let reads = 0;
    const run = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), ...startedAt(1000) };
    const result = reader({ ...f, ...big, read: id => { reads++; return id === 'review-pr-4999' ? run : null; } });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(redTeamEnqueueHold({ ...f, ...result, comments: [] })).toMatch(/scan-capped/);
    expect(reads).toBe(MAX_RUN_RECORDS_PARSED);
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s still holds for a newer unfinished re-review found before the early stop', (_name, reader) => {
    const f = fixture();
    const accepted = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), ...startedAt(4998 * 10_000 - 1000) };
    const unfinished = { ...accepted, verdict: null, pending: { kind: 'judge' }, effects: [], ...startedAt(4999 * 10_000 - 1000) };
    const result = reader({ ...f, ...big, read: id => ({ 'review-pr-4999': unfinished, 'review-pr-4998': accepted })[id] ?? null });
    expect(result).toMatchObject({ ok: false, reason: 'review-unfinished' });
  });
  describe('unfinished run on a superseded head', () => {
    const run = (f, rev, extra = {}) => ({ op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(rev), pending: { kind: 'effect' }, effects: [], ...startedAt(4999 * 10_000 - 1000), ...extra });
    const read = (f, rec) => readDrainRedTeamEvidence({ ...f, ...big, read: id => (id === 'review-pr-4999' ? rec : null) });
    it('does not hold the live head for an unfinished run on another head', () => {
      const f = fixture();
      expect(read(f, run(f, 'a'.repeat(40)))).not.toMatchObject({ reason: 'review-unfinished' });
    });
    it('holds for an unfinished rejecting or undecided run on another head', () => {
      const f = fixture();
      expect(read(f, run(f, 'a'.repeat(40), { verdict: { verdict: 'reject' } }))).toMatchObject({ ok: false, reason: 'review-unfinished' });
      expect(read(f, run(f, 'a'.repeat(40), { verdict: null }))).toMatchObject({ ok: false, reason: 'review-unfinished' });
    });
    it('holds for an unfinished run on the live head', () => {
      const f = fixture();
      expect(read(f, run(f, f.head))).toMatchObject({ ok: false, reason: 'review-unfinished' });
    });
    it('holds for an unfinished run whose head is unreadable', () => {
      const f = fixture();
      expect(read(f, run(f, 'not-a-sha'))).toMatchObject({ ok: false, reason: 'review-unfinished' });
    });
  });
  const statusFile = f => join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
  it('drain resolves a carried head among 5000 records when the carried-from review is the newest run', () => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const panel = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...startedAt(4999 * 10_000 - 1000) };
    let reads = 0;
    const result = readDrainRedTeamEvidence({ ...f, ...big, read: id => { reads++; return id === 'review-pr-4999' ? panel : null; } });
    expect(result.ok).not.toBe(false);
    expect(result).toMatchObject({ status: { status: 'finished' } });
    expect(reads).toBe(MAX_RUN_RECORDS_PARSED);
  });
  it('drain still reports a later panel that invalidates a carry among 5000 records', () => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const later = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload('d'.repeat(40)), ...startedAt(4999 * 10_000 - 1000) };
    const result = readDrainRedTeamEvidence({ ...f, ...big, read: id => id === 'review-pr-4999' ? later : null });
    expect(result).toMatchObject({ carryConflict: true, loopPayload: later });
  });
  it('drain holds a carried head when the newest same-PR run cannot be settled inside the window', () => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const panel = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...startedAt(1000) };
    const result = readDrainRedTeamEvidence({ ...f, ...big, read: id => id === 'review-pr-4999' ? panel : null });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  it('drain holds an uncarried status head whose exact-head review the window omitted', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'ran' }, f);
    // The newest run reviewed another head; the head's own review (and any re-review after it) lies past the cap.
    const other = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload('d'.repeat(40)), ...startedAt(4999 * 10_000 - 1000) };
    const result = readDrainRedTeamEvidence({ ...f, ...big, read: id => id === 'review-pr-4999' ? other : null });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  it('drain holds a status written before records the window omitted', () => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    // The omitted records were written after the status, so a newer exact-head accept could hide among them.
    utimesSync(statusFile(f), 1, 1);
    const panel = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...startedAt(4999 * 10_000 - 1000) };
    const result = readDrainRedTeamEvidence({ ...f, ...big, read: id => id === 'review-pr-4999' ? panel : null });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  // The first unread record (review-pr-4699) has mtime 46_990_000 ms. Both sides are mtimes, so a
  // status stamped in the same coarse tick, or within the slack after it, cannot prove the order.
  it.each([0, RUN_MTIME_SLACK_MS - 1])('drain holds a status stamped %i ms after the first omitted record', offset => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const at = new Date(4699 * 10_000 + offset);
    utimesSync(statusFile(f), at, at);
    const panel = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...startedAt(4999 * 10_000 - 1000) };
    const result = readDrainRedTeamEvidence({ ...f, ...big, read: id => id === 'review-pr-4999' ? panel : null });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  it('drain resolves a carried head whose status was stamped the full slack after the first omitted record', () => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const at = new Date(4699 * 10_000 + RUN_MTIME_SLACK_MS);
    utimesSync(statusFile(f), at, at);
    const panel = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...startedAt(4999 * 10_000 - 1000) };
    const result = readDrainRedTeamEvidence({ ...f, ...big, read: id => id === 'review-pr-4999' ? panel : null });
    expect(result.ok).not.toBe(false);
    expect(result).toMatchObject({ status: { status: 'finished' } });
  });
  // An unfinished card-only carry journal for this head, written before its compatibility status (a crash).
  const carryJournal = (f, from) => {
    const loopPayload = { verdict: null, carriedFrom: from, findings: { read: {
      netBasis: { rev: f.head }, diffText: '+card', netChangedFiles: ['backlog/123-card.md'] } } };
    expect(() => resumeRedTeamCarry({ ...f, loopPayload }, { env: f.env, eligible: () => true,
      intentRecorded: () => false, recordIntent: () => { throw Error('crash'); } })).toThrow('crash');
  };
  it('recovery resolves a carry journal past the cap from the existing scan, like the drain', () => {
    const f = fixture(), from = 'c'.repeat(40);
    carryJournal(f, from);
    // The newest same-PR run is the carried-from panel and started after every omitted record was written.
    const panel = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...startedAt(4999 * 10_000 - 1000) };
    let reads = 0;
    const args = { ...f, ...big, read: id => { reads++; return id === 'review-pr-4999' ? panel : null; } };
    expect(readDrainRedTeamEvidence(args)).toMatchObject({ carry: { step: 'intent' }, skipCardOnly: true });
    reads = 0;
    const witness = readRecoveryWitness(args);
    expect(witness.ok).not.toBe(false);
    expect(witness.newest).toBeNull();
    expect(witness.carryEvidence).toMatchObject({ carry: { step: 'intent' }, skipCardOnly: true });
    // The fallback reuses the capped scan: one parse budget for the witness and its carry evidence.
    expect(reads).toBe(MAX_RUN_RECORDS_PARSED);
    // The scheduler reads the resolvable carry instead of skipping the PR on a capped witness.
    let evidenceReads = 0;
    const rows = planRedTeamOnSkip({ repo: f.repo, refusals: [{ kind: 'already-reviewed-head', prNumber: f.pr }],
      rawPrs: [{ number: f.pr, headRefOid: f.head, comments: [], labels: ['review:accepted'] }],
      readWitness: key => readRecoveryWitness({ ...args, ...key }),
      readEvidence: key => { evidenceReads++; return readDrainRedTeamEvidence({ ...args, ...key }); },
      readStatus: () => null, readCarry: key => readRedTeamCarry({ ...key, env: f.env }),
      setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(), now: 0 });
    // The same decision as the uncapped read of this carry.
    expect(rows[0]).toMatchObject({ action: 'dispatch', mode: 'fresh' });
    expect(evidenceReads).toBe(1);
  });
  // Equal mtimes straddle the cap: positions 300 and 301 share one mtime. Both readers must read the
  // same window whichever record holds the older exact-head run, so they never disagree.
  it.each(['review-pr-a', 'review-pr-z'])('drain and recovery read the same window when equal mtimes straddle the cap (exact-head run on %s)', exactOn => {
    const f = fixture(), from = 'c'.repeat(40);
    carryJournal(f, from);
    const mtimes = { 'review-pr-panel': 100_000_000, 'review-pr-a': 50_000_000, 'review-pr-z': 50_000_000 };
    for (let i = 0; i < 298; i++) mtimes[`review-pr-f${String(i).padStart(4, '0')}`] = 60_000_000 + i;
    for (let i = 0; i < 1000; i++) mtimes[`review-pr-o${String(i).padStart(4, '0')}`] = 1000 + i;
    const runs = { 'review-pr-panel': { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...startedAt(99_990_000) },
      [exactOn]: { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), ...startedAt(49_000_000) } };
    const args = { ...f, list: () => Object.keys(mtimes),
      stat: path => ({ mtimeMs: mtimes[path.match(/(review-pr-[^/]+)\.json$/)[1]] }), read: id => runs[id] ?? null };
    const drain = readDrainRedTeamEvidence(args), witness = readRecoveryWitness(args);
    // The id-ascending window reads review-pr-a and omits review-pr-z.
    if (exactOn === 'review-pr-a') {
      expect(drain).toMatchObject({ ok: false, reason: 'scan-capped' });
      expect(witness).toMatchObject({ ok: false, reason: 'scan-capped' });
    } else {
      expect(drain).toMatchObject({ carry: { step: 'intent' } });
      expect(witness.carryEvidence).toMatchObject({ carry: { step: 'intent' } });
    }
  });
  it('recovery still holds a capped carry whose carried-from panel cannot be settled inside the window', () => {
    const f = fixture(), from = 'c'.repeat(40);
    carryJournal(f, from);
    const panel = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...startedAt(1000) };
    const result = readRecoveryWitness({ ...f, ...big, read: id => id === 'review-pr-4999' ? panel : null });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  it('recovery still holds a capped exact-head match even when a carry journal exists', () => {
    const f = fixture(), from = 'c'.repeat(40);
    carryJournal(f, from);
    const own = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), ...startedAt(1000) };
    const result = readRecoveryWitness({ ...f, ...big, read: id => id === 'review-pr-4999' ? own : null });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  // The status-file twin of the journal case: recovery's capped exact-head read defers to the drain's
  // status query, which resolves only once every omitted record predates the status by the slack.
  it.each([[RUN_MTIME_SLACK_MS - 1, false], [RUN_MTIME_SLACK_MS, true]])('recovery on a carried status stamped %i ms after the first omitted record resolves: %s', (offset, resolves) => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const at = new Date(4699 * 10_000 + offset);
    utimesSync(statusFile(f), at, at);
    const panel = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...startedAt(4999 * 10_000 - 1000) };
    const witness = readRecoveryWitness({ ...f, ...big, read: id => id === 'review-pr-4999' ? panel : null });
    if (!resolves) {
      expect(witness).toMatchObject({ ok: false, reason: 'scan-capped' });
      return;
    }
    expect(witness.ok).not.toBe(false);
    expect(witness.newest).toBeNull();
    expect(witness.carryEvidence).toMatchObject({ status: { status: 'finished' } });
    expect(witness.carryEvidence.ok).not.toBe(false);
  });
  it('recovery reports a later panel that invalidates a capped carry as carry evidence, never as a newest run', () => {
    const f = fixture(), from = 'c'.repeat(40);
    carryJournal(f, from);
    const later = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload('d'.repeat(40)), ...startedAt(4999 * 10_000 - 1000) };
    const witness = readRecoveryWitness({ ...f, ...big, read: id => id === 'review-pr-4999' ? later : null });
    expect(witness.newest).toBeNull();
    expect(witness.carryEvidence).toMatchObject({ carryConflict: true, loopPayload: later });
    expect(planRedTeamRecovery(witness)).toMatchObject({ mode: 'skip' });
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s holds an unreviewed head: absence of an exact-head run cannot be proven past the cap', (_name, reader) => {
    const f = fixture();
    const older = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload('d'.repeat(40)), ...startedAt(4999 * 10_000 - 1000) };
    const result = reader({ ...f, ...big, read: id => id === 'review-pr-4999' ? older : null });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s explicitly holds beyond the parse cap, including fallback scans', (_name, reader) => {
    const f = fixture();
    let reads = 0;
    const result = reader({ ...f, list: () => Array.from({ length: 5000 }, (_, i) => `review-pr-${i}`),
      stat: path => ({ mtimeMs: Number(path.match(/review-pr-(\d+)/)[1]) }),
      read: () => { reads++; return null; } });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(redTeamEnqueueHold({ ...f, ...result, comments: [] })).toMatch(/scan-capped/);
    expect(reads).toBe(MAX_RUN_RECORDS_PARSED);
  });
});

it.each([
  ['drain preserves ascending id ties below the cap', readDrainRedTeamEvidence, 'review-pr-a', 3],
  ['recovery preserves descending id ties below the cap', readRecoveryWitness, 'review-pr-b', 3],
])('%s', (_name, reader, expectedId, expectedReads) => {
  const f = fixture();
  const runs = {
    'review-pr-a': { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head),
      stepTimings: [{ step: 'read', startedAt: new Date(1000).toISOString() }] },
    'review-pr-b': { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), verdict: { verdict: 'changes' },
      stepTimings: [{ step: 'read', startedAt: new Date(1000).toISOString() }] },
    'review-pr-c': { op: 'review-pr', input: { repo: 'other', pr: f.pr }, ...payload(f.head) },
  };
  let reads = 0;
  const result = reader({ ...f, list: () => Object.keys(runs), stat: () => ({ mtimeMs: 1 }), read: id => { reads++; return runs[id]; } });
  expect(result.newest ?? result.loopPayload).toEqual(runs[expectedId]);
  expect(reads).toBe(expectedReads);
});

import { planRedTeamRecovery, planRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
describe('fail-closed run scan evidence', () => {
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s throws on a corrupt or unreadable record inside the scan window', (_name, reader) => {
    const f = fixture();
    expect(() => reader({ ...f, list: () => ['review-pr-a', 'review-pr-b'], stat: () => ({ mtimeMs: 1 }),
      read: id => { if (id === 'review-pr-b') throw Error('torn run'); return { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head) }; } })).toThrow('torn run');
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s lets a logically newer unfinished re-review win even when the finished run has a newer mtime', (_name, reader) => {
    const f = fixture();
    const completed = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head),
      stepTimings: [{ step: 'read', startedAt: new Date(1000).toISOString() }] };
    const unfinished = { ...completed, verdict: null, stepTimings: [{ step: 'read', startedAt: new Date(2000).toISOString() }] };
    const result = reader({ ...f, list: () => ['review-pr-completed', 'review-pr-unfinished'],
      stat: path => ({ mtimeMs: path.includes('completed') ? 4000 : 3000 }), read: id => id.includes('completed') ? completed : unfinished });
    expect(result).toMatchObject({ ok: false, reason: 'review-unfinished' });
    expect(redTeamEnqueueHold({ ...f, ...result, comments: [] })).toMatch(/unfinished/);
  });
  it('holds a finished writer when the cap prevents excluding an unfinished re-review', () => {
    const f = fixture();
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status: 'finished', result: 'ran' }, f);
    const result = readDrainRedTeamEvidence({ ...f, list: () => Array.from({ length: 5000 }, (_, i) => `review-pr-${i}`),
      stat: () => ({ mtimeMs: 1 }), read: () => null });
    expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
    expect(redTeamEnqueueHold({ ...f, ...result, comments: [], recorded: true })).toMatch(/scan-capped/);
  });
  it('uses the configured scan bound in both evidence paths', () => {
    const f = fixture();
    const platformPath = join(f.runsDir, '..', 'platform.json');
    writeFileSync(platformPath, JSON.stringify({ runs: { scan: { maxParses: 2 } } }));
    // Inject a tool settings block to leave the operator platform preference in control.
    for (const reader of [readDrainRedTeamEvidence, readRecoveryWitness]) {
      let reads = 0;
      const result = reader({ ...f, scanSettings: { file: {}, env: { WE_PLATFORM_PREFERENCES_FILE: platformPath } },
        list: () => ['review-pr-a', 'review-pr-b', 'review-pr-c'], stat: () => ({ mtimeMs: 1 }),
        read: () => { reads++; return null; } });
      expect(result).toMatchObject({ ok: false, reason: 'scan-capped' });
      expect(reads).toBe(2);
    }
  });
  it('recovery and skipped-PR scheduling explicitly refuse capped evidence', () => {
    expect(planRedTeamRecovery({ ok: false, reason: 'scan-capped' })).toMatchObject({ mode: 'skip', why: 'scan-capped' });
    const f = fixture();
    const rows = planRedTeamOnSkip({ repo: f.repo, refusals: [{ kind: 'already-reviewed-head', prNumber: f.pr }],
      rawPrs: [{ number: f.pr, headRefOid: f.head, comments: [], labels: ['review:accepted'] }],
      readEvidence: () => ({ ok: false, reason: 'scan-capped' }), readStatus: () => null,
      setting: { enabled: true }, lastDispatch: new Map(), now: 0 });
    expect(rows[0]).toMatchObject({ action: 'skip', why: 'scan-capped' });
  });
  it.each(['scan-capped', 'review-unfinished', 'run-start-missing'])('skipped-PR scheduling skips one PR on a %s witness instead of reading its writer', reason => {
    const f = fixture();
    let evidenceReads = 0;
    const rows = planRedTeamOnSkip({ repo: f.repo, refusals: [{ kind: 'already-reviewed-head', prNumber: f.pr }],
      rawPrs: [{ number: f.pr, headRefOid: f.head, comments: [], labels: ['review:accepted'] }],
      readWitness: () => ({ ok: false, reason }), readEvidence: () => { evidenceReads++; return {}; }, readStatus: () => null,
      setting: { enabled: true }, lastDispatch: new Map(), now: 0 });
    expect(rows[0]).toMatchObject({ action: 'skip', why: reason });
    expect(evidenceReads).toBe(0);
  });
});

import { planRedTeamStatusLabels } from '../red-team-status-labels.mjs';
it('capped evidence replaces a stale clear label with pending instead of preserving clearance', () => {
  const f = fixture();
  expect(planRedTeamStatusLabels({ ...f, labels: ['red-team:clear'], comments: [],
    evidence: { ok: false, reason: 'scan-capped' } })).toEqual({ add: 'red-team:pending', remove: ['red-team:clear'] });
});
it.each([
  ['an existing blocked label', ['red-team:blocked'], { add: null, remove: [] }],
  ['an existing pending label', ['red-team:pending'], { add: null, remove: [] }],
  ['a blocked label beside a stale clear label', ['red-team:clear', 'red-team:blocked'], { add: null, remove: ['red-team:clear'] }],
])('capped evidence keeps %s and adds nothing', (_name, labels, expected) => {
  const f = fixture();
  expect(planRedTeamStatusLabels({ ...f, labels, comments: [], evidence: { ok: false, reason: 'scan-capped' } })).toEqual(expected);
});

import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
describe('capped evidence never hides a recorded confirmed break', () => {
  const breakComment = f => ({ author: { login: 'web-everything' }, body: renderRedTeamComment({ pr: f.pr, rev: f.head,
    findings: [{ summary: 'break', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true }],
    provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes' }) });
  it.each(['scan-capped', 'review-unfinished', 'run-start-missing'])('enqueue hold keeps send-back precedence on %s evidence', reason => {
    const f = fixture();
    expect(redTeamEnqueueHold({ ...f, ok: false, reason, comments: [breakComment(f)], env: {} })).toMatch(/requiring send-back/);
    // Without a break the unknown evidence still holds; it is never released.
    expect(redTeamEnqueueHold({ ...f, ok: false, reason, comments: [], env: {} })).toMatch(new RegExp(`evidence unknown \\(${reason}\\)`));
  });
  it.each([[[]], [['red-team:pending']], [['red-team:clear']]])('status labels mark a capped PR with a confirmed break blocked (labels %j)', labels => {
    const f = fixture();
    const plan = planRedTeamStatusLabels({ ...f, labels, comments: [breakComment(f)], evidence: { ok: false, reason: 'scan-capped' } });
    expect(plan.add).toBe('red-team:blocked');
    expect(plan.remove).toEqual(labels);
  });
});

it('historical card-only fallback shares the total parse budget: the recursion parses no record again', () => {
  const f = fixture(), oldHead = 'c'.repeat(40);
  f.head = 'a'.repeat(40);
  const loopPayload = { verdict: { verdict: 'changes' }, findings: { read: {
    netBasis: { rev: oldHead }, netChangedFiles: ['backlog/123-card.md'], diffText: '+card',
  } } };
  writeRun({ ...newRunRecord({ id: 'review-pr-old-card', op: 'review-pr', input: { repo: f.repo, pr: f.pr } }),
    ...loopPayload, stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(1000).toISOString() }] }, f.runsDir);
  recordRedTeamStatus({ ...f, loopPayload, status: 'finished', result: 'skipped' }, f);
  const reads = [];
  const result = readDrainRedTeamEvidence({ ...f, read: (id, dir) => { reads.push(id); return readRun(id, dir); } });
  expect(result).toMatchObject({ loopPayload, status: { status: 'finished', head: oldHead, skipCardOnly: true } });
  // The outer exact-head and any-head scans parse the one record once; the recursive old-head read reuses that hit.
  expect(reads).toEqual(['review-pr-old-card']);
});
it('an older unfinished review does not replace a logically newer finished panel', () => {
  const f = fixture();
  const completed = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head),
    stepTimings: [{ step: 'read', startedAt: new Date(2000).toISOString() }] };
  const unfinished = { ...completed, verdict: null, stepTimings: [{ step: 'read', startedAt: new Date(1000).toISOString() }] };
  const result = readDrainRedTeamEvidence({ ...f, list: () => ['review-pr-completed', 'review-pr-unfinished'],
    stat: path => ({ mtimeMs: path.includes('completed') ? 4000 : 3000 }), read: id => id.includes('completed') ? completed : unfinished });
  expect(result.ok).not.toBe(false);
  expect(result.loopPayload).toEqual(completed);
});

describe('readRecoveryWitness carryEvidence shares the scan but keeps the drain tie order', () => {
  it('recovery fallback shares the total parse budget', () => {
    const f = fixture();
    let reads = 0;
    const other = { op: 'review-pr', input: { repo: f.repo, pr: f.pr + 1 }, ...payload(f.head) };
    const result = readRecoveryWitness({ ...f, list: () => Array.from({ length: 200 }, (_, i) => `review-pr-${i}`),
      stat: path => ({ mtimeMs: Number(path.match(/review-pr-(\d+)/)[1]) }), read: () => { reads++; return other; } });
    expect(result.newest).toBeNull();
    expect(result.carryEvidence).toBeDefined();
    expect(reads).toBe(200);
  });
  it('the drain fallback breaks equal starts by ascending id, unlike recovery', () => {
    const f = fixture(), from = 'c'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const start = { stepTimings: [{ step: 'read', startedAt: new Date(1000).toISOString() }] };
    // Ascending id selects the carried-from panel; descending would select the later-head panel (a carry conflict).
    const runs = { 'review-pr-a': { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...start },
      'review-pr-b': { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload('d'.repeat(40)), ...start } };
    let reads = 0;
    const args = { ...f, list: () => Object.keys(runs), stat: () => ({ mtimeMs: 5000 }), read: id => { reads++; return runs[id]; } };
    expect(readDrainRedTeamEvidence(args).carryConflict).toBeFalsy();
    reads = 0;
    const witness = readRecoveryWitness(args);
    expect(witness.carryEvidence.carryConflict).toBeFalsy();
    expect(reads).toBe(2);
  });
});

describe('abandoned and start-less review runs have a defined outcome', () => {
  const started = ms => ({ stepTimings: [{ step: 'read', startedAt: new Date(ms).toISOString() }] });
  const HOUR = 60 * 60 * 1000;
  const both = [['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]];
  const setup = (f, other, otherAt) => {
    const accepted = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), pending: null, effects: [], ...started(10_000) };
    const runs = { 'review-pr-accepted': accepted, 'review-pr-other': other(accepted) };
    return { accepted, args: { ...f, list: () => Object.keys(runs), read: id => runs[id],
      stat: path => ({ mtimeMs: path.includes('other') ? otherAt : 12_000 }) } };
  };
  it.each(both)('%s ignores a start-less record written before the selected run started', (_name, reader) => {
    const f = fixture();
    // A record that predates stepTimings: its last write precedes the accepted run's read start.
    const { accepted, args } = setup(f, a => ({ op: 'review-pr', input: a.input, ...payload(f.head), verdict: { verdict: 'changes' } }), 5_000);
    const result = reader(args);
    expect(result.ok).not.toBe(false);
    expect(result.newest ?? result.loopPayload).toEqual(accepted);
  });
  it.each(both)('%s holds a recent start-less record that may have started after the selected run', (_name, reader) => {
    const f = fixture();
    const { args } = setup(f, a => ({ op: 'review-pr', input: a.input, verdict: null, pending: null, effects: [], findings: {} }), 20_000);
    expect(reader({ ...args, now: 20_000 + 60_000 })).toEqual({ ok: false, reason: 'run-start-missing' });
  });
  it.each(both)('%s ignores a run that crashed before its read step once it is abandoned', (_name, reader) => {
    const f = fixture();
    const { accepted, args } = setup(f, a => ({ op: 'review-pr', input: a.input, verdict: null, pending: null, effects: [], findings: {} }), 20_000);
    const result = reader({ ...args, now: 20_000 + HOUR });
    expect(result.ok).not.toBe(false);
    expect(result.newest ?? result.loopPayload).toEqual(accepted);
  });
  it.each(both)('%s holds a newer verdict-less run while it may still be live, then ignores it once abandoned', (_name, reader) => {
    const f = fixture();
    const { accepted, args } = setup(f, a => ({ ...a, verdict: null, ...started(15_000) }), 20_000);
    expect(reader({ ...args, now: 20_000 + 60_000 })).toEqual({ ok: false, reason: 'review-unfinished' });
    const result = reader({ ...args, now: 20_000 + HOUR });
    expect(result.ok).not.toBe(false);
    expect(result.newest ?? result.loopPayload).toEqual(accepted);
  });
  // Each non-verdict clause of the unfinished check, alone: the newer run already carries a verdict,
  // so only its pending step or pending/in-flight effect can hold it (a verdict-null fixture would mask them).
  const withWork = [['a pending step', { pending: { kind: 'judge' } }], ['a pending effect', { effects: [{ status: 'pending' }] }],
    ['an in-flight effect', { effects: [{ status: 'in-flight' }] }]];
  it.each(both.flatMap(([name, reader]) => withWork.map(([what, work]) => [name, what, reader, work])))(
    '%s holds a verdict-bearing newer run with %s as review-unfinished', (_name, _what, reader, work) => {
      const f = fixture();
      const { args } = setup(f, a => ({ ...a, verdict: { verdict: 'accept' }, ...work, ...started(15_000) }), 20_000);
      expect(reader({ ...args, now: 20_000 + 60_000 })).toEqual({ ok: false, reason: 'review-unfinished' });
      expect(reader({ ...args, now: 20_000 + 30 * 24 * HOUR })).toEqual({ ok: false, reason: 'review-unfinished' });
    });
  // PR #6584: a refused clearance ends the run (`pending: null`, `outcome: 'refused'`) without applying the label, so it must
  // never read as a finished accept or rejection.
  const refusedEffect = { status: 'refused', attempts: 1, error: 'review-set-label.mjs refused before any write: SELF-CLEAR REFUSED — nothing was changed (#2844)' };
  const refusedShapes = [['an accept', { verdict: { verdict: 'accept' } }], ['a rejection', { verdict: { verdict: 'changes' } }]];
  it.each(both.flatMap(([name, reader]) => refusedShapes.map(([what, verdict]) => [name, what, reader, verdict])))(
    '%s holds a refused %s run as review-unfinished (never completed evidence)', (_name, _what, reader, verdict) => {
      const f = fixture();
      const { args } = setup(f, a => ({ ...a, ...verdict, pending: null, outcome: 'refused', effects: [refusedEffect], ...started(15_000) }), 20_000);
      expect(reader({ ...args, now: 20_000 + 60_000 })).toEqual({ ok: false, reason: 'review-unfinished' });
      expect(reader({ ...args, now: 20_000 + 30 * 24 * HOUR })).toEqual({ ok: false, reason: 'review-unfinished' });
    });
  it.each(both)('%s selects the same verdict-bearing newer run once nothing is pending (control)', (_name, reader) => {
    const f = fixture();
    const { args } = setup(f, a => ({ ...a, verdict: { verdict: 'accept' }, pending: null, effects: [{ status: 'applied' }], ...started(15_000) }), 20_000);
    const result = reader({ ...args, now: 20_000 + 60_000 });
    expect(result.ok).not.toBe(false);
    expect((result.newest ?? result.loopPayload).stepTimings).toEqual(started(15_000).stepTimings);
  });
  it.each(both)('%s never treats a run still waiting on a pending step or effect as abandoned', (_name, reader) => {
    const f = fixture();
    for (const waiting of [{ pending: { kind: 'judge' } }, { effects: [{ status: 'pending' }] }, { effects: [{ status: 'in-flight' }] }]) {
      const { args } = setup(f, a => ({ ...a, verdict: null, ...waiting, ...started(15_000) }), 20_000);
      expect(reader({ ...args, now: 20_000 + 30 * 24 * HOUR })).toEqual({ ok: false, reason: 'review-unfinished' });
    }
  });
  it.each(both)('%s never treats a rewound resume the review loop may still finish as abandoned', (_name, reader) => {
    const f = fixture();
    // rewindRunToStep clears verdict and pending but keeps the read start; the loop marks it resumeOf.
    const { args } = setup(f, a => ({ ...a, verdict: null, resumeOf: { attempts: 1 }, ...started(15_000) }), 20_000);
    expect(reader({ ...args, now: 20_000 + 30 * 24 * HOUR })).toEqual({ ok: false, reason: 'review-unfinished' });
  });
  it.each(both)('%s keeps an older stale verdict-less run from blocking a newer finished accept', (_name, reader) => {
    const f = fixture();
    const { accepted, args } = setup(f, a => ({ ...a, verdict: null, ...started(1_000) }), 2_000);
    const result = reader({ ...args, now: 20_000 });
    expect(result.ok).not.toBe(false);
    expect(result.newest ?? result.loopPayload).toEqual(accepted);
  });
});

describe('review ordering uses persisted run start time', () => {
  const started = ms => ({ stepTimings: [{ step: 'read', startedAt: new Date(ms).toISOString() }] });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s selects a newer rejection over an older acceptance touched later', (_name, reader) => {
    const f = fixture();
    const older = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head), ...started(1000) };
    const newer = { ...older, verdict: { verdict: 'changes' }, ...started(2000) };
    const result = reader({ ...f, list: () => ['review-pr-older', 'review-pr-newer'],
      stat: path => ({ mtimeMs: path.endsWith('review-pr-older.json') ? 4000 : 3000 }), read: id => id.includes('older') ? older : newer });
    expect(result.newest ?? result.loopPayload).toEqual(newer);
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s holds when either of two same-PR runs lacks a parseable start timestamp', (_name, reader) => {
    const f = fixture();
    const base = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head) };
    for (const [missing, invalidStart] of [
      ['review-pr-a', {}], ['review-pr-b', {}],
      ['review-pr-a', { stepTimings: [{ step: 'read', startedAt: 'not-a-date' }] }],
    ]) {
      const result = reader({ ...f, list: () => ['review-pr-a', 'review-pr-b'], stat: () => ({ mtimeMs: 1 }),
        read: id => id === missing ? { ...base, ...invalidStart } : { ...base, ...started(2000) } });
      expect(result).toEqual({ ok: false, reason: 'run-start-missing' });
      expect(redTeamEnqueueHold({ ...f, ...result, comments: [] })).toMatch(/run-start-missing/);
    }
  });
  it.each([['drain', readDrainRedTeamEvidence], ['recovery', readRecoveryWitness]])('%s still accepts a single run without a timestamp because no ordering is needed', (_name, reader) => {
    const f = fixture();
    const run = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head) };
    const result = reader({ ...f, list: () => ['review-pr-single'], stat: () => ({ mtimeMs: 1 }), read: () => run });
    expect(result.ok).not.toBe(false);
    expect(result.newest ?? result.loopPayload).toEqual(run);
  });
  it('uses the newer start time for the any-head selection that invalidates a carry', () => {
    const f = fixture(), from = 'c'.repeat(40), laterHead = 'd'.repeat(40);
    recordRedTeamStatus({ ...f, loopPayload: { ...payload(f.head), carriedFrom: from }, status: 'finished', result: 'skipped' }, f);
    const older = { op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(from), ...started(1000) };
    const newer = { ...older, ...payload(laterHead), verdict: { verdict: 'changes' }, ...started(2000) };
    const result = readDrainRedTeamEvidence({ ...f, list: () => ['review-pr-older', 'review-pr-newer'],
      stat: path => ({ mtimeMs: path.endsWith('review-pr-older.json') ? 4000 : 3000 }), read: id => id.includes('older') ? older : newer });
    expect(result).toMatchObject({ carryConflict: true, loopPayload: newer });
  });
});

it.each([['drain', readDrainRedTeamEvidence, 'review-pr-a'], ['recovery', readRecoveryWitness, 'review-pr-b']])('%s breaks equal start times by its existing id order, never by mtime', (_name, reader, expectedId) => {
  const f = fixture();
  const runs = Object.fromEntries(['review-pr-a', 'review-pr-b'].map(id => [id, {
    op: 'review-pr', input: { repo: f.repo, pr: f.pr }, ...payload(f.head),
    verdict: { verdict: id === 'review-pr-a' ? 'accept' : 'changes' },
    stepTimings: [{ step: 'read', startedAt: new Date(1000).toISOString() }],
  }]));
  const result = reader({ ...f, list: () => Object.keys(runs),
    stat: path => ({ mtimeMs: path.includes(expectedId) ? 3000 : 4000 }), read: id => runs[id] });
  expect(result.newest ?? result.loopPayload).toEqual(runs[expectedId]);
});

// A red-team result older than an unfinished review whose accept came by label (human cleared on the same head).
describe('settleUnknownEvidenceByComment: result older than the unfinished review, accepted on the same head', async () => {
  const { settleUnknownEvidenceByComment } = await import('../drain-red-team-evidence.mjs');
  const { renderRedTeamComment } = await import('../../operations/review-extra-seats.mjs');
  const pr = 6416, head = 'c'.repeat(40), other = 'd'.repeat(40);
  const T = Date.parse('2026-11-06T14:42:13Z');
  const iso = ms => new Date(ms).toISOString();
  const result = (rev = head, login = 'web-everything', findings = []) => ({ author: { login }, createdAt: iso(T),
    body: renderRedTeamComment({ pr, rev, findings, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: findings.length ? 'changes' : 'accept' }) });
  const accept = (sha = head, at = T + 14 * 60e3, login = 'web-everything') => ({ author: { login }, createdAt: iso(at),
    body: `Cleared by operator.\n<!-- reviewed-sha: ${sha} -->\n<!-- cleared-human: chalbert -->` });
  const started = T + 6 * 60e3; // unfinished review began after the result
  const bounds = o => ({ unfinishedUndecided: true, unfinishedStartedAt: started, unfinishedActiveAt: T + 16 * 60e3, evaluatedAt: T + 2 * 3600e3,
    completeHeadRead: () => ({ complete: true, blocked: false }), ...o });
  const unknown = o => Object.defineProperty({ ok: false, reason: 'review-unfinished' }, 'settleBounds', { value: bounds(o), enumerable: false });
  const settle = (ev, comments, reviews = []) => settleUnknownEvidenceByComment(ev, comments, pr, head, reviews);
  const review = (state, at, login = 'chalbert') => ({ state, submittedAt: iso(at), author: { login } });

  it('holds when a formal COMMENTED review was submitted after the accept (operator hold)', () => {
    expect(settle(unknown(), [result(), accept()], [review('COMMENTED', T + 20 * 60e3)])).toMatchObject({ ok: false });
  });
  it('holds when a formal CHANGES_REQUESTED review stands after the accept', () => {
    expect(settle(unknown(), [result(), accept()], [review('CHANGES_REQUESTED', T + 20 * 60e3)])).toMatchObject({ ok: false });
  });
  // "Nothing held after the accept" across the comment channels, not only formal reviews.
  it('holds when a later trusted comment is a body-derived hold (manifest baseline mismatch)', () => {
    const park = { author: { login: 'web-everything' }, createdAt: iso(T + 20 * 60e3), body: 'Drain parked: manifest baseline mismatch on this head.' };
    expect(settle(unknown(), [result(), accept(), park])).toMatchObject({ ok: false });
  });
  it('holds when a later human comment is unrecognised (e.g. a "hold" note), from any author', () => {
    for (const login of ['chalbert', 'web-everything']) {
      const note = { author: { login }, createdAt: iso(T + 20 * 60e3), body: 'hold — do not merge until I have looked at this' };
      expect(settle(unknown(), [result(), accept(), note])).toMatchObject({ ok: false });
    }
  });
  it('holds when a later comment is a changes-requested verdict', () => {
    const verdict = { author: { login: 'web-everything' }, createdAt: iso(T + 20 * 60e3), body: '🔁 review — changes requested\n\nfix the thing' };
    expect(settle(unknown(), [result(), accept(), verdict])).toMatchObject({ ok: false });
  });
  it('still settles when the only later comment is a recognised machine note (non-regression pin)', () => {
    const note = { author: { login: 'web-everything' }, createdAt: iso(T + 20 * 60e3), body: '' };
    expect(settle(unknown(), [result(), accept(), note])).toMatchObject({ ok: true, settledByComment: 'review-unfinished' });
  });
  it('holds (fails closed) when the formal reviews are unreadable or not supplied', () => {
    expect(settle(unknown(), [result(), accept()], null)).toMatchObject({ ok: false });
    expect(settleUnknownEvidenceByComment(unknown(), [result(), accept()], pr, head)).toMatchObject({ ok: false });
  });
  it('still settles when only reviews older than the accept exist', () => {
    expect(settle(unknown(), [result(), accept()], [review('COMMENTED', T + 8 * 60e3), review('APPROVED', T + 30 * 60e3)])).toMatchObject({ ok: true, settledByComment: 'review-unfinished' });
  });

  it('settles when a trusted accept on this head is newer than the unfinished review start', () => {
    expect(settle(unknown(), [result(), accept()])).toMatchObject({ ok: true, settledByComment: 'review-unfinished' });
  });
  it('hands the accept time (not the older result time) to the complete same-head read', () => {
    const seen = [];
    settle(unknown({ completeHeadRead: a => { seen.push(a.at); return { complete: true, blocked: false }; } }), [result(), accept()]);
    expect(seen).toEqual([T + 14 * 60e3]);
  });
  it('holds when the red-team result is missing', () => {
    expect(settle(unknown(), [accept()])).toMatchObject({ ok: false });
  });
  it('holds when the unfinished run is not quiet', () => {
    expect(settle(unknown({ unfinishedActiveAt: T + 2 * 3600e3 - 60e3 }), [result(), accept()])).toMatchObject({ ok: false });
  });
  it('holds when the complete read is blocked or incomplete', () => {
    expect(settle(unknown({ completeHeadRead: () => ({ complete: true, blocked: true }) }), [result(), accept()])).toMatchObject({ ok: false });
    expect(settle(unknown({ completeHeadRead: () => ({ complete: false, blocked: false }) }), [result(), accept()])).toMatchObject({ ok: false });
  });
  it('holds when the result is for another head', () => {
    expect(settle(unknown(), [result(other), accept()])).toMatchObject({ ok: false });
  });
  it('holds when the accept is for another head', () => {
    expect(settle(unknown(), [result(), accept(other)])).toMatchObject({ ok: false });
  });
  it('holds when the accept is older than the unfinished start', () => {
    expect(settle(unknown(), [result(), accept(head, started - 60e3)])).toMatchObject({ ok: false });
  });
  it('holds when the accept comes from an untrusted author', () => {
    expect(settle(unknown(), [result(), accept(head, T + 14 * 60e3, 'someone-else')])).toMatchObject({ ok: false });
  });
  it('holds when the result comes from an untrusted author', () => {
    expect(settle(unknown(), [result(head, 'someone-else'), accept()])).toMatchObject({ ok: false });
  });
  it('holds when the unfinished run already decided', () => {
    expect(settle(unknown({ unfinishedUndecided: false }), [result(), accept()])).toMatchObject({ ok: false });
  });
  it('holds when a confirmed break is on the head result', () => {
    const broken = [{ summary: 'break', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true }];
    const ev = settle(unknown(), [result(head, 'web-everything', broken), accept()]);
    expect(redTeamEnqueueHold({ ...ev, comments: [result(head, 'web-everything', broken), accept()], pr, head, env: {} })).toMatch(/break requiring send-back|evidence unknown/);
  });
});


describe('recovery while a quiet review awaits human confirm', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const setting = { enabled: true, retryCooldownMin: 30 };
  function parked({ status = 'running', age = ABANDONED_REVIEW_AFTER_MS, change = () => {}, writer = {}, writerAge = 0 } = {}) {
    const f = fixture(), id = 'review-pr-pending-confirm';
    const run = { ...newRunRecord({ id, op: 'review-pr', input: { repo: f.repo, pr: f.pr } }),
      findings: { read: { netBasis: { rev: f.head } } },
      verdict: { verdict: 'needs-human', humanRequired: true, lensVerdicts: { correctness: 'accept' }, findings: [] },
      pending: { kind: 'confirm', step: 'confirm', stepIndex: 1 }, effects: [],
      stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(now - 3 * ABANDONED_REVIEW_AFTER_MS).toISOString() }] };
    change(run);
    writeRun(run, f.runsDir);
    const runPath = join(f.runsDir, `${id}.json`), at = now - age;
    utimesSync(runPath, at / 1000, at / 1000);
    recordRedTeamStatus({ ...f, loopPayload: payload(f.head), status }, f);
    const writerPath = join(redTeamStatusDir(f.env), `${encodeURIComponent(f.repo)}-${f.pr}-${f.head}.json`);
    const raw = { ...JSON.parse(readFileSync(writerPath, 'utf8')), host: 'test-host', pidNamespace: 'test-ns',
      pid: 12345, pidStart: 'original-birth', ...writer };
    writeFileSync(writerPath, JSON.stringify(raw));
    utimesSync(writerPath, (now - writerAge) / 1000, (now - writerAge) / 1000);
    const before = readFileSync(runPath, 'utf8');
    const witness = () => readRecoveryWitness({ ...f, now });
    const decide = (probe = {}) => planRedTeamOnSkip({ repo: f.repo,
      refusals: [{ kind: 'already-reviewed-head', prNumber: f.pr, headSha: f.head }],
      rawPrs: [{ number: f.pr, headRefOid: f.head, comments: [], reviews: [] }],
      readWitness: witness, readEvidence: () => { throw Error('unexpected normalized read'); },
      headNeverReviewed: () => false, setting, now, lastDispatch: new Map(),
      recoveryOptions: { now, deadlineMs: 7_200_000,
        probe: { host: 'test-host', namespace: 'test-ns', isAlive: () => false, ...probe } } })[0];
    return { f, run, runPath, before, witness, decide };
  }

  it.each(['queued', 'running'])('redispatches a dead %s owner without settling the pending review', status => {
    const p = parked({ status });
    expect(redTeamOwedFor(p.run)).toBe(true);
    expect(p.witness().newest).toEqual(p.run);
    expect(p.witness().unfinishedReviewException).toBe(true);
    expect(p.decide()).toMatchObject({ action: 'dispatch', mode: 'fresh', staleRecovery: true, why: 'dead owner recovery' });
    expect(p.decide().escalate).toBeUndefined();
    expect(readFileSync(p.runPath, 'utf8')).toBe(p.before);
    expect(readDrainRedTeamEvidence({ ...p.f, now })).toEqual({ ok: false, reason: 'review-unfinished' });
  });

  it('keeps a live owner held even when the pending review is quiet', () => {
    const p = parked();
    expect(p.decide({ isAlive: () => true, readPidStart: () => 'original-birth' }))
      .toMatchObject({ action: 'skip', why: 'owner live' });
  });

  it('holds the exception witness when an old owner existence probe throws', () => {
    const p = parked({ writer: { pidStart: '2026-11-13T01:00:00Z' } });
    expect(p.witness().unfinishedReviewException).toBe(true);
    expect(p.decide({ isAlive: () => { throw Error('unreadable'); } }).action).toBe('skip');
  });

  it.each([[1_800_001, 'skip'], [7_200_000, 'skip'], [7_200_001, 'dispatch']])(
    'requires the full stale-run deadline for an exception foreign writer aged %i', (writerAge, action) => {
      const p = parked({ writer: { host: 'foreign-host', pidStart: '2026-11-13T01:00:00Z' }, writerAge });
      expect(p.witness().unfinishedReviewException).toBe(true);
      expect(p.decide().action).toBe(action);
    });

  it('does not mark a normally selected finished review as an exception', () => {
    const p = parked({ change: r => { r.verdict.verdict = 'accept'; r.pending = null; } });
    expect(p.witness().newest).toEqual(p.run);
    expect(p.witness()).not.toHaveProperty('unfinishedReviewException');
  });

  it.each([
    ['verified birth mismatch', () => 'reused-birth', 'dispatch'],
    ['matching birth', () => 'original-birth', 'skip'],
    ['unreadable birth', () => null, 'skip'],
    ['throwing birth probe', () => { throw Error('unreadable'); }, 'skip'],
  ])('PID reuse: %s', (_name, readPidStart, action) => {
    const p = parked();
    expect(p.decide({ isAlive: () => true, readPidStart }).action).toBe(action);
  });

  it.each([
    ['decided', { change: r => { r.verdict = { verdict: 'reject' }; } }],
    ['pending effect', { change: r => { r.effects = [{ key: 'effect', type: 'label', stepIndex: 1, index: 0, status: 'pending' }]; } }],
    ['in-flight effect', { change: r => { r.effects = [{ key: 'effect', type: 'label', stepIndex: 1, index: 0, status: 'in-flight' }]; } }],
    ['not quiet', { age: ABANDONED_REVIEW_AFTER_MS - 1 }],
    ['finished writer', { status: 'finished' }],
    ['other head', { change: r => { r.findings.read.netBasis.rev = 'c'.repeat(40); } }],
  ])('holds review-unfinished for %s', (_name, options) => {
    const p = parked(options);
    expect(p.witness()).toEqual({ ok: false, reason: 'review-unfinished' });
    expect(p.decide()).toMatchObject({ action: 'skip', why: 'review-unfinished', escalate: true });
    expect(readFileSync(p.runPath, 'utf8')).toBe(p.before);
  });

  it('carries the unfinished hit only in non-enumerable settle bounds', () => {
    const p = parked({ status: 'finished' }), failure = p.witness();
    expect(Object.keys(failure)).toEqual(['ok', 'reason']);
    expect(failure.settleBounds.unfinishedHit).toMatchObject({ id: p.run.id, run: p.run, at: now - ABANDONED_REVIEW_AFTER_MS });
  });

  it('selects the newest unfinished run for this head when another head has a newer undecided run', () => {
    const p = parked();
    const other = { ...p.run, id: 'review-pr-other-head', findings: { read: { netBasis: { rev: 'c'.repeat(40) } } },
      stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(now - 2 * ABANDONED_REVIEW_AFTER_MS).toISOString() }] };
    writeRun(other, p.f.runsDir);
    const at = now - ABANDONED_REVIEW_AFTER_MS;
    utimesSync(join(p.f.runsDir, `${other.id}.json`), at / 1000, at / 1000);
    expect(p.witness().newest).toEqual(p.run);
    expect(p.decide()).toMatchObject({ action: 'dispatch', staleRecovery: true });
  });

  // Operator send-back on PR #6784: a newer same-head rejection must win over an older pending clean review.
  it('never selects an older pending review over a newer same-head rejection (three-run case)', () => {
    const p = parked(); // old clean review pending at confirm on head A
    const write = (run, startAgo, writtenAgo) => {
      writeRun({ ...run, stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(now - startAgo).toISOString() }] }, p.f.runsDir);
      const at = now - writtenAgo;
      utimesSync(join(p.f.runsDir, `${run.id}.json`), at / 1000, at / 1000);
    };
    // Newer, finished `changes` on head A.
    write({ ...p.run, id: 'review-pr-newer-changes', verdict: { verdict: 'changes', findings: [] }, pending: null },
      2.5 * ABANDONED_REVIEW_AFTER_MS, 2 * ABANDONED_REVIEW_AFTER_MS);
    // Newest, undecided and pending on head B.
    write({ ...p.run, id: 'review-pr-other-head', findings: { read: { netBasis: { rev: 'c'.repeat(40) } } } },
      2 * ABANDONED_REVIEW_AFTER_MS, ABANDONED_REVIEW_AFTER_MS);
    const witness = p.witness();
    expect(witness).toEqual({ ok: false, reason: 'review-unfinished' });
    expect(witness.settleBounds.unfinishedHit).toBeUndefined();
    expect(p.decide()).toMatchObject({ action: 'skip', why: 'review-unfinished' });
    expect(readFileSync(p.runPath, 'utf8')).toBe(p.before);
  });

  it('holds as review-unfinished with an unread scan boundary', () => {
    const p = parked();
    const result = readRecoveryWitness({ ...p.f, now,
      scanSettings: { file: { runs: { scan: { maxParses: 1 } } }, env: {} }, warn: () => {},
      list: () => [p.run.id, 'review-pr-unread'], read: () => p.run,
      stat: () => ({ mtimeMs: now - ABANDONED_REVIEW_AFTER_MS }) });
    expect(result).toEqual({ ok: false, reason: 'review-unfinished' });
    expect(result.settleBounds.unreadBoundaryAt).toBeDefined();
    expect(planRedTeamRecovery(result)).toMatchObject({ mode: 'skip', why: 'review-unfinished' });
  });
});
