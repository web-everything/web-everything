import { runGhSync } from '../gh-throttle.mjs';
import { redTeamForHead, redTeamMarker } from '../red-team-gate.mjs';
import { latestAcceptRecord } from '../accept-carry-forward.mjs';
import { proveCardOnlyHeadMove } from '../card-only-head-move.mjs';
import * as numbering from '../numbering-carry.mjs';
import { describe, it, expect, vi } from 'vitest';
import { cardOnlyHeadMoveCandidate, normalizeRedTeamResult, planRedTeamOnSkip, runRedTeamOnSkip, resolveReviewRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { resetCascadeLogForTest } from '../policy-cascade.mjs';
import { readDrainRedTeamEvidence, readRedTeamStatus, recordRedTeamStatus, redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../gh-throttle.mjs', async importOriginal => ({
  ...await importOriginal(), runGhSync: vi.fn(),
}));
vi.mock('../../operations/needs-you-feed.mjs', async importOriginal => ({
  ...await importOriginal(), publishAttention: vi.fn(),
}));
// Pin the live merger identity alongside legacy authors; hermetic settings omit
// the host's configured App roles. Exercise the real marker-authorship gate.
vi.mock('../github-app-identity.mjs', async importOriginal => {
  const original = await importOriginal();
  return { ...original, readBotLogins: () => [...original.readBotLogins(), 'plateau-merger', 'plateau-merger[bot]'] };
});

const repo = 'web-everything/web-everything', head = 'a'.repeat(40), pr = 5762;
const payload = () => ({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } });
function fixture(over = {}) {
  return { repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
    rawPrs: [{ number: pr, headRefOid: head, comments: [], reviews: [] }],
    readEvidence: () => ({ loopPayload: payload(), recorded: false }), readStatus: () => null,
    now: 2_000_000, setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(), ...over };
}
const decide = over => planRedTeamOnSkip(fixture(over))[0];

describe('R100 — #5910 accepted stored review does not owe a red team', () => {
  const storedHead = '682e81b3ae1c'.padEnd(40, '0'), storedPr = 5910;
  function storedFixture(over = {}) {
    return fixture({
      refusals: [{ kind: 'already-reviewed-head', prNumber: storedPr, headSha: storedHead }],
      // This R100 fixture previously had only a label; a real accepted head needs its trusted accept comment.
      rawPrs: [{ number: storedPr, headRefOid: storedHead, labels: ['review:accepted'], reviews: [],
        comments: [{ body: `✅ review — accepted\n<!-- reviewed-sha: ${storedHead} -->`, author: { login: 'web-everything' } }] }],
      readEvidence: () => ({ loopPayload: {
        verdict: { verdict: 'needs-human', humanRequired: false },
        findings: { read: { netBasis: { rev: storedHead },
          diffText: 'diff --git a/backlog/5910-card.md b/backlog/5910-card.md\n+update',
          netChangedFiles: ['backlog/5910-card.md'], netRenameSources: [] } },
      } }),
      ...over,
    });
  }
  function storedRun(over = {}) {
    const f = storedFixture();
    const evidence = f.readEvidence();
    evidence.loopPayload.verdict = { verdict: 'accept' };
    evidence.seatRecorded = false;
    evidence.status = { status: 'finished', result: 'not-owed' };
    return runFixture({ ...f, readEvidence: () => evidence,
      readStatus: () => ({ status: 'finished', result: 'not-owed' }),
      plan: { refusals: f.refusals }, now: () => f.now, ...over });
  }

  it.each([['review:accepted'], [{ name: 'review:accepted' }]].map(labels => [labels]))(
    'refuses historical non-accepting stored review despite accepted labels %j', labels => {
      const f = storedFixture(); f.rawPrs[0].labels = labels;
      expect(planRedTeamOnSkip(f)).toEqual([{ prNumber: storedPr, head: storedHead,
        action: 'skip', why: 'stored review does not owe a red team' }]);
    });

  it.each(['inFlight', 'queued'])('skips an accepted not-owed review while %s', key => {
    const f = storedFixture(), evidence = { ...f.readEvidence(), [key]: true };
    f.readEvidence = () => evidence;
    expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip', why: 'red-team pass in flight' });
  });

  it('skips an accepted not-owed review with a prior error status row', () => {
    const readStatus = vi.fn(() => ({ status: 'finished', head: storedHead, result: 'error' }));
    expect(planRedTeamOnSkip(storedFixture({ readStatus }))[0])
      .toMatchObject({ action: 'skip', why: 'stored review does not owe a red team' });
    expect(readStatus).toHaveBeenCalledWith({ repo, pr: storedPr, head: storedHead });
  });

  it('skips an accepted not-owed review with recorded red-team evidence', () => {
    const f = storedFixture(), evidence = { ...f.readEvidence(), recorded: true };
    f.readEvidence = () => evidence;
    expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip', why: 'stored review does not owe a red team' });
  });

  it('fails closed when prior status is unreadable for an accepted not-owed review', () => {
    const f = storedFixture({ readStatus: () => { throw Error('unreadable'); } });
    expect(planRedTeamOnSkip(f)[0])
      .toMatchObject({ action: 'skip', why: 'red-team evidence unreadable; inspect stored evidence before retrying' });
  });

  it.each([[], ['review:human'], undefined, null, 'review:accepted'].map(labels => [labels]))(
    'keeps the existing skip without readable accepted labels %j', labels => {
      const f = storedFixture(); f.rawPrs[0].labels = labels;
      expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip', why: 'stored review does not owe a red team' });
    });

  it.each(['b'.repeat(40), undefined])('keeps the existing skip for a mismatched or missing stored head %j', rev => {
    const f = storedFixture(), evidence = f.readEvidence();
    evidence.loopPayload.findings.read.netBasis.rev = rev;
    f.readEvidence = () => evidence;
    expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip', why: 'stored review does not owe a red team' });
  });

  it('fails closed on unreadable stored evidence or comments on an accepted head', () => {
    const f = storedFixture({ readEvidence: () => { throw Error('unreadable'); } });
    expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip', why: 'red-team evidence unreadable; inspect stored evidence before retrying' });
    f.rawPrs[0].comments = undefined;
    expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip', why: 'PR comments unreadable' });
  });

  it('default settlement posts the head-bound reasoned marker once without consuming dispatch capacity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-stored-clear-'));
    const take = vi.fn(), log = vi.fn();
    const o = storedRun({ env: { WE_SHARED_RUNS_DIR: join(dir, 'runs') }, log,
      capacity: { lanes: 0, budget: { left: 0 }, remainingStarts: 0, take } });
    runGhSync.mockImplementation((_args, options) => {
      o.rawPrs[0].comments.push({ body: options.input, author: { login: 'web-everything' } });
    });
    try {
      expect(runRedTeamOnSkip(o)).toMatchObject({
        rows: [{ action: 'clear', why: 'not owed (stored review)' }], dispatched: [], notStarted: [],
      });
      expect(runGhSync).toHaveBeenCalledOnce();
      expect(runGhSync).toHaveBeenCalledWith([
        'pr', 'comment', String(storedPr), `--repo=${repo}`, '--body-file', '-',
      ], expect.objectContaining({ input: expect.stringContaining('not owed (stored review)') }));
      expect(o.rawPrs[0].comments.at(-1).body.split('\n')[0]).toBe(redTeamMarker(storedPr, storedHead));
      expect(redTeamForHead(o.rawPrs[0].comments, storedPr, storedHead)).toEqual({ pr: storedPr, rev: storedHead, findings: [] });
      expect(redTeamForHead(o.rawPrs[0].comments, storedPr, 'b'.repeat(40))).toBeNull();
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'red-team result already on head' });
      expect(runGhSync).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('red team cleared'));
      expect(o.capacity).toEqual({ lanes: 0, budget: { left: 0 }, remainingStarts: 0, take });
      expect(take).not.toHaveBeenCalled();
      expect(o.dispatch).not.toHaveBeenCalled();
      expect(o.lastDispatch.size).toBe(0);
    } finally {
      runGhSync.mockReset();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['policy-clear', 'already'])('retains clear for settlement outcome %s', outcome => {
    const settle = vi.fn(() => ({ outcome })), o = storedRun({ settle });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'clear', why: 'not owed (stored review)' });
    expect(settle).toHaveBeenCalledOnce();
    expect(o.syncLabels).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({
      redTeam: { status: 'not-owed' }, repo, pr: storedPr, head: storedHead, readHead: storedHead,
      accepted: true, comments: o.rawPrs[0].comments, reason: 'not owed (stored review)',
    }));
    expect(o.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['throws', () => { throw Error('offline'); }, 'offline'],
    ['throws an unprintable value', () => { throw { message: { toString: null } }; }, 'unprintable error'],
    ['returns non-policy', () => ({ outcome: 'non-policy', reason: 'post failed' }), 'post failed'],
    ['returns unknown', () => undefined, 'unknown outcome'],
  ])('settlement that %s becomes a skip without throwing', (_name, settle, why) => {
    const o = storedRun({ settle });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: `clear failed: ${why}` });
    expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
    expect(o.lastDispatch.size).toBe(0);
  });

  it('dry run preserves the clear plan without settling or spending capacity', () => {
    const settle = vi.fn(), o = storedRun({ settle, dryRun: true });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'clear', why: 'dry run (clear)' });
    expect(settle).not.toHaveBeenCalled();
    expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
    expect(o.lastDispatch.size).toBe(0);
  });

  it('a red-team result already on the head keeps the existing skip and never settles', () => {
    const settle = vi.fn(), readEvidence = vi.fn(), o = storedRun({ settle, readEvidence });
    o.rawPrs[0].comments.push({ body: redTeamMarker(storedPr, storedHead), author: { login: 'web-everything' } });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'red-team result already on head' });
    expect(settle).not.toHaveBeenCalled();
    expect(readEvidence).not.toHaveBeenCalled();
  });
});

describe('planRedTeamOnSkip — heal a previously skipped card-only head', () => {
  const cardPayload = () => {
    const loopPayload = payload();
    Object.assign(loopPayload.findings.read, { diffText: 'diff --git a/backlog/5872-card.md b/backlog/5872-card.md\n+update', netChangedFiles: ['backlog/5872-card.md'], netRenameSources: [] });
    return loopPayload;
  };
  const heal = (over = {}) => ({
    readEvidence: () => ({ loopPayload: cardPayload(), recorded: false }),
    readStatus: () => ({ status: 'finished', head, result: 'skipped', skipCardOnly: true, loopPayload: cardPayload() }),
    ...over,
  });

  it.each(['skipped', { status: 'skipped', policy: 'card-only' }])(
    'legacy string or explicit card-only object %j dispatches fresh', result => {
      expect(decide(heal({ readStatus: () => ({ status: 'finished', head, result, skipCardOnly: true, loopPayload: cardPayload() }) })))
        .toMatchObject({ action: 'dispatch', mode: 'fresh' });
    });

  it.each([1, 2])('card-only settlement cannot restore a spent retry count of %i', retryCount => {
    const status = { ...heal().readStatus(), retryCount };
    expect(decide(heal({ readStatus: () => status })))
      .toMatchObject({ action: 'skip', why: 'red-team retry already spent; inspect stored evidence' });
  });

  it.each([{ status: 'skipped' }, { status: 'skipped', reason: 'quota exhausted' },
    { status: 'skipped', reason: 'red team skipped: card-only' }])(
    'policy-absent object %j never heals even with a complete card-only read', result => {
      expect(decide(heal({ readStatus: () => ({ status: 'finished', head, result, skipCardOnly: true, loopPayload: cardPayload() }) })))
        .toMatchObject({ action: 'skip', why: 'prior result skipped (status finished); not re-run' });
    });

  it.each(['other', null, false, ''])('does not heal an explicit non-card-only policy %j', policy => {
    const result = { status: 'skipped', policy, reason: 'quota exhausted' };
    expect(decide(heal({ readStatus: () => ({ status: 'finished', head, result, skipCardOnly: true, loopPayload: cardPayload() }) })))
      .toMatchObject({ action: 'skip', why: 'prior result skipped (status finished); not re-run' });
  });

  it.each([
    { diffText: '' }, { diffText: '  \n ' }, { diffText: undefined },
    { netBasis: { rev: 'b'.repeat(40) } }, { netBasis: {} },
  ])('does not heal incomplete or mismatched stored read %j', read => {
    const loopPayload = cardPayload(); Object.assign(loopPayload.findings.read, read);
    expect(decide(heal({ readStatus: () => ({ status: 'finished', head, result: 'skipped', skipCardOnly: true, loopPayload }) })))
      .toMatchObject({ action: 'skip', why: 'prior result skipped (status finished); not re-run' });
  });

  it('non-card-only skipped status still skips with its existing not-re-run reason', () => {
    const loopPayload = cardPayload();
    loopPayload.findings.read.netChangedFiles = ['scripts/example.mjs'];
    expect(decide(heal({ readEvidence: () => ({ loopPayload, recorded: false }),
      readStatus: () => ({ status: 'finished', head, result: 'skipped', skipCardOnly: true, loopPayload }) })))
      .toMatchObject({ action: 'skip', why: 'prior result skipped (status finished); not re-run' });
  });

  it('a trusted comment already on the head skips healing before reading evidence', () => {
    const body = renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'm', findings: [], foldedVerdict: 'accept' });
    const readEvidence = vi.fn();
    expect(decide(heal({ rawPrs: [{ number: pr, headRefOid: head, comments: [{ body, author: { login: 'web-everything' } }] }], readEvidence })))
      .toMatchObject({ action: 'skip', why: 'red-team result already on head' });
    expect(readEvidence).not.toHaveBeenCalled();
  });

  it.each([false, undefined, 'true'])('fails closed when stored skipCardOnly is %j instead of true', skipCardOnly => {
    expect(decide(heal({ readStatus: () => ({ status: 'finished', head, result: 'skipped', skipCardOnly, loopPayload: cardPayload() }) })).action).toBe('skip');
  });

  it.each(['queued', 'running'])('does not heal an unfinished %s skip', status => {
    expect(decide(heal({ readStatus: () => ({ status, head, result: 'skipped', skipCardOnly: true, loopPayload: cardPayload() }) })).action).toBe('skip');
  });

  it.each([
    { netChangedFiles: [] },
    { netChangedFiles: null },
    { netChangedFiles: ['backlog/5872-card.md'], netRenameSources: ['scripts/moved-code.mjs'] },
    { netChangedFiles: ['backlog/5872-card.md'], netRenameSources: 'unreadable' },
  ])('does not heal unknown or non-card-only net paths %j', paths => {
    const loopPayload = cardPayload(); Object.assign(loopPayload.findings.read, paths);
    expect(decide(heal({ readEvidence: () => ({ loopPayload, recorded: false }),
      readStatus: () => ({ status: 'finished', head, result: 'skipped', skipCardOnly: true, loopPayload }) })).action).toBe('skip');
  });

  it('card-only healing still observes the recovery cooldown', () => {
    const lastDispatch = new Map([[`${repo}#${pr}@${head}`, 200_001]]);
    expect(decide(heal({ lastDispatch })).why).toBe('retry cooldown active');
  });
});

describe('planRedTeamOnSkip', () => {
  it('ignores every other refusal kind', () => {
    expect(planRedTeamOnSkip(fixture({ refusals: [{ kind: 'live-job', prNumber: pr }] }))).toEqual([]);
  });
  it('a: disabled refuses before reading evidence', () => {
    const readEvidence = vi.fn();
    expect(decide({ setting: { enabled: false }, readEvidence }).why).toBe('reviewRedTeamOnSkip.enabled=false');
    expect(readEvidence).not.toHaveBeenCalled();
  });
  it.each([null, 'abc', 'b'.repeat(40)])('b: refuses missing, malformed or changed live head %s', h => {
    expect(decide({ rawPrs: [{ number: pr, headRefOid: h, comments: [] }] }).action).toBe('skip');
  });
  it('b: accepts a live head when the refusal did not supply headSha', () => {
    expect(decide({ refusals: [{ kind: 'already-reviewed-head', prNumber: pr }] }).action).toBe('dispatch');
  });
  it('c: never dispatches when a trusted result already covers this head', () => {
    const body = renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'm', findings: [], foldedVerdict: 'accept' });
    const readEvidence = vi.fn();
    expect(decide({ rawPrs: [{ number: pr, headRefOid: head, comments: [{ body, author: { login: 'web-everything' } }] }], readEvidence }).why)
      .toBe('red-team result already on head');
    expect(readEvidence).not.toHaveBeenCalled();
  });
  it('refuses unreadable comments or evidence instead of assuming no pass', () => {
    expect(decide({ rawPrs: [{ number: pr, headRefOid: head }] }).action).toBe('skip');
    expect(decide({ readEvidence: () => { throw Error('unreadable'); } }).action).toBe('skip');
    expect(decide({ readStatus: () => { throw Error('unreadable'); } }).action).toBe('skip');
  });
  it('d: a non-accept or missing review never dispatches', () => {
    for (const loopPayload of [null, { verdict: { verdict: 'changes' } }]) {
      expect(decide({ readEvidence: () => ({ loopPayload }) }).action).toBe('skip');
    }
  });
  it('refuses an accepting payload pinned to another head', () => {
    const loopPayload = payload(); loopPayload.findings.read.netBasis.rev = 'b'.repeat(40);
    expect(decide({ readEvidence: () => ({ loopPayload }) }).action).toBe('skip');
  });
  it.each(['inFlight', 'queued'])('e: does not dispatch while %s', key => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), [key]: true }) }).why).toBe('red-team pass in flight');
  });
  it('f: resumes the #5762 shape: recorded pass with a failed comment', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
      readStatus: () => ({ status: 'finished', result: { status: 'ran', comment: 'error' } }) }))
      .toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it.each(['ran', 'resumed'])('f: a posted %s result awaits visibility', status => {
    for (const comment of ['posted', { status: 'posted' }]) {
      expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
        readStatus: () => ({ result: { status, comment } }) }).why).toBe('result posted; comment not visible yet');
    }
  });
  it('f: a recorded advisory accept resumes with a finished clean status', () => {
    const loopPayload = payload();
    loopPayload.verdict = { verdict: 'needs-human', humanRequired: true,
      lensVerdicts: { correctness: 'accept' }, findings: [], admittedFindings: [] };
    expect(decide({ readEvidence: () => ({ loopPayload, recorded: true }),
      readStatus: () => ({ status: 'finished', result: { status: 'ran' } }) })).toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it('f: a recorded row with no status skips with an unknown prior result', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }) }))
      .toMatchObject({ action: 'skip', why: 'prior result unknown (status missing); not re-run' });
  });
  it.each(['error', 'skipped', 'disabled', 'not-owed', null])('f: a recorded non-recoverable result %s never resumes', prior => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
      readStatus: () => ({ status: 'finished', result: { status: prior } }) }))
      .toMatchObject({ action: 'skip', why: `prior result ${prior ?? 'unknown'} (status finished); not re-run` });
  });
  it.each(['resumed', { status: 'resumed', comment: 'error' }, { status: 'resumed', comment: { status: 'error' } }])('f: a failed recovery result %j remains eligible with recorded evidence', result => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true, completedRecorded: true }),
      readStatus: () => ({ status: 'finished', result }) })).toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it('f: a string error result never resumes', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
      readStatus: () => ({ status: 'finished', result: 'error' }) })).toMatchObject({ action: 'skip' });
  });
  it.each(['ran', 'resumed'])('f: unfinished statuses cannot authorize %s resume', prior => {
    for (const status of ['queued', 'running', undefined]) {
      expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true }),
        readStatus: () => ({ status, result: { status: prior } }) }).action).toBe('skip');
    }
  });
  it('f: a legacy string ran result authorizes resume', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true, completedRecorded: true }),
      readStatus: () => ({ status: 'finished', result: 'ran' }) })).toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it('f: missing recorded evidence cannot authorize a fresh pass', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload() }) }).action).toBe('skip');
  });
  it('f: fresh dispatch only when neither status nor row exists', () => {
    expect(decide()).toMatchObject({ action: 'dispatch', mode: 'fresh' });
  });
  it.each(['error', 'skipped', 'disabled', 'not-owed', 'ran', 'resumed', null])('f: handles an unrecorded prior result %s according to its run evidence', prior => {
    expect(decide({ readStatus: () => ({ status: 'finished', result: prior }) }).action)
      .toBe(['ran', 'resumed'].includes(prior) ? 'dispatch' : 'skip');
    expect(decide({ readStatus: () => ({ status: 'finished', result: { status: prior } }) }).action)
      .toBe(prior === 'resumed' ? 'dispatch' : 'skip');
  });
  it.each(['ran', 'resumed', { status: 'resumed' }])('f: %j without a seat result dispatches fresh', result => {
    expect(decide({ readStatus: () => ({ status: 'finished', result }) }))
      .toMatchObject({ action: 'dispatch', mode: 'fresh' });
  });
  it.each([undefined, 'finished', 'running'])('f: a null completion without queued provenance skips (stored status %s)', storedStatus => {
    const status = { status: 'finished', result: null };
    expect(decide({ readStatus: () => status,
      readEvidence: () => ({ loopPayload: payload(), recorded: false, seatRecorded: false,
        ...(storedStatus ? { status: { ...status, status: storedStatus } } : {}) }) }))
      .toMatchObject({ action: 'skip', why: 'prior result unknown (status finished); not re-run' });
  });
  it('f: a normalized null completion with original queued evidence dispatches fresh', () => {
    expect(decide({ readStatus: () => ({ status: 'finished', result: null }),
      readEvidence: () => ({ loopPayload: payload(), recorded: false, seatRecorded: false,
        status: { status: 'queued', result: null } }) }))
      .toMatchObject({ action: 'dispatch', mode: 'fresh' });
  });
  it('f: a real ran payload without a scorecard never launches another model call', () => {
    expect(decide({ readStatus: () => ({ status: 'finished', result: { status: 'ran' } }) }).action).toBe('skip');
  });
  it('g: observes cooldown then allows retry at the boundary', () => {
    const lastDispatch = new Map([[`${repo}#${pr}@${head}`, 200_001]]);
    expect(decide({ lastDispatch }).why).toBe('retry cooldown active');
    lastDispatch.set(`${repo}#${pr}@${head}`, 200_000);
    expect(decide({ lastDispatch }).action).toBe('dispatch');
  });
});

describe('settings cascade', () => {
  it('loads the default tool settings from the filesystem under Vite', () => {
    const resolved = resolveReviewRedTeamOnSkip({ env: { WE_PLATFORM_PREFERENCES_FILE: '/missing-test-policy' } });
    expect(resolved.value).toEqual({ enabled: true, retryCooldownMin: 30 });
    expect(resolved.sources).toMatchObject({ enabled: 'tool', retryCooldownMin: 'tool' });
  });
  it('environment disables recovery and logs its source', () => {
    resetCascadeLogForTest(); const log = vi.fn();
    const resolved = resolveReviewRedTeamOnSkip({ env: { WE_REVIEW_RED_TEAM_ON_SKIP: '0', WE_POLICY_CASCADE_LOG: '1' },
      readFile: () => '{"enabled":true}', log });
    expect(resolved.value.enabled).toBe(false);
    expect(resolved.sources.enabled).toBe('env');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('enabled=false (env)'));
  });
  it('malformed tool and environment values retain lower layers', () => {
    const resolved = resolveReviewRedTeamOnSkip({ env: { WE_REVIEW_RED_TEAM_ON_SKIP: 'garbage', WE_REVIEW_RED_TEAM_ON_SKIP_RETRY_COOLDOWN_MIN: '-1', WE_PLATFORM_PREFERENCES_FILE: '/missing-test-policy' },
      readFile: () => '{"enabled":"bad","retryCooldownMin":-1}' });
    expect(resolved.value).toEqual({ enabled: true, retryCooldownMin: 30 });
  });
});

function runFixture(over = {}) {
  const f = fixture();
  return { repo, plan: { refusals: f.refusals }, rawPrs: f.rawPrs, setting: f.setting,
    readEvidence: f.readEvidence, readStatus: f.readStatus, now: () => f.now, lastDispatch: f.lastDispatch,
    syncLabels: vi.fn(), capacity: { lanes: 1, budget: { left: 1 } }, dispatch: vi.fn(() => ({ jobPid: 42 })), ...over };
}
describe('daemon rows without formal reviews', () => {
  function daemonOptions(number = 5929) {
    const old = (number === 5929 ? '37709504' : 'b64a14a4').padEnd(40, '0');
    const live = (number === 5929 ? '98caad11' : '682e81b3').padEnd(40, '0');
    const fingerprint = 'd'.repeat(64), contribution = 'e'.repeat(64);
    const markers = (sha, diff) => `<!-- reviewed-sha: ${sha} -->\n<!-- reviewed-diff: ${diff} -->\n<!-- reviewed-contribution: ${contribution} -->`;
    const comment = (body, login, createdAt) => ({ body, author: { login }, createdAt });
    const rawPr = { number, state: 'OPEN', headRefName: `lane/recovery-${number}`, headRefOid: live,
      baseRefName: 'main', mergeStateStatus: 'CLEAN', labels: [{ name: 'review:accepted' }],
      comments: [
        comment(`✅ review — accepted\n\nCard-only change; no implementation findings.\n${markers(old, fingerprint)}`,
          'web-everything', '2026-10-24T12:00:00Z'),
        comment(`${redTeamMarker(number, old)}\nRed team not required on this head: card-only diff`,
          'web-everything', '2026-10-24T12:01:00Z'),
        comment(`📌 review — acceptance re-stamped after a rebase (no new review)\n\n${number === 5910 ? 'Merged origin/main; contribution unchanged.' : 'Net diff unchanged after rebase.'}\n${markers(live, number === 5910 ? 'f'.repeat(64) : fingerprint)}\n<!-- numbering-restamp: from=${old} to=${live} -->`,
          'plateau-merger', '2026-10-24T13:00:00Z'),
      ], statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    return runFixture({ rawPrs: [rawPr],
      plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: number, headSha: live }] },
      readEvidence: () => ({ inFlight: false, queued: false, recorded: false, seatRecorded: false }),
      readReviews: vi.fn(() => []),
      proveMove: vi.fn(() => { throw Error('acceptance re-stamp does not require a linear head move'); }),
    });
  }

  it.each([5929, 5910])('carries daemon PR #%s policy-clear once after re-stamp (including a merge)', number => {
    const o = daemonOptions(number), raw = o.rawPrs[0];
    runGhSync.mockReset();
    runGhSync.mockImplementation((_args, options) => {
      raw.comments.push({ body: options.input, author: { login: 'web-everything' } });
    });
    try {
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'carry', head: raw.headRefOid });
      expect(o.readReviews).toHaveBeenCalledOnce();
      expect(o.readReviews).toHaveBeenCalledWith({ repo, pr: number });
      expect(raw).not.toHaveProperty('reviews');
      expect(runGhSync).toHaveBeenCalledOnce();
      expect(runGhSync).toHaveBeenCalledWith([
        'pr', 'comment', String(number), `--repo=${repo}`, '--body-file', '-',
      ], expect.objectContaining({ input: expect.stringContaining(redTeamMarker(number, raw.headRefOid)) }));
      expect(o.syncLabels).toHaveBeenCalledOnce();
      expect(o.syncLabels).toHaveBeenCalledWith(expect.objectContaining({ repo, pr: number, head: raw.headRefOid }));
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'red-team result already on head' });
      expect(o.readReviews).toHaveBeenCalledTimes(1);
      expect(runGhSync).toHaveBeenCalledTimes(1);
      expect(o.proveMove).not.toHaveBeenCalled();
    } finally { runGhSync.mockReset(); }
  });

  it.each(['throws', 'oversized', 'malformed', 'changes-requested'])('refuses publication when formal review read is %s', kind => {
    const o = daemonOptions();
    o.readReviews.mockImplementation(() => {
      if (kind === 'throws' || kind === 'oversized') throw Error(kind === 'oversized' ? 'ENOBUFS' : 'offline');
      return kind === 'malformed' ? {} : [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-10-24T14:00:00Z', author: { login: 'reviewer' } }];
    });
    runGhSync.mockClear();
    // Neither policy carry nor fresh-review recovery may cross a standing formal hold
    // or an unreadable formal-review channel.
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: kind === 'changes-requested'
      ? 'later verdict or hold supersedes acceptance' : 'PR reviews unreadable; inspect formal reviews before policy-clear' });
    expect(runGhSync).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled();
    expect(o.dispatch).not.toHaveBeenCalled();
  });

  it('default reader uses throttled gh with bounded output and timeout', () => {
    const o = daemonOptions(); delete o.readReviews; o.dryRun = true;
    runGhSync.mockReset(); runGhSync.mockReturnValue(JSON.stringify({ reviews: [] }));
    try {
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('carry');
      expect(runGhSync).toHaveBeenCalledOnce();
      expect(runGhSync).toHaveBeenCalledWith(['pr', 'view', '5929', '--repo', repo, '--json', 'reviews'],
        expect.objectContaining({ encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 }));
    } finally { runGhSync.mockReset(); }
  });

  it.each(['disabled', 'not-refused', 'unaccepted', 'unreadable-comments', 'changed-head', 'reviews-present'])(
    'avoids formal review reads for %s PRs', kind => {
      const o = daemonOptions();
      if (kind === 'disabled') o.setting.enabled = false;
      if (kind === 'not-refused') o.plan.refusals = [];
      if (kind === 'unaccepted') o.rawPrs[0].labels = [];
      if (kind === 'unreadable-comments') delete o.rawPrs[0].comments;
      if (kind === 'changed-head') o.plan.refusals[0].headSha = head;
      if (kind === 'reviews-present') { o.rawPrs[0].reviews = []; o.dryRun = true; }
      runRedTeamOnSkip(o);
      expect(o.readReviews).not.toHaveBeenCalled();
    });
});
describe('runRedTeamOnSkip', () => {
  it.each(['not-owed', { status: 'not-owed' }].flatMap(result =>
    ['changes', 'accept'].map(verdict => [result, verdict])))(
    'never clears a newer accepting review using an obsolete %j status with verdict %s', (result, verdict) => {
      const dir = mkdtempSync(join(tmpdir(), 'red-team-stale-not-owed-'));
      const runsDir = join(dir, 'runs');
      const env = { WE_SHARED_RUNS_DIR: runsDir };
      const input = { repo, pr, head, runsDir, env, readScorecards: () => [] };
      try {
        recordRedTeamStatus({ repo, pr, loopPayload: { ...payload(), verdict: { verdict } },
          status: 'finished', result }, { env });
        const statusFile = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
        utimesSync(statusFile, new Date(1000), new Date(1000));
        const id = 'review-pr-newer-accept';
        writeRun({ ...newRunRecord({ id, op: 'review-pr', input: { repo, pr } }), ...payload() }, runsDir);
        utimesSync(join(runsDir, `${id}.json`), new Date(2000), new Date(2000));
        const evidence = readDrainRedTeamEvidence(input);
        expect(evidence).toMatchObject({ scheduled: true, skipCardOnly: false, seatRecorded: false,
          recorded: false, loopPayload: { verdict: { verdict: 'accept' } } });
        expect(evidence.status).toBeUndefined();
        const o = runFixture({ readEvidence: () => readDrainRedTeamEvidence(input),
          readStatus: () => readRedTeamStatus(input) });
        o.rawPrs[0].labels = ['review:accepted'];
        o.rawPrs[0].comments = [{ body: `✅ review — accepted\n<!-- reviewed-sha: ${head} -->`,
          author: { login: 'web-everything' }, createdAt: new Date(2000).toISOString() }];
        runGhSync.mockClear();
        const out = runRedTeamOnSkip(o);
        expect(out.rows[0].action).not.toBe('clear');
        expect(o.syncLabels).not.toHaveBeenCalled();
        expect(runGhSync).not.toHaveBeenCalled();

        // Once this accepting review writes its own status, the clear is valid again.
        recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'finished', result }, { env });
        utimesSync(statusFile, new Date(3000), new Date(3000));
        expect(readDrainRedTeamEvidence(input)).toMatchObject({ scheduled: false,
          status: { status: 'finished', result, loopPayload: { verdict: { verdict: 'accept' } } } });
        o.settle = vi.fn(() => ({ outcome: 'policy-clear' }));
        expect(runRedTeamOnSkip(o).rows[0].action).toBe('clear');
        expect(o.settle).toHaveBeenCalledOnce();
        expect(o.syncLabels).toHaveBeenCalledOnce();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it.each(['finished-error', 'missing'])('an error seat row with %s status skips without dispatch', kind => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-skip-'));
    try {
      const evidence = readDrainRedTeamEvidence({ repo, pr, head,
        env: { WE_SHARED_RUNS_DIR: join(dir, 'runs') }, list: () => [],
        readScorecards: () => [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'error' }] });
      expect(evidence.recorded).toBe(true);
      const o = runFixture({ readEvidence: () => ({ ...evidence, loopPayload: payload() }),
        readStatus: () => kind === 'missing' ? null : { status: 'finished', result: { status: 'error' } } });
      const out = runRedTeamOnSkip(o);
      expect(out.rows[0]).toMatchObject({ action: 'skip',
        why: kind === 'missing' ? 'prior result unknown (status missing); not re-run' : 'prior result error (status finished); not re-run' });
      expect(out.dispatched).toEqual([]); expect(o.dispatch).not.toHaveBeenCalled();
      expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 } }); expect(o.lastDispatch.size).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('dry run calls no dispatch and spends no capacity or cooldown', () => {
    const o = runFixture({ dryRun: true }); const out = runRedTeamOnSkip(o);
    expect(o.dispatch).not.toHaveBeenCalled(); expect(out.dispatched).toEqual([]);
    expect(o.capacity.budget.left).toBe(1); expect(o.lastDispatch.size).toBe(0);
  });
  it.each([{ lanes: 0 }, { lanes: 1, budget: { left: 0 } }])('does not dispatch with exhausted capacity %j', capacity => {
    const o = runFixture({ capacity }); runRedTeamOnSkip(o); expect(o.dispatch).not.toHaveBeenCalled();
  });
  it('host-denied capacity blocks recovery without consuming lanes, budget or host starts', () => {
    const take = vi.fn(), capacity = { lanes: 3, budget: { left: 3 }, remainingStarts: 0, take };
    const o = runFixture({ capacity });
    const out = runRedTeamOnSkip(o);
    expect(o.dispatch).not.toHaveBeenCalled();
    expect(out.dispatched).toEqual([]);
    expect(out.rows[0].why).toBe('no review capacity left');
    expect(capacity).toEqual({ lanes: 3, budget: { left: 3 }, remainingStarts: 0, take });
    expect(take).not.toHaveBeenCalled();
    expect(o.lastDispatch.size).toBe(0);
  });
  it('bounds recovery by the remaining shared host cap despite spare lanes and live-review budget', () => {
    const take = vi.fn();
    const o = runFixture({ capacity: { lanes: 5, budget: { left: 5 }, remainingStarts: 1, take } });
    for (const prNumber of [5530, 5531, 5532]) {
      o.plan.refusals.push({ kind: 'already-reviewed-head', prNumber, headSha: head });
      o.rawPrs.push({ number: prNumber, headRefOid: head, comments: [] });
    }
    const out = runRedTeamOnSkip(o);
    expect(out.dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'fresh' }]);
    expect(o.dispatch).toHaveBeenCalledTimes(1);
    expect(o.capacity).toEqual({ lanes: 4, budget: { left: 4 }, remainingStarts: 0, take });
    expect(take).toHaveBeenCalledTimes(1);
    expect(out.notStarted).toHaveLength(3);
  });
  it.each(['dry-run', 'skipped', 'no-job'])('%s consumes no host start', kind => {
    const take = vi.fn();
    const o = runFixture({ capacity: { lanes: 2, budget: { left: 2 }, remainingStarts: 1, take },
      dryRun: kind === 'dry-run',
      dispatch: vi.fn(() => kind === 'skipped' ? { skipped: 'lane-cooloff' } : {}) });
    expect(runRedTeamOnSkip(o).dispatched).toEqual([]);
    expect(o.capacity.remainingStarts).toBe(1);
    expect(take).not.toHaveBeenCalled();
  });
  it('a throwing recovery dispatch consumes host capacity because a spawn may have occurred', () => {
    const take = vi.fn();
    const o = runFixture({ capacity: { lanes: 2, budget: { left: 2 }, remainingStarts: 1, take },
      dispatch: vi.fn(() => { throw Error('unknown start'); }) });
    o.plan.refusals.push({ kind: 'already-reviewed-head', prNumber: 5530, headSha: head });
    o.rawPrs.push({ number: 5530, headRefOid: head, comments: [] });
    const out = runRedTeamOnSkip(o);
    expect(out.rows[0].why).toBe('dispatch failed; start unknown');
    expect(o.dispatch).toHaveBeenCalledTimes(1);
    expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 }, remainingStarts: 0, take });
    expect(take).toHaveBeenCalledTimes(1);
  });
  it('dispatches the existing job, spends capacity and records cooldown only for starts', () => {
    const log = vi.fn(), o = runFixture({ log, preferLane: 7 }); const out = runRedTeamOnSkip(o);
    expect(o.dispatch).toHaveBeenCalledWith({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh', preferLane: 7 });
    expect(out.dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'fresh' }]);
    expect(o.capacity).toEqual({ lanes: 0, budget: { left: 0 } }); expect(o.lastDispatch.size).toBe(1);
    expect(log).toHaveBeenCalledTimes(1); expect(log.mock.calls[0][0]).toContain('dispatched (fresh)');
  });
  it('a skipped dispatch retains no cooldown and refunds capacity', () => {
    const o = runFixture({ dispatch: () => ({ skipped: 'lane-cooloff' }) });
    expect(runRedTeamOnSkip(o).notStarted).toEqual([{ prNumber: pr, reason: 'lane-cooloff' }]);
    expect(o.lastDispatch.size).toBe(0); expect(o.capacity.budget.left).toBe(1);
  });
  it.each([false, true])('a live-job refusal refunds only an already-counted pid (counted: %s)', counted => {
    const o = runFixture({ dispatch: () => ({ skipped: 'live-job', jobPid: 99 }),
      capacity: { lanes: 1, budget: { left: 1, countedJobPids: new Set(counted ? [99] : []) } } });
    runRedTeamOnSkip(o);
    expect(o.capacity.budget.left).toBe(counted ? 1 : 0); expect(o.lastDispatch.size).toBe(0);
  });
  it('a throw retains the reservation and becomes a row, never an exception', () => {
    const o = runFixture({ dispatch: () => { throw Error('failed'); } });
    expect(runRedTeamOnSkip(o).rows[0].why).toBe('dispatch failed; start unknown');
    expect(o.capacity.budget.left).toBe(0); expect(o.lastDispatch.size).toBe(0);
  });
  it('bounds starts across multiple refusals', () => {
    const o = runFixture();
    o.plan.refusals.push({ kind: 'already-reviewed-head', prNumber: 5530, headSha: head });
    o.rawPrs.push({ number: 5530, headRefOid: head, comments: [] });
    expect(runRedTeamOnSkip(o).dispatched).toHaveLength(1); expect(o.dispatch).toHaveBeenCalledTimes(1);
  });
});


describe('PR 5890 review-pr status payloads', () => {
  it('a finished string resumed result survives normalization and resumes with completed seat evidence', () => {
    const status = { status: 'finished', result: 'resumed' };
    expect(normalizeRedTeamResult(status.result)).toEqual({ priorResult: 'resumed', priorComment: undefined });
    expect(decide({ readStatus: () => status,
      readEvidence: () => ({ loopPayload: payload(), recorded: true, completedRecorded: true }) }))
      .toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it.each(['resumed', 'ran', { status: 'resumed' }])('review-pr row %j with no seat dispatches fresh', result => {
    const loopPayload = { ...payload(), op: 'review-pr' };
    const row = { repo, pr: 5762, head, status: 'finished', result, loopPayload };
    expect(decide({ readStatus: () => row })).toMatchObject({ action: 'dispatch', mode: 'fresh' });
  });
  it('bare resumed with a clean seat dispatches from that seat', () => {
    const row = { repo, pr: 5762, head, status: 'finished', result: 'resumed', loopPayload: { ...payload(), op: 'review-pr' } };
    expect(decide({ readStatus: () => row,
      readEvidence: () => ({ loopPayload: payload(), recorded: true, cleanRecorded: true }) }))
      .toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it('an incomplete seat cannot authorize legacy string ran recovery', () => {
    expect(decide({ readStatus: () => ({ repo, pr, head, status: 'finished', result: 'ran', loopPayload: { ...payload(), op: 'review-pr' } }),
      readEvidence: () => ({ loopPayload: payload(), recorded: true, seatRecorded: true, completedRecorded: false }) }).action).toBe('skip');
  });
  it('a completed seat with confirmed breaks resumes effects without authorizing another model call', () => {
    expect(decide({ readStatus: () => ({ repo, pr, head, status: 'finished', result: 'ran', loopPayload: { ...payload(), op: 'review-pr' } }),
      readEvidence: () => ({ loopPayload: payload(), recorded: true, seatRecorded: true, completedRecorded: true }) }))
      .toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
});


describe('card-only head move recovery', () => {
  const fromSha = 'b'.repeat(40);
  const oldPayload = () => ({ verdict: { verdict: 'changes' }, findings: { read: {
    netBasis: { rev: fromSha }, diffText: '+card', netChangedFiles: ['backlog/123-card.md'],
  } } });
  const oldEvidence = () => {
    const loopPayload = oldPayload();
    return { loopPayload, recorded: false, seatRecorded: false, completedRecorded: false, inFlight: false,
      status: { head: fromSha, status: 'finished', result: 'skipped', skipCardOnly: true, loopPayload: structuredClone(loopPayload) } };
  };
  // One row per top-level conjunct of cardOnlyHeadMoveCandidate. Keep this list
  // aligned with the predicate so overlapping planner guards cannot hide a missing check.
  it.each([
    // Real-head validity is also implied by the matching-head and settleable-status guards.
    ['real read head', e => { e.loopPayload.findings.read.netBasis.rev = 'unknown'; }],
    ['moved read head', e => { e.loopPayload.findings.read.netBasis.rev = head; e.status.head = head; e.status.loopPayload.findings.read.netBasis.rev = head; }],
    ['card-only read', e => { e.loopPayload.findings.read.netChangedFiles = ['scripts/code.mjs']; }],
    ['settleable skip', e => { e.status.result = 'ran'; }],
    ['matching status head', e => { e.status.head = 'c'.repeat(40); e.status.loopPayload.findings.read.netBasis.rev = e.status.head; }],
    ['no recorded result', e => { e.recorded = true; }],
    ['no recorded seat', e => { e.seatRecorded = true; }],
    ['not in flight', e => { e.inFlight = true; }],
    ['not queued', e => { e.queued = true; }],
  ])('moved candidate requires %s', (_clause, mutate) => {
    const evidence = oldEvidence();
    expect(cardOnlyHeadMoveCandidate(evidence, head)).toBe(true);
    mutate(evidence);
    expect(cardOnlyHeadMoveCandidate(evidence, head)).toBe(false);
  });
  it.each(['numbering-only', 'card-only'])('%s move dispatches fresh despite a not-owed old review', kind => {
    const proveMove = vi.fn(() => ({ ok: true, kind }));
    expect(decide({ readEvidence: oldEvidence, proveMove })).toMatchObject({ action: 'dispatch', mode: 'fresh' });
    expect(proveMove).toHaveBeenCalledWith({ fromSha, toSha: head });
  });
  it.each(['code change', 'unprovable move'])('keeps the skip for %s', reason => {
    expect(decide({ readEvidence: oldEvidence, proveMove: () => ({ ok: false, reason }) }).action).toBe('skip');
  });
  it.each([
    { recorded: true }, { seatRecorded: true }, { inFlight: true }, { queued: true },
    { status: null }, { completedRecorded: true },
  ])('does not dispatch with existing or unknown evidence %j', over => {
    expect(decide({ readEvidence: () => ({ ...oldEvidence(), ...over }), proveMove: () => ({ ok: true }) }).action).toBe('skip');
  });
  it.each(['missing head', 'status head mismatch', 'code read', 'not skipped', 'skip disabled'])('refuses %s provenance', kind => {
    const evidence = oldEvidence();
    if (kind === 'missing head') delete evidence.loopPayload.findings.read.netBasis.rev;
    if (kind === 'status head mismatch') {
      evidence.status.head = 'c'.repeat(40);
      evidence.status.loopPayload.findings.read.netBasis.rev = evidence.status.head;
    }
    if (kind === 'code read') evidence.loopPayload.findings.read.netChangedFiles = ['scripts/code.mjs'];
    if (kind === 'not skipped') evidence.status.result = 'ran';
    if (kind === 'skip disabled') evidence.status.skipCardOnly = false;
    expect(decide({ readEvidence: () => evidence, proveMove: () => ({ ok: true }) }).action).toBe('skip');
  });
  it('observes cooldown and existing live-head state after the proof', () => {
    const base = { readEvidence: oldEvidence, proveMove: () => ({ ok: true }) };
    expect(decide({ ...base, lastDispatch: new Map([[`${repo}#${pr}@${head}`, 200_001]]) }).why).toBe('retry cooldown active');
    expect(decide({ ...base, readStatus: () => ({ status: 'finished' }) }).action).toBe('skip');
  });
  it('runner uses the injected move proof and dispatches the normal red-team-only job', () => {
    const dispatch = vi.fn(() => ({ jobPid: 42 }));
    const out = runRedTeamOnSkip({ ...fixture(), plan: { refusals: fixture().refusals },
      now: () => 2_000_000, readEvidence: oldEvidence, proveMove: () => ({ ok: true }),
      capacity: { lanes: 1 }, dispatch });
    expect(out.dispatched).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledWith({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' });
  });
  it('runner default move proof forwards exec, cwd and mainRef to the numbering proof', () => {
    const exec = vi.fn(), cwd = '/fixture/checkout', mainRef = 'fixture/main';
    const detector = vi.spyOn(numbering, 'proveNumberingOnlyMove').mockReturnValue({ ok: true, kind: 'numbering-only' });
    try {
      const dispatch = vi.fn(() => ({ jobPid: 42 }));
      const out = runRedTeamOnSkip({ ...fixture(), plan: { refusals: fixture().refusals },
        now: () => 2_000_000, readEvidence: oldEvidence, exec, cwd, mainRef,
        capacity: { lanes: 1 }, dispatch, lastDispatch: new Map() });
      expect(out.dispatched).toHaveLength(1);
      expect(detector).toHaveBeenCalledWith({ exec, cwd, mainRef, fromSha, toSha: head });
      expect(dispatch).toHaveBeenCalledWith({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' });
    } finally { detector.mockRestore(); }
  });
  it('runner default move proof executes the card-path proof with its supplied cwd', () => {
    const cwd = '/fixture/checkout';
    const exec = vi.fn((file, args, options) => {
      expect(file).toBe('git');
      expect(options.cwd).toBe(cwd);
      if (args[0] === 'merge-base') return '';
      if (args[0] === 'rev-list') return `${head} ${fromSha}`;
      if (args[0] === 'diff-tree') return 'backlog/123-card.md\0';
      throw Error('not numbering');
    });
    const out = runRedTeamOnSkip({ ...fixture(), plan: { refusals: fixture().refusals },
      now: () => 2_000_000, readEvidence: oldEvidence, exec, cwd, lastDispatch: new Map(),
      capacity: { lanes: 1 }, dispatch: () => ({ jobPid: 42 }) });
    expect(out.dispatched).toHaveLength(1);
    expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['diff-tree', head]), expect.objectContaining({ cwd }));
  });
});

describe('proveCardOnlyHeadMove', () => {
  const fromSha = 'b'.repeat(40), toSha = head;
  it('reuses the numbering detector before checking card paths', () => {
    const proof = { ok: true, kind: 'numbering-only' };
    const detector = vi.spyOn(numbering, 'proveNumberingOnlyMove').mockReturnValue(proof);
    const exec = vi.fn();
    try {
      expect(proveCardOnlyHeadMove({ exec, fromSha, toSha, cwd: 'checkout', mainRef: 'main' })).toBe(proof);
      expect(detector).toHaveBeenCalledWith({ exec, fromSha, toSha, cwd: 'checkout', mainRef: 'main' });
      expect(exec).not.toHaveBeenCalled();
    } finally { detector.mockRestore(); }
  });
  it('carries a renumber plus docs id rewrite through the real numbering detector', () => {
    const zero = '0'.repeat(40), beforeOid = '1'.repeat(40), afterOid = '2'.repeat(40);
    const docBeforeOid = '3'.repeat(40), docAfterOid = '4'.repeat(40);
    const blobs = new Map([[beforeOid, '---\ntitle: card\n---\n'], [afterOid, '---\nbornAs: xabcdef\ntitle: card\n---\n'],
      [docBeforeOid, 'See xabcdef.\n'], [docAfterOid, 'See 123.\n']]);
    const exec = vi.fn((file, args, options) => {
      expect(file).toBe('git');
      expect(options.cwd).toBe('checkout');
      let output;
      if (args[0] === 'cat-file') {
        if (args[1] === '-e') output = '';
        else {
          const blob = blobs.get(args[2]);
          if (blob === undefined) throw Error('unknown blob');
          output = args[1] === '-t' ? 'blob\n' : args[1] === '-s' ? `${Buffer.byteLength(blob)}\n` : blob;
        }
      } else if (args[0] === 'rev-parse') output = fromSha;
      else if (args[0] === 'rev-list') output = `${toSha} ${fromSha}\n`;
      else if (args[0] === 'log') output = 'drain: JIT-number xabcdef→#123 at land (#2288)\n';
      else if (['ls-tree', 'grep'].includes(args[0])) output = '';
      else if (args[0] === 'diff-tree') output = [
        `:100644 000000 ${beforeOid} ${zero} D\0backlog/xabcdef-card.md\0`,
        `:000000 100644 ${zero} ${afterOid} A\0backlog/123-card.md\0`,
        `:100644 100644 ${docBeforeOid} ${docAfterOid} M\0docs/agent/testing.md\0`,
      ].join('');
      else throw Error(`unexpected Git read: ${args[0]}`);
      return options.encoding === null ? Buffer.from(output) : output;
    });
    expect(proveCardOnlyHeadMove({ exec, fromSha, toSha, cwd: 'checkout', mainRef: 'fixture/main' }))
      .toMatchObject({ ok: true, commits: [toSha], pairs: [['xabcdef', '123']] });
    expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['ls-tree', 'fixture/main']), expect.anything());
    expect(exec.mock.calls.some(([, args]) => args[0] === 'merge-base')).toBe(false);
  });
  const c1 = 'c'.repeat(40);
  const fake = ({ ancestor = true, revList = `${c1} ${fromSha}`, tree }) => vi.fn((file, args) => {
    if (args[0] === 'merge-base') { if (!ancestor) throw Error('not ancestor'); return ''; }
    if (args[0] === 'rev-list') return revList;
    if (args[0] === 'diff-tree') return tree;
    throw Error('not numbering');
  });
  const history = count => Array.from({ length: count }, (_, i) => (i + 1).toString(16).padStart(40, '0'));
  const revListFor = commits => commits.map((sha, i) => `${sha} ${commits[i + 1] ?? fromSha}`).join('\n');
  it('accepts exactly 20 card-only commits and inspects every commit within bounded Git calls', () => {
    const commits = history(20), exec = fake({ revList: revListFor(commits), tree: 'backlog/123-card.md\0' });
    expect(proveCardOnlyHeadMove({ exec, fromSha, toSha: commits[0], cwd: 'checkout' })).toMatchObject({ ok: true, kind: 'card-only' });
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'diff-tree').map(([, args]) => args.at(-1))).toEqual(commits);
    expect(exec).toHaveBeenCalledWith('git', ['rev-list', '--max-count=21', '--parents', `${fromSha}..${commits[0]}`],
      expect.objectContaining({ cwd: 'checkout', timeout: 10_000, maxBuffer: 1024 * 1024 }));
  });
  it('rejects a history over MAX_COMMITS', () => {
    for (const count of [20, 21]) {
      const commits = history(count), exec = fake({ revList: revListFor(commits), tree: 'backlog/123-card.md\0' });
      expect(proveCardOnlyHeadMove({ exec, fromSha, toSha: commits[0] }).ok, `${count} card-only commits`).toBe(count === 20);
      expect(exec.mock.calls.filter(([, args]) => args[0] === 'diff-tree')).toHaveLength(count === 20 ? 20 : 0);
    }
  });
  it.each(['', c1])('rejects empty or zero-parent history %j', revList => {
    expect(proveCardOnlyHeadMove({ exec: fake({ revList, tree: 'backlog/123-card.md\0' }), fromSha, toSha }).ok).toBe(false);
  });
  it('rejects an intermediate non-card commit', () => {
    // Both two-commit orders reject first-only/last-only inspection; the middle of three rejects endpoints-only inspection.
    for (const [count, badIndex] of [[2, 0], [2, 1], [3, 0], [3, 1], [3, 2]]) {
      const commits = history(count);
      const exec = fake({ revList: revListFor(commits), tree: 'backlog/123-card.md\0' });
      const read = exec.getMockImplementation();
      exec.mockImplementation((file, args, options) => args[0] === 'diff-tree' && args.at(-1) === commits[badIndex]
        ? 'scripts/code.mjs\0' : read(file, args, options));
      expect(proveCardOnlyHeadMove({ exec, fromSha, toSha: commits[0] }).ok,
        `non-card commit at index ${badIndex} of ${count}`).toBe(false);
    }
  });
  it('requires --no-renames and sees a code-to-card rename', () => {
    const exec = fake({ revList: `${toSha} ${fromSha}`, tree: 'backlog/123-card.md\0' }), read = exec.getMockImplementation();
    exec.mockImplementation((file, args, options) => args[0] === 'diff-tree' && args.includes('--no-renames')
      ? 'scripts/code.mjs\0backlog/123-card.md\0' : read(file, args, options));
    expect(proveCardOnlyHeadMove({ exec, fromSha, toSha }).ok).toBe(false);
    expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['diff-tree', '--no-renames', toSha]), expect.anything());
  });
  it.each([
    ['backlog/123-card.md\0', true],
    ['backlog/123-card.md\0scripts/code.mjs\0', false],
    ['scripts/code.mjs\0backlog/123-moved.md\0', false],
    ['', false], ['backlog/123-card.md', false], ['x'.repeat(1024 * 1024 + 1) + '\0', false],
  ])('fails closed unless every commit contains only card paths (case %#)', (tree, ok) => {
    const exec = fake({ tree });
    expect(proveCardOnlyHeadMove({ exec, fromSha, toSha, cwd: 'checkout' }).ok).toBe(ok);
  });
  it('refuses a non-descendant head, a merge commit, and submodule-blind diffs', () => {
    expect(proveCardOnlyHeadMove({ exec: fake({ ancestor: false, tree: 'backlog/1-a.md\0' }), fromSha, toSha }).ok).toBe(false);
    expect(proveCardOnlyHeadMove({ exec: fake({ revList: `${c1} ${fromSha} ${'d'.repeat(40)}`, tree: 'backlog/1-a.md\0' }), fromSha, toSha }).ok).toBe(false);
    const exec = fake({ tree: 'backlog/1-a.md\0' });
    proveCardOnlyHeadMove({ exec, fromSha, toSha });
    expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['diff-tree', '--ignore-submodules=none', '--no-ext-diff']), expect.anything());
  });
  it('refuses missing heads and unreadable Git evidence', () => {
    const exec = () => { throw Error('missing commit'); };
    expect(proveCardOnlyHeadMove({ exec, toSha }).ok).toBe(false);
    expect(proveCardOnlyHeadMove({ exec, fromSha, toSha }).ok).toBe(false);
  });
});


describe('R100 recovery regressions', () => {
  const old = 'b'.repeat(40);
  const trusted = body => ({ body, author: { login: 'web-everything' } });
  const carryOptions = () => runFixture({
    rawPrs: [{ number: pr, headRefOid: head, labels: ['review:accepted'], reviews: [], comments: [
      trusted(`✅ review — accepted\n<!-- reviewed-sha: ${old} -->`),
      trusted(`${redTeamMarker(pr, old)}\nRed team not required on this head: card-only diff`),
      trusted(`📌 review — acceptance re-stamped after a rebase (no new review)\n<!-- reviewed-sha: ${head} -->\n<!-- numbering-restamp: from=${old} to=${head} -->`),
    ] }], readEvidence: () => ({ inFlight: false, recorded: false }),
  });

  it.each(['carry', 'clear'].flatMap(action => [
    [action, 'post', 'offline', () => Error('offline')],
    [action, 'post', 'unprintable error', () => ({ message: { toString: null } })],
    [action, 'label sync', 'offline', () => Error('offline')],
    [action, 'label sync', 'unprintable error', () => ({ message: { toString: null } })],
  ]))('%s publication failing at %s (%s) skips without spending capacity', (action, stage, why, error) => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-publish-failure-'));
    const o = action === 'carry' ? carryOptions() : runFixture({
      rawPrs: [{ number: pr, headRefOid: head, labels: ['review:accepted'], reviews: [],
        comments: [trusted(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`)] }],
      readEvidence: () => ({ loopPayload: payload(), recorded: false, seatRecorded: false,
        status: { status: 'finished', result: 'not-owed' } }),
      readStatus: () => ({ status: 'finished', result: 'not-owed' }),
    });
    o.env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
    const raw = o.rawPrs[0];
    const failure = action === 'clear' && stage === 'post'
      ? `clear failed: policy-clear comment failed: ${why}` : `${action} failed: ${why}`;
    runGhSync.mockReset();
    runGhSync.mockImplementation((_args, options) => {
      if (stage === 'post') throw error();
      raw.comments.push(trusted(options.input));
    });
    if (stage === 'label sync') o.syncLabels.mockImplementation(() => { throw error(); });
    try {
      const out = runRedTeamOnSkip(o);
      expect(out).toMatchObject({ rows: [{ action: 'skip', why: failure }],
        dispatched: [], notStarted: [] });
      expect(runGhSync).toHaveBeenCalledOnce();
      expect(o.syncLabels).toHaveBeenCalledTimes(stage === 'post' ? 0 : 1);
      expect(Boolean(redTeamForHead(raw.comments, pr, head))).toBe(stage === 'label sync');
      expect(o.dispatch).not.toHaveBeenCalled();
      expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
      expect(o.lastDispatch.size).toBe(0);
      // A visible comment deduplicates the next tick; label repair belongs to the label sweep.
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: stage === 'post'
        ? failure : 'red-team result already on head' });
      expect(runGhSync).toHaveBeenCalledTimes(stage === 'post' ? 2 : 1);
      expect(o.syncLabels).toHaveBeenCalledTimes(stage === 'post' ? 0 : 1);
    } finally {
      runGhSync.mockReset();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['carry', 'not-owed', 'full-review'].flatMap(mode =>
    ['stale fork', 'invalid ancestor', 'changed clearance'].map(kind => ({ mode, kind }))))(
    'refuses $mode publication with a canonical rejected re-stamp: $kind', ({ mode, kind }) => {
      const o = carryOptions(), raw = o.rawPrs[0];
      raw.reviews = [];
      o.settle = vi.fn(() => ({ outcome: 'policy-clear' }));
      if (mode === 'not-owed') {
        const status = { status: 'finished', result: 'not-owed' };
        o.readStatus = () => status;
        o.readEvidence = () => ({ loopPayload: payload(), inFlight: false, recorded: false,
          seatRecorded: false, status });
      }
      const intermediate = 'c'.repeat(40);
      const restamp = (from, to) => trusted(`📌 review — acceptance re-stamped after a rebase (no new review)\n<!-- reviewed-sha: ${to} -->\n<!-- numbering-restamp: from=${from} to=${to} -->`);
      if (kind === 'stale fork') raw.comments.splice(2, 0, restamp(old, intermediate));
      if (kind === 'invalid ancestor') {
        raw.comments.splice(2, 0, restamp(intermediate, old));
      }
      if (kind === 'changed clearance') {
        raw.comments[0].body += '\n<!-- cleared-human: reviewer -->';
      }
      if (mode === 'full-review') {
        raw.comments.splice(1, 1);
        o.readEvidence = () => ({ inFlight: false, recorded: false, seatRecorded: false });
      }
      expect(numbering.strandedNumberingRecords(raw.comments, raw.reviews)).not.toHaveLength(0);
      runGhSync.mockClear();
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
        why: 'invalid acceptance re-stamp; withdraw stranded records before recovery' });
      expect(runGhSync).not.toHaveBeenCalled();
      expect(o.settle).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
      expect(o.dispatch).not.toHaveBeenCalled();
    });

  it('preserves policy-clear carry across a valid sequential re-stamp chain', () => {
    const o = carryOptions(), raw = o.rawPrs[0], intermediate = 'c'.repeat(40);
    raw.comments.splice(2, 0,
      trusted(`📌 review — acceptance re-stamped after a rebase (no new review)\n<!-- reviewed-sha: ${intermediate} -->\n<!-- numbering-restamp: from=${old} to=${intermediate} -->`),
      trusted(`${redTeamMarker(pr, intermediate)}\nRed team not required on this head: card-only diff`));
    raw.comments.at(-1).body = raw.comments.at(-1).body.replace(`from=${old}`, `from=${intermediate}`);
    expect(numbering.strandedNumberingRecords(raw.comments, raw.reviews)).toEqual([]);
    runGhSync.mockClear();
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'carry', from: intermediate });
    expect(runGhSync).toHaveBeenCalledOnce();
    expect(o.syncLabels).toHaveBeenCalledOnce();
    expect(o.dispatch).not.toHaveBeenCalled();
  });

  const publicationOptions = kind => {
    const o = kind === 'carry' ? carryOptions() : runFixture({
      readEvidence: () => ({ loopPayload: payload(), recorded: false, seatRecorded: false,
        status: kind === 'finished/not-owed' ? { status: 'finished', result: 'not-owed' } : null }),
      readStatus: () => kind === 'finished/not-owed' ? { status: 'finished', result: 'not-owed' } : null,
    });
    if (kind !== 'carry') {
      o.rawPrs[0].labels = ['review:accepted'];
      o.rawPrs[0].comments = [trusted(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`)];
    }
    o.settle = vi.fn(() => ({ outcome: 'policy-clear' }));
    return o;
  };
  describe.each(['carry', 'finished/not-owed'])('%s acceptance evidence audit', kind => {
    function options() {
      const o = publicationOptions(kind);
      o.rawPrs[0].reviews = [];
      for (const comment of o.rawPrs[0].comments) comment.createdAt = '2026-10-09T14:00:00Z';
      return o;
    }
    function expectSkip(o, why) {
      runGhSync.mockClear();
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', ...(why ? { why } : {}) });
      expect(runGhSync).not.toHaveBeenCalled();
      expect(o.settle).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
      expect(o.dispatch).not.toHaveBeenCalled();
    }
    it('publishes with readable reviews and established acceptance on the live head', () => {
      const o = options();
      expect(runRedTeamOnSkip(o).rows[0].action).toBe(kind === 'carry' ? 'carry' : 'clear');
    });
    it('refuses a formal CHANGES_REQUESTED review after acceptance', () => {
      const o = options();
      o.rawPrs[0].reviews = [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-10-09T15:00:00Z',
        author: { login: 'reviewer' } }];
      expectSkip(o);
    });
    it.each([undefined, null, {}])('refuses unreadable formal reviews %j for operator inspection', reviews => {
      const o = options(); o.rawPrs[0].reviews = reviews;
      o.readReviews = vi.fn(() => reviews);
      expectSkip(o, 'PR reviews unreadable; inspect formal reviews before policy-clear');
      expect(o.readReviews).toHaveBeenCalledWith({ repo, pr });
    });
    if (kind !== 'carry') {
      it.each(['missing', 'untrusted', 'wrong-head'])('refuses %s acceptance evidence', evidence => {
        const o = options();
        if (evidence === 'missing') o.rawPrs[0].comments = [];
        if (evidence === 'untrusted') o.rawPrs[0].comments[0].author.login = 'stranger';
        if (evidence === 'wrong-head') o.rawPrs[0].comments[0].body = o.rawPrs[0].comments[0].body.replace(head, old);
        expectSkip(o, 'stored review does not owe a red team');
      });
    }
  });
  describe.each(['carry', 'finished/not-owed'])('%s publication guard', kind => {
    it.each(['Please hold this acceptance', 'manifest baseline mismatch', '🔁 review — changes requested'])(
      'refuses a later hold comment after acceptance: %s', body => {
        const o = publicationOptions(kind);
        o.rawPrs[0].comments.push(trusted(body));
        runGhSync.mockClear();
        expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
          why: 'later verdict or hold supersedes acceptance' });
        expect(runGhSync).not.toHaveBeenCalled();
        expect(o.settle).not.toHaveBeenCalled();
        expect(o.syncLabels).not.toHaveBeenCalled();
        expect(o.dispatch).not.toHaveBeenCalled();
      });
    it.each(['red-team:blocked', 'red-team:pending', 'review:changes', 'review:human', 'review:pending',
      'review:held-mechanical', 'review:awaiting-advisory', 'review:prep', 'review:future-hold',
      'review-status:pending', 'review-status:future-hold']
      .flatMap(label => [label, { name: label }]))('refuses a conflicting label %j', label => {
      const o = publicationOptions(kind);
      o.rawPrs[0].labels.push(label);
      runGhSync.mockClear();
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
        why: 'conflicting label prevents policy-clear' });
      expect(runGhSync).not.toHaveBeenCalled();
      expect(o.settle).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
      expect(o.dispatch).not.toHaveBeenCalled();
    });
  });
  it.each(['fresh', 'resume'].flatMap(mode => [
    ...['red-team:blocked', 'red-team:pending', 'review:changes', 'review:human', 'review:pending']
      .flatMap(label => [label, { name: label }]).map(label => ({ mode, label })),
    ...['Please hold this acceptance', 'manifest baseline mismatch', '🔁 review — changes requested']
      .map(body => ({ mode, body })),
  ]))('publication guard preserves the complete $mode dispatch plan with $label / $body', ({ mode, label, body }) => {
    const o = publicationOptions('null-status');
    const completed = mode === 'resume';
    const input = fixture({ rawPrs: o.rawPrs,
      readEvidence: () => ({ loopPayload: payload(), recorded: completed,
        seatRecorded: completed, completedRecorded: completed }),
      readStatus: () => completed ? { status: 'finished', result: 'ran' } : null,
    });
    const expected = planRedTeamOnSkip(input);
    expect(expected).toEqual([{ prNumber: pr, head, action: 'dispatch', mode,
      why: completed ? 'recorded pass needs its result comment/effects' : 'head never had a red-team pass' }]);
    if (label) input.rawPrs[0].labels.push(label);
    if (body) input.rawPrs[0].comments.push(trusted(body));
    expect(planRedTeamOnSkip(input)).toEqual(expected);
  });
  it.each(['untrusted', 'extra-prose', 'malformed-marker'])(
    'source policy-clear remains a possible hold with %s', kind => {
      const comments = carryOptions().rawPrs[0].comments.slice(0, 2);
      if (kind === 'untrusted') comments[1].author.login = 'stranger';
      if (kind === 'extra-prose') comments[1].body += '\nPlease hold this acceptance';
      if (kind === 'malformed-marker') comments[1].body = comments[1].body.replace(old, 'bad');
      expect(latestAcceptRecord(comments).laterVerdict).toBe(true);
    });
  it.each(['status', 'recorded', 'seatRecorded', 'completedRecorded', 'blocked-label', 'withheld'])(
    'refuses policy carry with live-head %s evidence', kind => {
      const o = carryOptions();
      if (kind === 'status' || kind === 'withheld') o.readStatus = () => ({ status: 'finished',
        result: kind === 'withheld' ? { status: 'ran', comment: 'withheld' } : 'error' });
      else if (kind === 'blocked-label') o.rawPrs[0].labels.push('red-team:blocked');
      else o.readEvidence = () => ({ inFlight: false, [kind]: true });
      expect(runRedTeamOnSkip(o).rows[0].action).not.toBe('carry');
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it.each(['Please hold this acceptance', 'manifest baseline mismatch'])(
    'refuses policy carry after a later hold: %s', body => {
      const o = carryOptions();
      o.rawPrs[0].comments.push(trusted(body));
      expect(runRedTeamOnSkip(o).rows[0].action).not.toBe('carry');
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it.each(['Please hold this acceptance', 'manifest baseline mismatch', '🔁 review — changes requested'])(
    'refuses policy carry when the source acceptance was held before re-stamp: %s', body => {
      const o = carryOptions();
      o.rawPrs[0].comments.splice(2, 0, trusted(body));
      runGhSync.mockClear();
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(runGhSync).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it.each([null, 'finished'].flatMap(status =>
    ['changes', 'needs-human', undefined].flatMap(verdict =>
      [undefined, 'red-team:blocked', 'red-team:pending', 'review:changes', 'review:human', 'review:pending']
        .map(label => [status, verdict, label]))))(
    'refuses stored clear with status %s, verdict %s, label %s', (status, verdict, label) => {
      const o = runFixture({
        readEvidence: () => ({ loopPayload: { verdict: { verdict }, findings: { read: { netBasis: { rev: head } } } },
          recorded: false, seatRecorded: false, status: status && ({ status, result: 'not-owed' }) }),
        readStatus: () => status && ({ status, result: 'not-owed' }),
      });
      o.rawPrs[0].labels = ['review:accepted', ...(label ? [{ name: label }] : [])];
      runGhSync.mockClear();
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(runGhSync).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
      expect(o.dispatch).not.toHaveBeenCalled();
    });
  it.each(['red-team:blocked', 'red-team:pending', 'review:changes', 'review:human', 'review:pending'])(
    'refuses clear of an accepting finished/not-owed review carrying %s', label => {
      const o = runFixture({ readEvidence: () => ({ loopPayload: payload(), recorded: false, seatRecorded: false,
        status: { status: 'finished', result: 'not-owed' } }),
        readStatus: () => ({ status: 'finished', result: 'not-owed' }) });
      o.rawPrs[0].labels = ['review:accepted', label];
      // Keep a real accepted head so this fixture exercises the label guard.
      o.rawPrs[0].comments = [trusted(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`)];
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it('keeps an accepting review with null status owed rather than clearing it', () => {
    const o = runFixture();
    o.rawPrs[0].labels = ['review:accepted'];
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('dispatch');
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it('carries prior policy-clear across trusted acceptance re-stamp once and syncs labels', () => {
    const o = carryOptions();
    runGhSync.mockImplementation((_args, options) => o.rawPrs[0].comments.push(trusted(options.input)));
    try {
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('carry');
      expect(o.rawPrs[0].comments.at(-1).body).toContain(`${redTeamMarker(pr, head)}\nRed team not required on this head: prior policy-clear carried from ${old.slice(0, 8)} across a content-preserving rebase (acceptance re-stamped)`);
      expect(o.syncLabels).toHaveBeenCalledOnce();
      expect(runRedTeamOnSkip(o).rows[0].why).toBe('red-team result already on head');
      expect(o.syncLabels).toHaveBeenCalledOnce();
    } finally { runGhSync.mockReset(); }
  });
  it.each(['missing', 'untrusted', 'wrong-head', 'blocked', 'ran', 'unaccepted', 'inFlight', 'queued', 'unknown-evidence', 'old-untrusted', 'ran-with-policy-quote', 'superseded-clear', 'missing-source', 'untrusted-source', 'mismatched-source', 'late-source-result'])(
    'refuses carry for %s', kind => {
      const o = carryOptions(), comments = o.rawPrs[0].comments;
      if (kind === 'missing') comments.pop();
      if (kind === 'untrusted') comments[2].author.login = 'stranger';
      if (kind === 'wrong-head') comments[2].body = comments[2].body.replace(head, old);
      if (['blocked', 'ran'].includes(kind)) comments[1].body = `${redTeamMarker(pr, old)}\nRed team ${kind}`;
      if (kind === 'old-untrusted') comments[1].author.login = 'stranger';
      if (kind === 'ran-with-policy-quote') comments[1].body += '\nRed team ran';
      if (kind === 'superseded-clear') comments.splice(2, 0, trusted(`${redTeamMarker(pr, old)}\nRed team ran`));
      if (kind === 'late-source-result') comments.push(trusted(`${redTeamMarker(pr, old)}\nRed team ran`));
      if (kind === 'missing-source') comments.shift();
      if (kind === 'untrusted-source') comments[0].author.login = 'stranger';
      if (kind === 'mismatched-source') comments[0].body = comments[0].body.replace(old, 'c'.repeat(40));
      if (kind === 'unknown-evidence') o.readEvidence = () => null;
      if (kind === 'unaccepted') o.rawPrs[0].labels = [];
      if (['inFlight', 'queued'].includes(kind)) o.readEvidence = () => ({ [kind]: true });
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it('selects acceptance A in an A then B history for a declared A-to-C carry, retaining the later verdict', () => {
    const o = carryOptions(), newer = 'c'.repeat(40);
    const comments = o.rawPrs[0].comments;
    comments.splice(1, 0, trusted(`✅ review — accepted\n<!-- reviewed-sha: ${newer} -->`));
    const source = latestAcceptRecord(comments.slice(0, -1), [], { sha: old });
    expect(source).toMatchObject({ sha: old, index: 0, laterVerdict: true });
    // B supersedes A: selecting A must not discard B or publish B's clearance as A-to-C.
    runGhSync.mockClear();
    expect(runRedTeamOnSkip(o).rows[0].action).not.toBe('carry');
    expect(runGhSync).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it.each(['missing', 'untrusted'])(
    'falls back to the normal red-team run when the declared from acceptance is %s', kind => {
      const o = carryOptions(), missing = 'd'.repeat(40);
      const comments = o.rawPrs[0].comments;
      if (kind === 'missing') comments.at(-1).body = comments.at(-1).body.replace(`from=${old}`, `from=${missing}`);
      else comments[0].author.login = 'stranger';
      o.readEvidence = () => ({ loopPayload: payload(), inFlight: false, recorded: false });
      expect(latestAcceptRecord(comments.slice(0, -1), [], { sha: kind === 'missing' ? missing : old })).toBeNull();
      runGhSync.mockClear();
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'dispatch', mode: 'fresh' });
      expect(runGhSync).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it.each(['matching', 'mismatching', 'missing', 'wrong-target', 'malformed'])(
    'binds B policy-clear to the declared source in an A/B/C history: %s', provenance => {
      const o = carryOptions(), newer = 'c'.repeat(40);
      const comments = o.rawPrs[0].comments;
      comments.splice(1, 1,
        trusted(`✅ review — accepted\n<!-- reviewed-sha: ${newer} -->`),
        trusted(`${redTeamMarker(pr, newer)}\nRed team not required on this head: card-only diff`));
      const marker = `<!-- numbering-restamp: from=${old} to=${head} -->`;
      const replacement = provenance === 'matching' ? `<!-- numbering-restamp: from=${newer} to=${head} -->`
        : provenance === 'missing' ? ''
          : provenance === 'wrong-target' ? `<!-- numbering-restamp: from=${newer} to=${old} -->`
            : provenance === 'malformed' ? `<!-- numbering-restamp: from=unknown to=${head} -->` : marker;
      comments.at(-1).body = comments.at(-1).body.replace(marker, replacement);
      runGhSync.mockClear();
      const row = runRedTeamOnSkip(o).rows[0];
      if (provenance === 'matching') {
        expect(row).toMatchObject({ action: 'carry', from: newer });
        expect(runGhSync).toHaveBeenCalledOnce();
        expect(o.syncLabels).toHaveBeenCalledOnce();
      } else {
        expect(row.action).not.toBe('carry');
        expect(runGhSync).not.toHaveBeenCalled();
        expect(o.syncLabels).not.toHaveBeenCalled();
      }
    });
  it.each([true, false])('refuses ancient policy-clear when a newer blocked revision precedes the live-head re-stamp (source accepted: %s)', acceptedSource => {
    const o = carryOptions(), source = 'c'.repeat(40);
    o.rawPrs[0].comments.splice(2, 0,
      ...(acceptedSource ? [trusted(`✅ review — accepted\n<!-- reviewed-sha: ${source} -->`)] : []),
      trusted(`${redTeamMarker(pr, source)}\nRed team blocked`));
    runGhSync.mockClear();
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
    expect(runGhSync).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it('refuses carry when a trusted blocked result on another revision arrives after the live-head re-stamp', () => {
    const o = carryOptions();
    o.rawPrs[0].comments.push(trusted(`${redTeamMarker(pr, 'c'.repeat(40))}\nRed team blocked`));
    runGhSync.mockClear();
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
    expect(runGhSync).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it.each(['untrusted', 'other-pr'])('refuses carry when a late %s result supersedes acceptance under latestAcceptRecord', kind => {
    const o = carryOptions();
    const late = trusted(`${redTeamMarker(kind === 'other-pr' ? pr + 1 : pr, 'c'.repeat(40))}\nRed team blocked`);
    if (kind === 'untrusted') late.author.login = 'stranger';
    o.rawPrs[0].comments.push(late);
    runGhSync.mockImplementation(() => {});
    try {
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(runGhSync).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
    } finally { runGhSync.mockReset(); }
  });
  it.each(['not-owed', { status: 'not-owed' }])('finished %j clears accepted matching stored review and syncs', result => {
    const o = runFixture({ readEvidence: () => ({ loopPayload: payload(), seatRecorded: false, recorded: false,
      status: { status: 'finished', result } }),
      readStatus: () => ({ status: 'finished', result }) });
    o.rawPrs[0].labels = ['review:accepted'];
    // This R100 clear-success fixture previously lacked the accept comment establishing the accepted head.
    o.rawPrs[0].comments = [trusted(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`)];
    runGhSync.mockImplementation((_args, options) => o.rawPrs[0].comments.push(trusted(options.input)));
    try {
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('clear');
      expect(redTeamForHead(o.rawPrs[0].comments, pr, head)).toMatchObject({ pr, rev: head });
      expect(o.syncLabels).toHaveBeenCalledOnce();
    } finally { runGhSync.mockReset(); }
  });
  it.each(['unaccepted', 'seat-recorded', 'running', 'queued'])('finished not-owed refuses %s evidence', kind => {
    const evidence = { loopPayload: payload(), seatRecorded: false, recorded: false,
      status: { status: ['running', 'queued'].includes(kind) ? kind : 'finished', result: 'not-owed' } };
    const o = runFixture({ readEvidence: () => evidence,
      readStatus: () => ({ status: ['running', 'queued'].includes(kind) ? kind : 'finished', result: 'not-owed' }) });
    o.rawPrs[0].labels = kind === 'unaccepted' ? [] : ['review:accepted'];
    if (kind === 'seat-recorded') evidence.seatRecorded = true;
    expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'queued', result: null },
    { status: 'running', result: null },
    { status: 'finished', result: 'error' },
    { status: 'finished', result: { status: 'not-owed', deferredByGuard: true } },
    { status: 'finished', result: { status: 'not-owed', deferredByCap: true } },
    null,
  ].flatMap(status => ['selected', 'live'].map(source => [source, status])))(
    'refuses clear when the %s status disagrees with not-owed: %j', (source, status) => {
      const o = publicationOptions('finished/not-owed');
      if (source === 'live') o.readStatus = () => status;
      else {
        const evidence = o.readEvidence();
        o.readEvidence = () => ({ ...evidence, status });
      }
      runRedTeamOnSkip(o);
      expect(o.settle).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it.each(['error', 'skipped', 'ran', { status: 'not-owed', deferredByGuard: true }, { status: 'not-owed', deferredByCap: true }])('non-policy or deferred %j never clears an accepting stored review', result => {
    const o = runFixture({ readEvidence: () => ({ loopPayload: payload(), seatRecorded: false,
      status: { status: 'finished', result } }),
      readStatus: () => ({ status: 'finished', result }) });
    o.rawPrs[0].labels = ['review:accepted'];
    expect(runRedTeamOnSkip(o).rows[0].action).toBe(result === 'ran' ? 'dispatch' : 'skip');
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3])('ran with %i failed seats permits only one bounded fresh retry', failedSeatCount => {
    const o = runFixture({ readEvidence: () => ({ loopPayload: payload(), recorded: true, seatRecorded: true, completedRecorded: false, failedSeatCount }),
      readStatus: () => ({ status: 'finished', result: 'ran' }) });
    const row = runRedTeamOnSkip(o).rows[0];
    expect(row).toMatchObject(failedSeatCount === 1 ? { action: 'dispatch', mode: 'fresh' }
      : { action: 'skip', why: 'prior result ran (status finished); not re-run' });
    expect(o.syncLabels).not.toHaveBeenCalled();
    if (failedSeatCount === 1) expect(runRedTeamOnSkip(o).rows[0].why).toBe('retry cooldown active');
  });
  it.each([1, 2].flatMap(retryCount => [0, 1, 2].flatMap(failedSeatCount =>
    ['ran', { status: 'ran' }, 'resumed', { status: 'resumed' }].map(result => ({ retryCount, failedSeatCount, result })))))(
    'spent retry refuses fresh dispatch with $failedSeatCount seat rows, count=$retryCount, result=$result', ({ retryCount, failedSeatCount, result }) => {
      const o = runFixture({
        readEvidence: () => ({ loopPayload: payload(), inFlight: false, queued: false,
          recorded: failedSeatCount > 0, seatRecorded: failedSeatCount > 0, completedRecorded: false, failedSeatCount }),
        readStatus: () => ({ status: 'finished', result, retryCount }),
      });
      o.rawPrs[0].labels = ['review:accepted'];
      o.rawPrs[0].comments = [trusted(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`)];
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(o.dispatch).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled();
    });
  it('ran with completed seat retains effects-only resume instead of fresh retry or clear', () => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true, completedRecorded: true, failedSeatCount: 1 }),
      readStatus: () => ({ status: 'finished', result: 'ran' }) })).toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
  it.each([undefined, 0, 1, 2])('ran with completed seat retains effects-only resume with retryCount=%s', retryCount => {
    expect(decide({ readEvidence: () => ({ loopPayload: payload(), recorded: true, completedRecorded: true, failedSeatCount: 1 }),
      readStatus: () => ({ status: 'finished', result: 'ran', retryCount }) })).toMatchObject({ action: 'dispatch', mode: 'resume' });
  });
});


describe('unprovable accepted head move — fresh full review', () => {
  const old = 'b'.repeat(40);
  function moved(over = {}) {
    const loopPayload = payload();
    loopPayload.findings.read.netBasis.rev = old;
    return runFixture({
      rawPrs: [{ number: pr, headRefOid: head, labels: ['review:accepted'], reviews: [], comments: [
        { body: `✅ review — accepted\n<!-- reviewed-sha: ${old} -->`, author: { login: 'web-everything' } },
        { body: `${redTeamMarker(pr, old)}\nRed team not required on this head: card-only diff`, author: { login: 'web-everything' } },
      ] }],
      // Old review/red-team file survives a merge commit with no trusted re-stamp.
      readEvidence: () => ({ loopPayload, inFlight: false, queued: false, recorded: false, seatRecorded: false }),
      proveMove: vi.fn(() => ({ ok: false, reason: 'merge commit' })),
      log: vi.fn(), settle: vi.fn(), ...over,
    });
  }
  it.each(['old', 'absent', 'no-prior-clear'])('dispatches one full review with %s payload, then observes per-head cooldown', kind => {
    const o = moved();
    if (kind === 'no-prior-clear') o.rawPrs[0].comments.pop();
    if (kind === 'absent') o.readEvidence = () => ({ inFlight: false, recorded: false, seatRecorded: false });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'review', head });
    expect(o.dispatch).toHaveBeenCalledTimes(1); expect(o.dispatch).toHaveBeenCalledWith({ pr, repo });
    expect(o.settle).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
    expect(o.log).toHaveBeenCalledWith(`review-daemon: ${repo}#${pr} already-reviewed-head — fresh review dispatched for unprovable head move ${head.slice(0, 12)}`);
    o.capacity = { lanes: 1, budget: { left: 1 } };
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'retry cooldown active' });
    expect(o.dispatch).toHaveBeenCalledTimes(1);
  });
  it('refuses a standing formal CHANGES_REQUESTED without an acceptance comment or live-head evidence', () => {
    const o = moved({ readEvidence: () => ({ inFlight: false, recorded: false, seatRecorded: false }) });
    o.rawPrs[0].comments = [];
    o.rawPrs[0].reviews = [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-10-01T00:00:00Z',
      author: { login: 'reviewer' } }];
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
      why: 'formal review hold prevents full review; inspect formal reviews' });
    expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.lastDispatch.size).toBe(0);
  });
  it.each([undefined, null, {}])('refuses unreadable formal reviews %j without an acceptance comment or live-head evidence', reviews => {
    const o = moved({ readEvidence: () => ({ inFlight: false, recorded: false, seatRecorded: false }) });
    o.rawPrs[0].comments = [];
    o.rawPrs[0].reviews = reviews;
    o.readReviews = vi.fn(() => reviews);
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
      why: 'PR reviews unreadable; inspect formal reviews before full review' });
    expect(o.readReviews).toHaveBeenCalledWith({ repo, pr });
    expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.lastDispatch.size).toBe(0);
  });
  it('allows readable empty formal reviews without an acceptance comment or live-head evidence', () => {
    const o = moved({ readEvidence: () => ({ inFlight: false, recorded: false, seatRecorded: false }) });
    o.rawPrs[0].comments = [];
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'review', head });
    expect(o.dispatch).toHaveBeenCalledWith({ pr, repo });
  });
  it.each([
    '🔁 review — changes requested\n\nFix the guard.',
    '🔁 human review — changes requested\n\nFix the guard.',
    '🔁 review - changes requested\n\nFix the guard.',
    '🛑 conveyor fix — stood down (needs-judgment)',
  ])('refuses an explicit comment hold without an acceptance comment: %j', body => {
    const o = moved({ readEvidence: () => ({ inFlight: false, recorded: false, seatRecorded: false }) });
    o.rawPrs[0].comments = [{ body, author: { login: 'chalbert' } }];
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
      why: 'explicit review hold comment prevents full review; inspect the PR thread' });
    expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.lastDispatch.size).toBe(0);
  });
  it.each(['review:human', 'review:held-mechanical', 'review-status:reviewing', 'red-team:blocked', 'red-team:pending'])(
    'does not re-review a held PR with %s', label => {
      const o = moved(); o.rawPrs[0].labels.push(label);
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(o.dispatch).not.toHaveBeenCalled();
    });
  it.each(['inFlight', 'queued', 'recorded', 'seatRecorded', 'completedRecorded', 'status', 'unknown'])(
    'fails closed with live-head %s evidence', kind => {
      const o = moved(), evidence = o.readEvidence();
      if (kind === 'status') o.readStatus = () => ({ head, status: 'finished', result: 'error' });
      else if (kind === 'unknown') o.readEvidence = () => null;
      else o.readEvidence = () => ({ ...evidence, [kind]: true });
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(o.dispatch).not.toHaveBeenCalled();
    });
  it.each([{ lanes: 0 }, { lanes: 1, budget: { left: 0 } }, { lanes: 1, remainingStarts: 0 }])(
    'shares dispatch capacity checks %j', capacity => {
      const o = moved({ capacity });
      expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'no review capacity left' });
      expect(o.dispatch).not.toHaveBeenCalled(); expect(o.lastDispatch.size).toBe(0);
    });
  it('dry run spends no capacity, cooldown, or publication effects', () => {
    const o = moved({ dryRun: true });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'dry run (review)' });
    expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
    expect(o.lastDispatch.size).toBe(0); expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.settle).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it.each(['result', 'invalid-head', 'unaccepted', 'unknown-stored-head', 'unreadable-status'])(
    'does not start a full review with %s', kind => {
      const o = moved();
      if (kind === 'result') o.rawPrs[0].comments.push({ body: `${redTeamMarker(pr, head)}\nRed team not required on this head: card-only diff`, author: { login: 'web-everything' } });
      if (kind === 'invalid-head') o.rawPrs[0].headRefOid = 'unknown';
      if (kind === 'unaccepted') o.rawPrs[0].labels = [];
      if (kind === 'unknown-stored-head') {
        const evidence = o.readEvidence(); delete evidence.loopPayload.findings.read.netBasis.rev;
        o.readEvidence = () => evidence;
      }
      if (kind === 'unreadable-status') o.readStatus = () => { throw Error('unreadable'); };
      expect(runRedTeamOnSkip(o).rows[0].action).toBe('skip');
      expect(o.dispatch).not.toHaveBeenCalled();
    });
  it('keeps the red-team-only dispatch for an owed stored payload at the live head', () => {
    const o = moved({ readEvidence: () => ({ loopPayload: payload(), inFlight: false, recorded: false, seatRecorded: false }) });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'dispatch', mode: 'fresh' });
    expect(o.dispatch).toHaveBeenCalledTimes(1); expect(o.dispatch).toHaveBeenCalledWith({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh' });
  });
});


// Namespace access keeps missing feature exports as individual RED failures, not a collection error.
import * as staleRecovery from '../review-red-team-on-skip.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { pidNamespace, pidStartTime } from '../pid-alive.mjs';

const staleNow = Date.parse('2026-10-28T12:00:00Z');
const staleDeadline = 2 * 60 * 60 * 1000;
const deadRunningStatus = (over = {}) => ({ repo, pr, head, status: 'running', result: null,
  pid: 6039, host: 'fixture-host', pidNamespace: 'fixture-namespace',
  pidStart: new Date(staleNow - 60_000).toISOString(), ...over });
const staleProbe = (alive = false, start = deadRunningStatus().pidStart) => ({
  host: 'fixture-host', namespace: 'fixture-namespace',
  isAlive: vi.fn(() => alive), readPidStart: vi.fn(() => start),
});
function staleFixture(over = {}) {
  const status = deadRunningStatus();
  return fixture({ now: staleNow, probe: staleProbe(), staleSpent: () => false,
    rawPrs: [{ number: pr, headRefOid: head, labels: ['review:accepted', 'red-team:pending'], reviews: [],
      comments: [{ body: `✅ review — accepted\n<!-- reviewed-sha: ${head} -->`, author: { login: 'web-everything' } }] }],
    readEvidence: () => ({ loopPayload: { findings: { read: { netBasis: { rev: head } } } },
      inFlight: false, recorded: false, seatRecorded: false, completedRecorded: false, status }),
    readStatus: () => status, ...over });
}
function staleRunFixture(over = {}) {
  const f = staleFixture();
  return runFixture({ ...f, plan: { refusals: f.refusals }, now: () => staleNow,
    env: {}, readCarry: () => null,
    abandonStale: vi.fn(() => ({ ok: true, release: vi.fn() })),
    recoverPayload: vi.fn(() => payload()), ...over });
}

describe('staleRedTeamRun — dead running owner recovery', () => {
  it('exports the two-hour stale run deadline', () => {
    expect(staleRecovery.STALE_RUN_DEADLINE_MS).toBe(staleDeadline);
  });
  const old = new Date(staleNow - staleDeadline - 1).toISOString();
  it.each([
    ['dead local owner', {}, false, undefined, true],
    ['absent result with dead owner', { result: undefined }, false, undefined, true],
    ['live local owner', {}, true, undefined, false],
    ['live local owner past deadline', { pidStart: old }, true, old, false],
    ['live legacy owner without start time', { pidStart: undefined }, true, undefined, false],
    ['reused local pid', {}, true, 'a different start time', true],
    ['fresh remote host', { host: 'remote' }, false, undefined, false],
    ['expired remote host', { host: 'remote', pidStart: old }, true, undefined, true],
    ['fresh foreign namespace', { pidNamespace: 'other' }, false, undefined, false],
    ['expired foreign namespace', { pidNamespace: 'other', pidStart: old }, true, undefined, true],
    ['remote host at deadline', { host: 'remote', pidStart: new Date(staleNow - staleDeadline).toISOString() }, false, undefined, false],
    ['remote host with unknown age', { host: 'remote', pidStart: 'unparseable' }, false, undefined, false],
    ['foreign namespace with unknown age', { pidNamespace: 'other', pidStart: undefined }, false, undefined, false],
    ['missing local pid fresh', { pid: undefined }, false, undefined, false],
    ['missing local pid expired', { pid: undefined, pidStart: old }, false, undefined, true],
    ['invalid local pid fresh', { pid: -1 }, false, undefined, false],
    ['invalid local pid expired', { pid: 'invalid', pidStart: old }, false, undefined, true],
    ['invalid local pid unknown age', { pid: 0, pidStart: 'unparseable' }, false, undefined, false],
    ['queued', { status: 'queued' }, false, undefined, false],
    ['finished', { status: 'finished' }, false, undefined, false],
    ['abandoned', { status: 'abandoned' }, false, undefined, false],
    ['missing state', { status: undefined }, false, undefined, false],
    ['usable result', { result: { status: 'ran' } }, false, undefined, false],
    ['non-null false result', { result: false }, false, undefined, false],
    ['marked abandonment with live owner', { staleAbandoned: { at: staleNow } }, true, undefined, false],
  ])('%s', (_name, status, alive, start, stale) => {
    const result = staleRecovery.staleRedTeamRun({ status: deadRunningStatus(status), now: staleNow,
      deadlineMs: staleDeadline, probe: staleProbe(alive, start) });
    expect(result).toEqual({ stale, reason: expect.any(String) });
    expect(result.reason.length).toBeGreaterThan(0);
  });
  it('missing status fails closed', () => {
    expect(staleRecovery.staleRedTeamRun({ now: staleNow, probe: staleProbe() }))
      .toEqual({ stale: false, reason: expect.any(String) });
  });
  it('default probes recognize the real live owner even past the deadline', () => {
    expect(staleRecovery.staleRedTeamRun({ status: deadRunningStatus({ pid: process.pid,
      host: hostname(), pidNamespace: pidNamespace(), pidStart: pidStartTime(process.pid) }),
      now: staleNow + staleDeadline * 100, deadlineMs: staleDeadline }).stale).toBe(false);
  });
});

describe('planRedTeamOnSkip — PR 6039 truncated running payload', () => {
  it.each([true, false])('dead owner dispatches fresh with pending label %s', pending => {
    const f = staleFixture();
    if (!pending) f.rawPrs[0].labels = ['review:accepted'];
    expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'dispatch', mode: 'fresh', abandonStale: true });
  });
  it('live owner never dispatches', () => {
    expect(planRedTeamOnSkip(staleFixture({ probe: staleProbe(true) }))[0].action).toBe('skip');
  });
  it('spent stale recovery skips as already re-dispatched', () => {
    expect(planRedTeamOnSkip(staleFixture({ staleSpent: () => true }))[0])
      .toMatchObject({ action: 'skip', why: expect.stringContaining('already re-dispatched') });
  });
  it('dead owner respects retry cooldown', () => {
    expect(planRedTeamOnSkip(staleFixture({ lastDispatch: new Map([[`${repo}#${pr}@${head}`, staleNow - 1]]) }))[0])
      .toMatchObject({ action: 'skip', why: 'retry cooldown active' });
  });
  it('published head result still prevents stale recovery', () => {
    const f = staleFixture();
    f.rawPrs[0].comments.push({ body: redTeamMarker(pr, head), author: { login: 'web-everything' } });
    expect(planRedTeamOnSkip(f)[0]).toMatchObject({ action: 'skip', why: 'red-team result already on head' });
  });
});

describe('runRedTeamOnSkip — stale recovery effects', () => {
  it('abandons exactly once before fresh red-team-only dispatch', () => {
    const o = staleRunFixture();
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'dispatch', mode: 'fresh', abandonStale: true });
    expect(o.recoverPayload).toHaveBeenCalledOnce();
    expect(o.abandonStale).toHaveBeenCalledOnce();
    expect(o.abandonStale).toHaveBeenCalledWith({ repo, pr, head,
      status: o.readStatus(), env: o.env, now: staleNow, probe: o.probe });
    expect(o.dispatch).toHaveBeenCalledOnce();
    expect(o.dispatch).toHaveBeenCalledWith({ repo, pr, redTeamOnly: true, redTeamMode: 'fresh' });
    expect(o.abandonStale.mock.invocationCallOrder[0]).toBeLessThan(o.dispatch.mock.invocationCallOrder[0]);
  });
  it('two ticks share the real cooldown map and abandon/dispatch only once', () => {
    const o = staleRunFixture({ lastDispatch: new Map() });
    expect(runRedTeamOnSkip(o).dispatched).toHaveLength(1);
    o.capacity = { lanes: 1, budget: { left: 1 } };
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'retry cooldown active' });
    expect(o.abandonStale).toHaveBeenCalledOnce();
    expect(o.dispatch).toHaveBeenCalledOnce();
    expect(o.lastDispatch.get(`${repo}#${pr}@${head}`)).toBe(staleNow);
  });
  it('missing accepting review run fails closed before abandonment or dispatch', () => {
    const o = staleRunFixture({ recoverPayload: vi.fn(() => null) });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: expect.stringContaining('review run') });
    expect(o.recoverPayload).toHaveBeenCalledOnce();
    expect(o.abandonStale).not.toHaveBeenCalled();
    expect(o.dispatch).not.toHaveBeenCalled();
  });
  it('a dispatch that does not start releases its stale spend marker', () => {
    const release = vi.fn(), o = staleRunFixture({
      abandonStale: vi.fn(() => ({ ok: true, release })), dispatch: vi.fn(() => ({ skipped: 'x' })) });
    expect(runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'x' });
    expect(o.abandonStale).toHaveBeenCalledOnce();
    expect(o.dispatch).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(o.dispatch.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]);
    expect(o.lastDispatch.size).toBe(0);
  });
});

describe('abandonStaleRedTeamRun — durable one-shot marker', () => {
  it('preserves status, records one event, refuses a second spend, and releases the marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stale-red-team-marker-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_DAEMON_EVENTS: join(dir, 'daemon-events.jsonl') };
    try {
      recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'running' }, { env });
      const statusPath = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
      const status = { ...JSON.parse(readFileSync(statusPath, 'utf8')), ...deadRunningStatus(), extra: { preserve: true } };
      writeFileSync(statusPath, JSON.stringify(status));
      const input = { repo, pr, head, env, status, now: staleNow, probe: staleProbe() };
      const marker = `${statusPath}.stale-redispatch-1`;
      expect(staleRecovery.staleRedTeamSpent(input)).toBe(false);
      const result = staleRecovery.abandonStaleRedTeamRun(input);
      expect(result).toEqual({ ok: true, release: expect.any(Function) });
      expect(existsSync(marker)).toBe(true);
      expect(staleRecovery.staleRedTeamSpent(input)).toBe(true);
      expect(staleRecovery.staleRedTeamSpent({ ...input, head: 'b'.repeat(40) })).toBe(false);
      const rewritten = JSON.parse(readFileSync(statusPath, 'utf8'));
      expect(rewritten).toEqual({ ...status, staleAbandoned: { at: expect.anything(), pid: status.pid, reason: expect.any(String) } });
      expect(new Date(rewritten.staleAbandoned.at).getTime()).toBe(staleNow);
      const events = () => readFileSync(env.WE_DAEMON_EVENTS, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({ kind: 'red-team-stale-run-abandoned', repo, pr });
      expect(JSON.stringify(events()[0].detail)).toContain(head);
      expect(JSON.stringify(events()[0].detail)).toContain(String(status.pid));
      expect(staleRecovery.abandonStaleRedTeamRun(input)).toMatchObject({ ok: false });
      expect(events()).toHaveLength(1);
      result.release();
      expect(existsSync(marker)).toBe(false);
      expect(staleRecovery.staleRedTeamSpent(input)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['owner identity unreadable', 'unprobeable owner within deadline'])(
    'refuses abandonment when the re-read has %s without a marker or event', kind => {
      const dir = mkdtempSync(join(tmpdir(), 'stale-red-team-refused-'));
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_DAEMON_EVENTS: join(dir, 'daemon-events.jsonl') };
      try {
        recordRedTeamStatus({ repo, pr, loopPayload: payload(), status: 'running' }, { env });
        const statusPath = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
        const status = deadRunningStatus(kind === 'unprobeable owner within deadline' ? { host: 'remote' } : {});
        const original = JSON.stringify(status);
        writeFileSync(statusPath, original);
        const priorEvent = `${JSON.stringify({ kind: 'prior-event' })}\n`;
        writeFileSync(env.WE_DAEMON_EVENTS, priorEvent);
        const probe = staleProbe(true, null);
        expect(staleRecovery.staleRedTeamRun({ status, now: staleNow, probe }).stale).toBe(false);
        expect(staleRecovery.abandonStaleRedTeamRun({ repo, pr, head, env, status, now: staleNow, probe }))
          .toEqual({ ok: false });
        expect(existsSync(`${statusPath}.stale-redispatch-1`)).toBe(false);
        expect(readFileSync(env.WE_DAEMON_EVENTS, 'utf8')).toBe(priorEvent);
        expect(readFileSync(statusPath, 'utf8')).toBe(original);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});

describe('recoverStaleRunPayload — head-bound accepting review run', () => {
  it.each([false, true])('returns the newest matching run when it owes red team despite list order reversed=%s', reverse => {
    const dir = mkdtempSync(join(tmpdir(), 'stale-red-team-payload-'));
    try {
      const run = (id, at, over = {}) => {
        const value = { ...newRunRecord({ id, op: 'review-pr', input: { repo, pr } }), ...payload(), ...over };
        writeRun(value, dir);
        utimesSync(join(dir, `${id}.json`), new Date(at), new Date(at));
        return value;
      };
      const rows = [run('review-pr-old', 1000), run('review-pr-newest-matching', 4500),
        run('review-pr-rejected', 3000, { verdict: { verdict: 'changes' } }),
        run('review-pr-truncated', 4000, { verdict: null }),
        run('review-pr-carried', 4200, { carriedFrom: 'older-run' }),
        run('review-pr-other-head', 5000, { findings: { read: { netBasis: { rev: 'b'.repeat(40) } } } }),
        run('review-pr-other-repo', 6000, { input: { repo: 'other/repo', pr } }),
        run('review-pr-other-pr', 7000, { input: { repo, pr: pr + 1 } }),
        run('review-pr-other-op', 8000, { op: 'other' }), run('other-run', 9000)];
      const ids = rows.map(row => row.id);
      const list = vi.fn(() => reverse ? [...ids].reverse() : ids);
      const read = vi.fn(id => rows.find(row => row.id === id));
      expect(staleRecovery.recoverStaleRunPayload({ repo, pr, head, env: { WE_SHARED_RUNS_DIR: dir }, runsDir: dir, list, read }))
        .toEqual(rows[1]);
      expect(list).toHaveBeenCalledWith(dir);
      expect(read).not.toHaveBeenCalledWith('other-run', expect.anything());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([
    ['rejecting', { verdict: { verdict: 'changes' } }],
    ['incomplete', { verdict: null }],
    ['carried', { carriedFrom: 'older-run' }],
  ])('returns null when a newer %s review supersedes an older accept in either list order', (_kind, over) => {
    const dir = mkdtempSync(join(tmpdir(), 'stale-red-team-superseded-'));
    try {
      const rows = [
        { ...newRunRecord({ id: 'review-pr-old-accept', op: 'review-pr', input: { repo, pr } }), ...payload() },
        { ...newRunRecord({ id: 'review-pr-newest', op: 'review-pr', input: { repo, pr } }), ...payload(), ...over },
      ];
      rows.forEach((row, i) => {
        writeRun(row, dir);
        utimesSync(join(dir, `${row.id}.json`), new Date(1000 * (i + 1)), new Date(1000 * (i + 1)));
      });
      const read = id => rows.find(row => row.id === id);
      expect(staleRecovery.recoverStaleRunPayload({ repo, pr, head, runsDir: dir,
        list: () => rows.map(row => row.id), read })).toBeNull();
      expect(staleRecovery.recoverStaleRunPayload({ repo, pr, head, runsDir: dir,
        list: () => rows.map(row => row.id).reverse(), read })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['empty', 'truncated', 'non-accepting', 'wrong-head', 'wrong-repo', 'wrong-pr'])(
    'returns null with only %s evidence', kind => {
      const dir = mkdtempSync(join(tmpdir(), 'stale-red-team-no-payload-'));
      try {
        const id = 'review-pr-ineligible';
        const value = { ...newRunRecord({ id, op: 'review-pr', input: { repo, pr } }), ...payload() };
        if (kind === 'truncated') delete value.verdict;
        if (kind === 'non-accepting') value.verdict.verdict = 'changes';
        if (kind === 'wrong-head') value.findings.read.netBasis.rev = 'b'.repeat(40);
        if (kind === 'wrong-repo') value.input.repo = 'other/repo';
        if (kind === 'wrong-pr') value.input.pr++;
        writeRun(value, dir);
        expect(staleRecovery.recoverStaleRunPayload({ repo, pr, head, env: { WE_SHARED_RUNS_DIR: dir }, runsDir: dir,
          list: () => kind === 'empty' ? [] : [id], read: () => value })).toBeNull();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
