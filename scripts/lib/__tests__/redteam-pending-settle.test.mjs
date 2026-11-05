// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as mod from '../review-red-team-on-skip.mjs';
import pendingBreak from '../../conveyor/soak/breaks/redteam-pending-label-never-settles.mjs';
import { RUN_MTIME_SLACK_MS, ABANDONED_REVIEW_AFTER_MS } from '../drain-red-team-evidence.mjs';
import { latestAcceptRecord } from '../accept-carry-forward.mjs';
import { redTeamMarker, redTeamForHead } from '../red-team-gate.mjs';
import { redTeamOwedFor } from '../review-red-team-policy.mjs';
import { settleRedTeamSkip } from '../red-team-skip-outcome.mjs';
import { planRedTeamStatusLabels } from '../red-team-status-labels.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { createReviewJobIo } from '../../operations/review-job.mjs';

// Fail any accidental transport call locally; all intended IO is injected below.
vi.mock('../gh-throttle.mjs', async original => ({
  ...await original(), runGhSync: vi.fn(() => { throw Error('unexpected gh call'); }),
}));
vi.mock('../../operations/needs-you-feed.mjs', async original => ({
  ...await original(), publishAttention: vi.fn(() => { throw Error('unexpected feed call'); }),
}));

const repo = 'web-everything/web-everything', pr = 6416;
const head = 'a'.repeat(40), old = 'b'.repeat(40);
const acceptedAt = Date.parse('2026-10-25T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const trusted = (body, createdAt = iso(acceptedAt)) => ({ body, createdAt, author: { login: 'web-everything' } });
const accept = (sha = head) => trusted(`✅ review — accepted\n<!-- reviewed-sha: ${sha} -->`);
const payload = (verdict = 'needs-human', rev = head) => ({
  verdict: { verdict, humanRequired: false }, findings: { read: { netBasis: { rev } } },
});
const evidence = (over = {}) => ({
  loopPayload: payload(), inFlight: false, queued: false, recorded: false, seatRecorded: false, ...over,
});
function fixture(over = {}) {
  return { repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
    rawPrs: [{ number: pr, headRefOid: head, labels: ['review:accepted', 'red-team:pending'],
      comments: [accept()], reviews: [] }],
    readEvidence: () => evidence(), readStatus: () => null, readCarry: () => null,
    now: acceptedAt + 10_000, setting: { enabled: true, retryCooldownMin: 30 },
    lastDispatch: new Map(), ...over };
}
const decide = f => mod.planRedTeamOnSkip(f)[0];
function runFixture(over = {}) {
  const f = fixture();
  return { ...f, plan: { refusals: f.refusals }, now: () => f.now, env: {},
    readWitness: null, readReviews: vi.fn(() => []), proveMove: () => ({ ok: false }),
    capacity: { lanes: 1, budget: { left: 1 } }, dispatch: vi.fn(() => ({ jobPid: 42 })),
    settlePending: vi.fn(), escalate: vi.fn(), syncLabels: vi.fn(), settle: vi.fn(() => ({ outcome: 'policy-clear' })), ...over };
}
// Historical not-owed evidence without matching acceptance must escalate.
function notOwedFixture() {
  const status = { status: 'finished', result: 'not-owed' };
  const f = fixture({ readEvidence: () => evidence({ status }), readStatus: () => status });
  f.rawPrs[0].comments = [accept(old)];
  return f;
}
function notOwedRunFixture(over = {}) {
  const f = notOwedFixture();
  return runFixture({ ...f, now: () => f.now, ...over });
}
function resultRunFixture(over = {}, verdict = 'accept') {
  return runFixture({ readEvidence: () => evidence({ recorded: true, loopPayload: payload('accept'),
    status: { status: 'finished', result: { status: 'ran', comment: 'posted', foldedVerdict: verdict } } }), ...over });
}
function carryFixture() {
  const f = fixture({ readEvidence: () => evidence({ loopPayload: undefined }) });
  f.rawPrs[0].comments = [accept(old),
    trusted(`${redTeamMarker(pr, old)}\nRed team not required on this head: card-only diff`),
    trusted(`📌 review — acceptance re-stamped after a rebase (no new review)\n<!-- reviewed-sha: ${head} -->\n<!-- numbering-restamp: from=${old} to=${head} -->`)];
  return f;
}
function resultComment(confirmed = false) {
  return trusted(renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'fixture',
    foldedVerdict: confirmed ? 'changes' : 'accept', findings: confirmed ? [{
      summary: 'confirmed break', category: 'edge-case', impactIfUnfixed: 'broken',
      confirmedByRecheck: true, file: 'scripts/example.mjs', filesRead: ['scripts/example.mjs'],
    }] : [] }));
}

describe('result settlement requires a strictly clean comment or a confirmed break', () => {
  it.each(['indented finding', 'bulleted finding', 'unknown line', 'unconfirmed finding'])(
    '%s cannot replace pending with clear', kind => {
      const o = resultRunFixture();
      const clean = resultComment();
      const broken = resultComment(true);
      const body = kind === 'indented finding' ? broken.body.replace(/^1\./m, '  1.')
        : kind === 'bulleted finding' ? `${clean.body}\n- [**confirmed**] (edge-case, broken) — hidden break`
          : kind === 'unconfirmed finding' ? broken.body.replace('[**confirmed**]', '[not confirmed]')
            : `${clean.body}\nSomething else was found.`;
      o.rawPrs[0].comments.push(clean, trusted(body, iso(acceptedAt + 1)));
      expect(mod.runRedTeamOnSkip(o).rows[0].settleError).toBe('result comment not strictly clean');
      expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
      expect(o.rawPrs[0].labels).toContain('red-team:pending');
    });
  it('every marker-bearing comment must be strictly understood: an older one with unknown text blocks clearing even beside a newer clean result', () => {
    const o = resultRunFixture();
    o.rawPrs[0].comments.push(trusted(resultComment().body, iso(acceptedAt + 2)),
      trusted(`${resultComment().body}\nunknown text`, iso(acceptedAt + 1)));
    mod.runRedTeamOnSkip(o);
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
});

describe('complete bounded formal-review reads', () => {
  it('reads successive pages through the bounded injected transport', () => {
    const exec = vi.fn().mockReturnValueOnce(JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id, state: 'APPROVED' }))))
      .mockReturnValueOnce(JSON.stringify([{ id: 101, state: 'CHANGES_REQUESTED' }]));
    expect(mod.readCompletePrReviews({ repo, pr, exec })).toHaveLength(101);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1][0]).toEqual(['api', `repos/${repo}/pulls/${pr}/reviews?per_page=100&page=2`]);
    expect(exec.mock.calls[1][1]).toMatchObject({ timeout: 60_000, maxBuffer: 1024 * 1024 });
  });
  it.each(['parse failure', 'non-array', 'oversize', 'page cap'])(
    '%s refuses incomplete reviews for operator inspection', kind => {
      expect(mod.readCompletePrReviews).toBeTypeOf('function');
      const exec = vi.fn(() => kind === 'parse failure' ? '{' : kind === 'non-array' ? '{}'
        : kind === 'oversize' ? JSON.stringify([{ body: 'x'.repeat(1024 * 1024) }])
          : JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id, state: 'APPROVED' }))));
      expect(() => mod.readCompletePrReviews({ repo, pr, exec })).toThrow(/review|JSON/i);
      expect(exec.mock.calls.length).toBeLessThanOrEqual(10);
    });
  it('the job keeps its unfinished witness when complete reviews are unreadable', () => {
    const readCompleteReviews = vi.fn(() => { throw Error('complete reviews unreadable'); });
    const readWitness = vi.fn(() => ({ ok: false, reason: 'review-unfinished' }));
    const exec = vi.fn(() => JSON.stringify({ headRefOid: head, labels: ['review:accepted', 'red-team:pending'] }));
    const io = createReviewJobIo({ env: {}, exec, readWitness, readCompleteReviews });
    expect(() => io.readRedTeamOnlyPayload({ repo, pr, head })).toThrow(/review-unfinished/);
    expect(readCompleteReviews).toHaveBeenCalledOnce(); expect(readWitness).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledOnce();
  });
  it.each(['result', 'clear'])(
    '%s refuses unreadable complete reviews despite a readable legacy review snapshot', kind => {
      const status = { status: 'finished', result: 'not-owed' };
      const o = kind === 'result' ? resultRunFixture() : runFixture({
        readEvidence: () => evidence({ loopPayload: payload('accept'), status }), readStatus: () => status });
      if (kind === 'result') o.rawPrs[0].comments.push(resultComment());
      const readCompleteReviews = vi.fn(() => { throw Error('complete reviews unreadable'); });
      o.readCompleteReviews = readCompleteReviews;
      const row = mod.runRedTeamOnSkip(o).rows[0];
      if (kind === 'clear') expect(row.why).toBe('clear failed: evidence changed before settlement');
      else expect(row.settleError).toBe('complete reviews unreadable');
      expect(readCompleteReviews).toHaveBeenCalledOnce();
      expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
      expect(o.settle).not.toHaveBeenCalled();
    });
});

describe('policy-clear publication revalidates fresh evidence', () => {
  function clearFixture() {
    const status = { status: 'finished', result: 'not-owed' };
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload('accept'), status }), readStatus: () => status });
    o.provider = { readPrState: vi.fn(() => o.rawPrs[0]), setLabels: vi.fn() };
    o.readComments = vi.fn(() => o.rawPrs[0].comments);
    return o;
  }
  it.each(['hold comment', 'formal hold', 'head moved', 'state unreadable', 'comments unreadable',
    'reviews unreadable', 'review changed'])(
    '%s appearing before publication refuses clear and publishes nothing', change => {
      const o = clearFixture();
      if (change === 'hold comment') o.readComments.mockReturnValue([...o.rawPrs[0].comments,
        trusted('🔁 review — changes requested', iso(acceptedAt + 1))]);
      if (change === 'formal hold') o.readReviews.mockReturnValue([{ state: 'CHANGES_REQUESTED', submittedAt: iso(acceptedAt + 1) }]);
      if (change === 'head moved') o.provider.readPrState.mockReturnValue({ ...o.rawPrs[0], headRefOid: old });
      if (change === 'state unreadable') o.provider.readPrState.mockImplementation(() => { throw Error('state offline'); });
      if (change === 'comments unreadable') o.readComments.mockImplementation(() => { throw Error('comments offline'); });
      if (change === 'reviews unreadable') o.readReviews.mockImplementation(() => { throw Error('reviews offline'); });
      if (change === 'review changed') o.readEvidence = vi.fn().mockReturnValueOnce(o.readEvidence())
        .mockReturnValue({ ok: false, reason: 'review-unfinished' });
      expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
        why: 'clear failed: evidence changed before settlement' });
      expect(o.settle).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
      expect(o.provider.setLabels).not.toHaveBeenCalled();
    });
  it('passes freshly read comments to settle after the clear decision is revalidated', () => {
    const o = clearFixture();
    const comments = [...o.rawPrs[0].comments, trusted('🔔 conveyor — fresh status note')];
    o.readComments.mockReturnValue(comments);
    expect(mod.runRedTeamOnSkip(o).rows[0].action).toBe('clear');
    expect(o.settle).toHaveBeenCalledWith(expect.objectContaining({ comments }));
    expect(o.settle.mock.calls[0][0].comments).toBe(comments);
    expect(o.provider.readPrState).toHaveBeenCalledWith(repo, pr);
    expect(o.readComments).toHaveBeenCalledWith({ repo, pr });
    expect(o.readReviews).toHaveBeenCalledWith({ repo, pr });
    expect(o.syncLabels).toHaveBeenCalledOnce();
  });
});

describe('settlement reads fresh PR state and result evidence', () => {
  it('review-unfinished (unknown) evidence at settle time never synchronizes: pending is preserved', () => {
    const unknown = { ok: false, reason: 'review-unfinished',
      status: { status: 'finished', result: { foldedVerdict: 'accept' } } };
    const o = runFixture({ readEvidence: vi.fn(() => unknown), readIgnorableConfirms: () => [] });
    o.rawPrs[0].comments.push(resultComment());
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(o.syncLabels).not.toHaveBeenCalled();
    expect(o.readEvidence).toHaveBeenCalledWith({ repo, pr, head });
    expect(row.settleError).toBeTruthy();
  });
  it.each([
    ['in flight', { inFlight: true }],
    ['queued', { queued: true }],
    ['running status', { status: { status: 'running' } }],
    ['queued status', { status: { status: 'queued' } }],
  ])('active red-team work (%s) is never lifted by an older result: no label synchronization', (_name, active) => {
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: {}, recorded: false, seatRecorded: false, ...active })), readIgnorableConfirms: () => [] });
    o.rawPrs[0].comments.push(resultComment());
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(o.syncLabels).not.toHaveBeenCalled();
    expect(row.settleError).toBe('red-team pass still active; label unchanged');
  });
  it('a result comment holding only the head marker (no explicit outcome) never synchronizes', () => {
    const o = resultRunFixture({ readIgnorableConfirms: () => [] });
    o.rawPrs[0].comments.push({ author: { login: 'web-everything' }, body: redTeamMarker(pr, head) });
    expect(mod.runRedTeamOnSkip(o).rows[0].settleError).toBe('result comment not strictly clean');
    expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
    expect(o.rawPrs[0].labels).toContain('red-team:pending');
  });
  it('a newer marker-bearing comment with an indented confirmed break blocks clearing despite an older clean result', () => {
    const o = resultRunFixture({ readIgnorableConfirms: () => [] });
    o.rawPrs[0].comments.push(resultComment(), { author: { login: 'web-everything' },
      body: `${redTeamMarker(pr, head)}\nRed team not required on this head: prior policy-clear carried\n  1. [**confirmed**] (edge-case, broken) — hidden break` });
    expect(mod.runRedTeamOnSkip(o).rows[0].settleError).toBe('result comment not strictly clean');
    expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
    expect(o.rawPrs[0].labels).toContain('red-team:pending');
  });
  it('an uppercase-marker comment with an indented confirmed break also blocks clearing', () => {
    const o = resultRunFixture({ readIgnorableConfirms: () => [] });
    o.rawPrs[0].comments.push(resultComment(), { author: { login: 'web-everything' },
      body: `${redTeamMarker(pr, head).toUpperCase()}\nRed team not required on this head: x\n  1. [**confirmed**] (edge-case, broken) — hidden` });
    expect(mod.runRedTeamOnSkip(o).rows[0].settleError).toBe('result comment not strictly clean');
    expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
    expect(o.rawPrs[0].labels).toContain('red-team:pending');
  });
  it('carryConflict evidence or an unfinished witness at settle time never lifts the hold', () => {
    for (const patch of [{ carryConflict: true }, null]) {
      const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: {}, recorded: false, seatRecorded: false,
        status: { status: 'finished', result: { foldedVerdict: 'accept' } }, ...(patch ?? {}) })),
      readIgnorableConfirms: () => [] });
      if (!patch) {
        o.readWitness = vi.fn(() => ({ ok: false, reason: 'review-unfinished' }));
      }
      o.rawPrs[0].comments.push(resultComment());
      mod.runRedTeamOnSkip(o);
      expect(o.syncLabels).not.toHaveBeenCalled();
    }
  });
  it('a parsed confirmed break plus an extra indented unparsed finding line never clears, even with a later clean result', () => {
    const o = resultRunFixture({ readIgnorableConfirms: () => [] });
    o.rawPrs[0].comments.push({ author: { login: 'web-everything' }, createdAt: iso(acceptedAt + 1),
      body: `${redTeamMarker(pr, head)}\n### Post-accept red team — 1 possible break(s), 1 confirmed by Claude's re-check\n\n1. [**confirmed**] (edge-case, broken) — real\n  2. [**confirmed**] (edge-case, broken) — hidden` },
    { ...resultComment(), createdAt: iso(acceptedAt + 2) });
    expect(mod.runRedTeamOnSkip(o).rows[0].settleError).toBe('result comment not strictly clean');
    expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
    expect(o.rawPrs[0].labels).toContain('red-team:pending');
  });
  it('a rejecting review payload beside an older accepting red-team status never clears', () => {
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: { verdict: { verdict: 'changes' } }, recorded: false, seatRecorded: false,
      status: { status: 'finished', result: { foldedVerdict: 'accept' } } })), readIgnorableConfirms: () => [] });
    o.rawPrs[0].comments.push(resultComment());
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(o.syncLabels).not.toHaveBeenCalled();
    expect(row.settleError).toBe('review payload is not an accept; label unchanged');
  });
  it.each(['withheld', 'error', undefined])('an accept whose comment is %s (not confirmed posted) never clears on an older comment', comment => {
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: payload('accept'), recorded: false, seatRecorded: false,
      status: { status: 'finished', result: { foldedVerdict: 'accept', ...(comment ? { comment } : {}) } } })), readIgnorableConfirms: () => [] });
    o.rawPrs[0].comments.push(resultComment());
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(o.syncLabels).not.toHaveBeenCalled();
    expect(row.settleError).toBe('red-team result comment not confirmed posted; label unchanged');
  });
  it('a newer same-head changes run in the witness blocks clearing on an older accepting status', () => {
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: payload('accept'), recorded: false, seatRecorded: false,
      status: { status: 'finished', result: { comment: 'posted', foldedVerdict: 'accept' } } })), readIgnorableConfirms: () => [] });
    o.readWitness = vi.fn(() => ({ ok: true, newest: { verdict: { verdict: 'changes' } }, rawWriter: { parsed: null }, markers: {}, seats: [] }));
    o.rawPrs[0].comments.push(resultComment());
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(o.syncLabels).not.toHaveBeenCalled();
    expect(row.settleError).toBe('newest same-head review is not an accept; label unchanged');
  });
  it('a throwing result evidence read settles nothing and reports settleError', () => {
    const o = runFixture({ readEvidence: () => { throw Error('fresh evidence offline'); } });
    o.rawPrs[0].comments.push(resultComment());
    expect(mod.runRedTeamOnSkip(o).rows[0].settleError).toBe('fresh evidence offline');
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it('a throwing confirm retry also reports settleError without synchronizing', () => {
    const readEvidence = vi.fn().mockReturnValueOnce({ ok: false, reason: 'review-unfinished' })
      .mockImplementation(() => { throw Error('retry evidence offline'); });
    const o = runFixture({ readEvidence,
      readIgnorableConfirms: () => ({ ok: true, ids: ['review-pr-old'], acceptedAt }) });
    o.rawPrs[0].comments.push(resultComment());
    expect(mod.runRedTeamOnSkip(o).rows[0].settleError).toBe('retry evidence offline');
    expect(readEvidence).toHaveBeenCalledTimes(2); expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it.each(['result'].flatMap(kind => ['hold comment', 'formal hold', 'head moved', 'state throws',
    'comments throw', 'reviews throw', 'comments unknown', 'reviews unknown'].map(change => [kind, change])))(
    '%s retains pending when fresh %s appears after planning', (kind, change) => {
      const o = kind === 'not-owed' ? notOwedRunFixture() : resultRunFixture();
      if (kind === 'result') o.rawPrs[0].comments.push(resultComment(change === 'hold comment'));
      o.provider = { readPrState: vi.fn(() => {
        if (change === 'state throws') throw Error('state offline');
        return { ...o.rawPrs[0], headRefOid: change === 'head moved' ? old : head };
      }), setLabels: vi.fn() };
      o.readComments = vi.fn(() => {
        if (change === 'comments throw') throw Error('comments offline');
        return change === 'comments unknown' ? undefined : [...o.rawPrs[0].comments,
          ...(change === 'hold comment' ? [trusted('🔁 review — changes requested', iso(acceptedAt + 1))] : [])];
      });
      o.readReviews = vi.fn(() => {
        if (change === 'reviews throw') throw Error('reviews offline');
        return change === 'reviews unknown' ? undefined : change === 'formal hold'
          ? [{ state: 'CHANGES_REQUESTED', submittedAt: iso(acceptedAt + 1) }] : [];
      });
      expect(mod.runRedTeamOnSkip(o).rows[0].settleError).toBeTruthy();
      expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
      expect(o.provider.setLabels).not.toHaveBeenCalled();
    });
});

describe('unfinished evidence never authorizes a never-reviewed dispatch', () => {
  it.each([true, false])('escalates unchanged reason when never-reviewed proof is %s', neverReviewed => {
    const o = runFixture({ readEvidence: () => ({ ok: false, reason: 'review-unfinished' }),
      readIgnorableConfirms: () => [], headNeverReviewed: () => neverReviewed });
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'review-unfinished', escalate: true });
    expect(o.escalate).toHaveBeenCalledOnce(); expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.settlePending).not.toHaveBeenCalled();
  });
});

describe('non-accept verdicts retain pending', () => {
  it.each(['needs-human', 'changes', 'reject'])('accepted + pending + stored %s never settles', verdict => {
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload(verdict) }) });
    expect(mod.runRedTeamOnSkip(o).rows[0]).not.toHaveProperty('settle');
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
});

describe('confirm exclusion revalidates at list time', () => {
  const panelAt = acceptedAt - 10_000;
  const before = panelAt - RUN_MTIME_SLACK_MS - 1;
  function setup() {
    const id = 'review-pr-confirm';
    const run = { op: 'review-pr', input: { repo, pr }, verdict: { verdict: 'needs-human' },
      pending: { kind: 'confirm' }, effects: [], ...{ findings: payload().findings },
      stepTimings: [{ step: 'read', startedAt: iso(before) }] };
    const panel = { ...run, verdict: { verdict: 'accept' }, pending: null,
      stepTimings: [{ step: 'read', startedAt: iso(panelAt) }] };
    const io = { runsDir: 'fixture-runs', list: () => [id, 'review-pr-accepting-panel'],
      read: vi.fn(key => key === id ? run : panel),
      stat: vi.fn(() => ({ mtimeMs: before })) };
    const key = { repo, pr, head };
    const scan = mod.ignorableConfirmRunIds({ ...key, ...io, comments: [accept()], reviews: [],
      labels: ['review:accepted', 'red-team:pending'] });
    return { id, run, io, key, scan };
  }
  it('carries acceptance time and excludes a still-inert confirm', () => {
    const f = setup(); expect(f.scan.acceptedAt).toBe(panelAt);
    expect(mod.revalidatedConfirmList({ ...f.key, ...f.io, ignoreRunIds: f.scan.ids, acceptedAt: f.scan.acceptedAt })(f.io.runsDir)).toEqual(['review-pr-accepting-panel']);
  });
  it.each(['mtime', 'resume', 'effect', 'read failure', 'stat failure', 'missing acceptance time'])(
    '%s changing after scan retains the run and review-unfinished evidence', kind => {
      const f = setup();
      const o = runFixture({ readIgnorableConfirms: () => f.scan, headNeverReviewed: () => false,
        readEvidence: ({ ignoreRunIds = [], acceptedAt: stamp } = {}) => {
          if (!ignoreRunIds.length) return { ok: false, reason: 'review-unfinished' };
          if (kind === 'mtime') f.io.stat.mockReturnValue({ mtimeMs: acceptedAt + 1 });
          if (kind === 'resume') { f.run.resumeOf = 'review-pr-origin'; f.run.resumedAt = iso(acceptedAt + 1); }
          if (kind === 'effect') f.run.effects = [{ status: 'in-flight' }];
          if (kind === 'read failure') f.io.read.mockImplementation(() => { throw Error('unreadable'); });
          if (kind === 'stat failure') f.io.stat.mockImplementation(() => { throw Error('unreadable'); });
          const list = mod.revalidatedConfirmList({ ...f.key, ...f.io, ignoreRunIds,
            acceptedAt: kind === 'missing acceptance time' ? undefined : stamp });
          return list(f.io.runsDir).includes(f.id) ? { ok: false, reason: 'review-unfinished' }
            : evidence({ loopPayload: payload('accept') });
        } });
      o.readEvidence = vi.fn(o.readEvidence);
      expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: 'review-unfinished' });
      expect(o.readEvidence).toHaveBeenCalledTimes(2);
      expect(o.dispatch).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
    });
});

describe('not-owed settlement evidence and holds', () => {
  it('never settles pending for an unknown verdict string', () => {
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload('bogus') }) });
    expect(mod.runRedTeamOnSkip(o).rows[0]).not.toHaveProperty('settle');
    expect(o.settlePending).not.toHaveBeenCalled();
  });
  it.each(['missing reviews', 'null reviews', 'formal hold', 'hold without acceptance', 'later verdict', 'later body hold'])(
    'planner retains pending for %s', kind => {
      const f = notOwedFixture();
      if (kind === 'missing reviews') delete f.rawPrs[0].reviews;
      if (kind === 'null reviews') f.rawPrs[0].reviews = null;
      if (kind === 'formal hold') f.rawPrs[0].reviews = [{ state: 'CHANGES_REQUESTED', submittedAt: iso(acceptedAt + 1) }];
      if (kind === 'hold without acceptance') {
        f.rawPrs[0].labels = ['review:prep', 'red-team:pending'];
        f.rawPrs[0].comments = [trusted('🔁 review — changes requested')];
      }
      if (kind === 'later verdict' || kind === 'later body hold') f.rawPrs[0].comments.push(
        trusted(kind === 'later verdict' ? '❌ review — changes requested' : 'manifest baseline mismatch', iso(acceptedAt + 1)));
      expect(decide(f)).not.toHaveProperty('settle');
      const o = runFixture({ ...f, now: () => f.now, readReviews: () => { throw Error('reviews unreadable'); } });
      mod.runRedTeamOnSkip(o);
      expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
    });
  it.each(['review:prep', 'review:changes', 'review-status:running'])(
    'reads unaccepted reviews once and escalates without removal beside %s', label => {
      const o = notOwedRunFixture(); o.rawPrs[0].labels = [label, 'red-team:pending'];
      o.rawPrs[0].comments = []; delete o.rawPrs[0].reviews;
      o.rawPrs.push({ ...o.rawPrs[0] });
      expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', escalate: true });
      expect(o.readReviews).toHaveBeenCalledOnce(); expect(o.readReviews).toHaveBeenCalledWith({ repo, pr });
      expect(o.settlePending).not.toHaveBeenCalled();
    });
  it.each(['throws', 'unknown', 'formal hold'])(
    'unaccepted review read %s retains pending', kind => {
      const readReviews = vi.fn(() => {
        if (kind === 'throws') throw Error('unreadable');
        return kind === 'unknown' ? null : [{ state: 'CHANGES_REQUESTED', submittedAt: iso(acceptedAt + 1) }];
      });
      const o = notOwedRunFixture({ readReviews });
      o.rawPrs[0].labels = ['review:prep', 'red-team:pending']; o.rawPrs[0].comments = []; delete o.rawPrs[0].reviews;
      expect(mod.runRedTeamOnSkip(o).rows[0]).not.toHaveProperty('settle');
      expect(readReviews).toHaveBeenCalledOnce(); expect(o.settlePending).not.toHaveBeenCalled();
    });
});

describe('planner settlement annotations', () => {
  it.each([null, {}, undefined, { verdict: 7 }, { verdict: '' }, { verdict: '  ' }])(
    'never settles pending without a recorded review verdict: %j', verdict => {
      const o = runFixture({ readEvidence: () => evidence({ loopPayload: { ...payload(), verdict } }) });
      const row = mod.runRedTeamOnSkip(o).rows[0];
      expect(row).toMatchObject({ action: 'skip', why: 'stored review does not owe a red team' });
      expect(row).not.toHaveProperty('settle');
      expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
      expect(o.rawPrs[0].labels).toContain('red-team:pending');
    });
  it('escalates an unaccepted recorded accept despite finished not-owed evidence', () => {
    const status = { status: 'finished', result: 'not-owed' };
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload('accept'), status }), readStatus: () => status });
    o.rawPrs[0].labels = ['red-team:pending']; o.rawPrs[0].comments = [];
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', escalate: true });
    expect(o.settlePending).not.toHaveBeenCalled();
    expect(o.dispatch).not.toHaveBeenCalled();
  });
  it.each(['stored', 'live'].flatMap(source => ['deferredByGuard', 'deferredByCap', 'missing', 'running'].map(kind => [source, kind])))(
    'unknown verdict cannot settle with %s status %s', (source, kind) => {
      const good = { status: 'finished', result: 'not-owed' };
      const bad = kind === 'missing' ? null : kind === 'running' ? { ...good, status: 'running' }
        : { status: 'finished', result: { status: 'not-owed', [kind]: true } };
      const o = runFixture({ readEvidence: () => evidence({ loopPayload: { ...payload(), verdict: null },
        status: source === 'stored' ? bad : good }), readStatus: () => source === 'live' ? bad : good });
      o.rawPrs[0].labels = ['red-team:pending']; o.rawPrs[0].comments = [];
      expect(mod.runRedTeamOnSkip(o).rows[0]).not.toHaveProperty('settle');
      expect(o.settlePending).not.toHaveBeenCalled();
    });
  it.each(['!owed', 'acceptance sha mismatch', 'not accepted'])('%s non-owing stored review keeps pending and escalates', site => {
    const f = notOwedFixture();
    if (site === 'acceptance sha mismatch') {
      f.rawPrs[0].comments = [accept(old)];
      const status = { status: 'finished', result: 'not-owed' };
      f.readEvidence = () => evidence({ loopPayload: payload('changes'), status });
      f.readStatus = () => status;
    }
    if (site === 'not accepted') f.rawPrs[0].labels = ['review:prep', 'red-team:pending'];
    expect(redTeamOwedFor(f.readEvidence().loopPayload)).toBe(false);
    expect(decide(f)).toMatchObject({ action: 'skip', why: 'stored review does not owe a red team', escalate: true });
  });

  it.each(['early result', 'post-evidence result'])('%s skip settles through result label synchronization', site => {
    const f = fixture(); f.rawPrs[0].comments.push(resultComment());
    // The unfinished journal bypasses the first result check; settled evidence reaches the second.
    if (site === 'post-evidence result') f.readCarry = () => ({ step: 'pending' });
    f.readEvidence = vi.fn(() => evidence({ carry: { step: 'done' } }));
    expect(decide(f)).toMatchObject({ action: 'skip', why: 'red-team result already on head', settle: 'result' });
    expect(f.readEvidence).toHaveBeenCalledTimes(site === 'early result' ? 0 : 1);
  });

  it.each([
    ['unreadable evidence', f => { f.readEvidence = () => { throw Error('unreadable'); }; }],
    ['evidence ok false', f => { f.readEvidence = () => ({ ok: false, reason: 'review-unfinished' }); }],
    ['missing evidence', f => { f.readEvidence = () => undefined; }],
    ['inFlight', f => { f.readEvidence = () => evidence({ inFlight: true }); }],
    ['queued', f => { f.readEvidence = () => evidence({ queued: true }); }],
    ['recorded', f => { f.readEvidence = () => evidence({ recorded: true }); }],
    ['seatRecorded', f => { f.readEvidence = () => evidence({ seatRecorded: true }); }],
    ['unknown recorded', f => { f.readEvidence = () => evidence({ recorded: undefined }); }],
    ['unknown seatRecorded', f => { f.readEvidence = () => evidence({ seatRecorded: undefined }); }],
    ['stale read head', f => { f.rawPrs[0].labels = ['review:prep']; f.readEvidence = () => evidence({ loopPayload: payload('needs-human', old) }); }],
    ['missing read head', f => { f.readEvidence = () => evidence({ loopPayload: { verdict: { verdict: 'changes' } } }); }],
    ['owed review', f => { f.readEvidence = () => evidence({ loopPayload: payload('accept') }); }],
    ['unreadable comments', f => { f.rawPrs[0].comments = undefined; }],
    ['head moved', f => { f.rawPrs[0].headRefOid = old; }],
    ['disabled', f => { f.setting.enabled = false; }],
    ['other skip reason', f => { f.readEvidence = () => evidence({ carryConflict: true }); }],
  ])('fails closed without a settle field for %s', (_name, mutate) => {
    const f = fixture(); mutate(f);
    expect(decide(f)).not.toHaveProperty('settle');
  });
});

describe('pending conflicts retain the merge hold', () => {
  const pathFixture = path => path === 'carry' ? carryFixture()
    : fixture({ readEvidence: () => evidence({ loopPayload: undefined }) });
  it.each(['needsReview', 'carry'])('%s escalates lone pending without settling it', path => {
    const f = pathFixture(path);
    expect(decide(f)).toMatchObject({ action: 'skip', why: 'conflicting label prevents policy-clear', escalate: true });
    expect(decide(f)).not.toHaveProperty('settle');
    expect(f.rawPrs[0].labels).toContain('red-team:pending');
  });
  it.each(['needsReview', 'carry'].flatMap(path => ['red-team:blocked', 'review:changes'].map(label => [path, label])))(
    '%s escalates the real conflict %s', (path, label) => {
      const f = pathFixture(path); f.rawPrs[0].labels.push({ name: label });
      expect(decide(f)).toMatchObject({ action: 'skip', why: 'conflicting label prevents policy-clear', escalate: true });
    });
});

describe('review-unfinished reader retry with ignorable confirm ids', () => {
  it.each(['readWitness', 'readEvidence'])('%s re-reads once with ignoreRunIds and dispatches the owed accepted review', reader => {
    const f = fixture({ readEvidence: () => evidence({ loopPayload: payload('accept') }) });
    const success = reader === 'readWitness' ? { ok: true, rawWriter: { parsed: null } } : f.readEvidence();
    f[reader] = vi.fn().mockReturnValueOnce({ ok: false, reason: 'review-unfinished' }).mockReturnValue(success);
    f.readIgnorableConfirms = vi.fn(() => ['review-pr-old-confirm']);
    expect(decide(f)).toMatchObject({ action: 'dispatch', mode: 'fresh' });
    expect(f.readIgnorableConfirms).toHaveBeenCalledOnce();
    expect(f.readIgnorableConfirms).toHaveBeenCalledWith({ repo, pr, head, rawPr: f.rawPrs[0] });
    expect(f[reader].mock.calls).toEqual([[{ repo, pr, head }], [{ repo, pr, head, ignoreRunIds: ['review-pr-old-confirm'] }]]);
  });
  it.each(['readWitness', 'readEvidence'].flatMap(reader => ['empty ids', 'still unfinished', 'scan throws'].map(kind => [reader, kind])))(
    '%s fails closed for %s', (reader, kind) => {
      const f = fixture();
      f[reader] = vi.fn(() => ({ ok: false, reason: 'review-unfinished' }));
      f.readIgnorableConfirms = vi.fn(() => { if (kind === 'scan throws') throw Error('scan failed'); return kind === 'empty ids' ? [] : ['review-pr-confirm']; });
      expect(decide(f)).toMatchObject({ action: 'skip', why: 'review-unfinished' });
      expect(f.readIgnorableConfirms).toHaveBeenCalledOnce();
      expect(f[reader]).toHaveBeenCalledTimes(kind === 'still unfinished' ? 2 : 1);
    });
  it.each(['readWitness', 'readEvidence'])('%s never re-reads a failure with another reason', reader => {
    const f = fixture(); f[reader] = vi.fn(() => ({ ok: false, reason: 'scan-capped' }));
    f.readIgnorableConfirms = vi.fn(() => ['review-pr-confirm']);
    expect(decide(f)).toMatchObject({ action: 'skip', why: 'scan-capped' });
    expect(f[reader]).toHaveBeenCalledOnce(); expect(f.readIgnorableConfirms).not.toHaveBeenCalled();
  });
});

describe.each(['readWitness', 'readEvidence'])('unfinished review escalation through %s', reader => {
  it.each([true, false])('preserves the reader reason and never dispatches (no-head proof=%s)', neverReviewed => {
    const f = fixture({ readIgnorableConfirms: vi.fn(() => []), headNeverReviewed: vi.fn(() => neverReviewed) });
    f[reader] = vi.fn(() => ({ ok: false, reason: 'review-unfinished' }));
    const o = runFixture({ ...f, now: () => f.now });
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', escalate: true, why: 'review-unfinished' });
    expect(f.headNeverReviewed).toHaveBeenCalledOnce();
    expect(o.dispatch).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
    expect(o.escalate).toHaveBeenCalledOnce();
  });
  it('never uses the no-head proof for another reader failure', () => {
    const f = fixture({ readIgnorableConfirms: vi.fn(() => []), headNeverReviewed: vi.fn(() => true) });
    f[reader] = () => ({ ok: false, reason: 'scan-capped' });
    expect(decide(f)).toMatchObject({ action: 'skip', why: 'scan-capped' });
    expect(f.headNeverReviewed).not.toHaveBeenCalled();
  });
});

describe('headNeverReviewedFromRuns complete bounded proof', () => {
  const run = (over = {}) => ({ op: 'review-pr', input: { repo, pr }, ...payload('accept', old),
    pending: null, effects: [], ...over });
  function scanFixture(records = {}) {
    return { repo, pr, head, runsDir: 'fixture-runs', list: vi.fn(() => Object.keys(records)),
      read: vi.fn(id => records[id]), stat: vi.fn(() => ({ mtimeMs: acceptedAt })) };
  }
  function scan(f) {
    expect(mod.headNeverReviewedFromRuns, 'export the complete never-reviewed-head scanner').toBeTypeOf('function');
    return mod.headNeverReviewedFromRuns(f);
  }
  it.each([
    ['running review', { verdict: null }],
    ['pending review', { pending: { kind: 'agent' } }],
    ['pending effect', { effects: [{ status: 'pending' }] }],
    ['in-flight effect', { effects: [{ status: 'in-flight' }] }],
    ['confirm with in-flight effect', { verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' }, effects: [{ status: 'in-flight' }] }],
  ])('an older-head unfinished %s prevents a never-reviewed proof', (_name, over) => {
    expect(scan(scanFixture({ 'review-pr-old': run(over) }))).toBe(false);
  });
  it('an older-head needs-human confirm still prevents a never-reviewed proof', () => {
    expect(scan(scanFixture({ 'review-pr-old': run({ verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' } }) }))).toBe(false);
  });
  it('an exact-head unfinished confirm prevents proof even beside an older-head confirm', () => {
    const confirm = { verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' } };
    expect(scan(scanFixture({ 'review-pr-old': run(confirm), 'review-pr-head': run({ ...confirm, ...payload('needs-human') }) }))).toBe(false);
  });
  it.each([{}, [], { op: 'review-pr' }, { op: 'review-pr', input: { repo } }])('malformed review run cannot prove an unreviewed head: %j', record => {
    expect(scan(scanFixture({ 'review-pr-malformed': record }))).toBe(false);
  });
  it('proves an empty completed scan has never reviewed the head', () => {
    expect(scan(scanFixture())).toBe(true);
  });
  it('ignores old heads and exact-head records belonging to another repo or PR', () => {
    expect(scan(scanFixture({ 'review-pr-old': run(),
      'review-pr-other-repo': run({ input: { repo: 'other/repo', pr }, ...payload('accept') }),
      'review-pr-other-pr': run({ input: { repo, pr: pr + 1 }, ...payload('accept') }),
    }))).toBe(true);
  });
  it.each(['finished', 'unfinished', 'pending confirm'])('an exact-head %s run disproves never-reviewed', state => {
    const exact = run({ ...payload('accept'), ...(state === 'unfinished' ? { verdict: null } : {}),
      ...(state === 'pending confirm' ? { verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' } } : {}) });
    expect(scan(scanFixture({ 'review-pr-exact': exact }))).toBe(false);
  });
  it('recognizes an exact-head record with a string PR number', () => {
    expect(scan(scanFixture({ 'review-pr-exact': run({ ...payload('accept'), input: { repo, pr: String(pr) } }) }))).toBe(false);
  });
  it.each(['list', 'read', 'stat'])('returns false when %s throws instead of claiming no review', method => {
    const f = scanFixture({ 'review-pr-old': run() });
    f[method] = () => { throw Error('unreadable run scan'); };
    expect(scan(f)).toBe(false);
  });
  it('proves no exact-head review after exactly 400 parsed old-head runs', () => {
    const f = scanFixture(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`review-pr-${i}`, run()])));
    expect(scan(f)).toBe(true); expect(f.read).toHaveBeenCalledTimes(400);
  });
  it('over 400 parses returns false for operator inspection without claiming never-reviewed', () => {
    const f = scanFixture(Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`review-pr-${i}`, run()])));
    expect(scan(f)).toBe(false); expect(f.read.mock.calls.length).toBeLessThanOrEqual(400);
  });
});

describe('ignorableConfirmRunIds chronology and closed scan', () => {
  const panelAt = acceptedAt - 10_000;
  const before = panelAt - RUN_MTIME_SLACK_MS - 1;
  const run = (over = {}) => ({ op: 'review-pr', input: { repo, pr },
    verdict: { verdict: 'needs-human' }, pending: { kind: 'confirm' }, effects: [],
    stepTimings: [{ step: 'read', startedAt: iso(before) }], ...over });
  function scanFixture(records = { 'review-pr-confirm': run() }) {
    records = { ...records, 'review-pr-accepting-panel': run({ verdict: { verdict: 'accept' },
      pending: null, findings: payload('accept').findings,
      stepTimings: [{ step: 'read', startedAt: iso(panelAt) }] }) };
    return { repo, pr, head, comments: [accept()], reviews: [], labels: ['review:accepted', 'red-team:pending'],
      runsDir: 'fixture-runs', now: acceptedAt + 10_000,
      list: vi.fn(() => Object.keys(records)), read: vi.fn(id => records[id]),
      // A superseded confirm must have both started and last been written before acceptance.
      stat: vi.fn(() => ({ mtimeMs: before })) };
  }
  function scan(f) {
    expect(mod.ignorableConfirmRunIds, 'export the fail-closed confirm-run scanner').toBeTypeOf('function');
    return mod.ignorableConfirmRunIds(f);
  }
  it('refuses a confirm started after the accepting panel but before its acceptance comment', () => {
    const f = scanFixture({ 'review-pr-confirm': run({
      stepTimings: [{ step: 'read', startedAt: iso(panelAt + 1) }] }) });
    expect(scan(f)).toEqual({ ok: false, ids: [] });
  });
  it('refuses confirm exclusion without an exact-head accepting finished panel', () => {
    const f = scanFixture(); f.list = () => ['review-pr-confirm'];
    expect(scan(f)).toEqual({ ok: false, ids: [] });
  });
  it.each(['wrong head', 'non-accept', 'pending confirm', 'pending effect', 'unknown effect', 'missing start', 'invalid start'])(
    '%s cannot supply an accepting-panel anchor', kind => {
      const f = scanFixture(); const read = f.read;
      f.read = id => {
        const record = read(id);
        if (id !== 'review-pr-accepting-panel') return record;
        if (kind === 'wrong head') record.findings = payload('accept', old).findings;
        if (kind === 'non-accept') record.verdict = { verdict: 'needs-human' };
        if (kind === 'pending confirm') record.pending = { kind: 'confirm' };
        if (kind === 'pending effect') record.effects = [{ status: 'pending' }];
        if (kind === 'unknown effect') record.effects = [{ status: 'bogus' }];
        if (kind === 'missing start') record.stepTimings = [];
        if (kind === 'invalid start') record.stepTimings = [{ step: 'read', startedAt: 'invalid' }];
        return record;
      };
      expect(scan(f)).toEqual({ ok: false, ids: [] });
    });
  it('uses the earliest accepting-panel start regardless of scan order', () => {
    const f = scanFixture({ 'review-pr-earlier-panel': run({ pending: null, verdict: { verdict: 'accept' },
      findings: payload('accept').findings, stepTimings: [{ step: 'read', startedAt: iso(before - 1) }] }) });
    expect(scan(f)).toMatchObject({ ok: true, ids: [], acceptedAt: before - 1 });
  });
  it.each(['mtime', 'resumedAt'])(
    '%s after the panel started prevents exclusion even before the acceptance comment', kind => {
      const f = scanFixture();
      if (kind === 'mtime') f.stat = () => ({ mtimeMs: panelAt + 1 });
      else {
        const read = f.read;
        f.read = id => ({ ...read(id), ...(id === 'review-pr-confirm' ? {
          resumeOf: 'review-pr-origin', resumedAt: iso(panelAt + 1) } : {}) });
      }
      expect(scan(f)).toEqual({ ok: false, ids: [] });
    });
  it.each([acceptedAt + 1000, acceptedAt - RUN_MTIME_SLACK_MS, undefined, NaN, Infinity])(
    'refuses an old-start confirm with late or unreadable last-write time %s', mtimeMs => {
      const f = scanFixture(); f.stat = () => ({ mtimeMs });
      expect(scan(f)).toEqual({ ok: false, ids: [] });
    });
  it('ignores only old needs-human confirm runs, excluding finished and unrelated runs', () => {
    const f = scanFixture({ 'review-pr-confirm': run(),
      'review-pr-finished': run({ verdict: { verdict: 'accept' }, pending: null }),
      'review-pr-other-repo': run({ input: { repo: 'other/repo', pr } }),
      'review-pr-other-pr': run({ input: { repo, pr: pr + 1 } }),
      'review-pr-other-op': run({ op: 'other' }), 'other-op': run(),
    });
    expect(latestAcceptRecord(f.comments, f.reviews)).toMatchObject({ sha: head, laterVerdict: false, laterBodyDerivedHold: false });
    expect(scan(f)).toEqual({ ok: true, ids: ['review-pr-confirm'], acceptedAt: panelAt });
    expect(f.read.mock.calls.map(([id]) => id)).not.toContain('other-op');
  });
  it.each([{}, [], { op: 'review-pr' }, { op: 'review-pr', input: { repo } }])('malformed review run invalidates all ignorable ids: %j', record => {
    expect(scan(scanFixture({ 'review-pr-confirm': run(), 'review-pr-malformed': record }))).toEqual({ ok: false, ids: [] });
  });
  it('accepts object-shaped accepted labels', () => {
    const f = scanFixture(); f.labels = [{ name: 'review:accepted' }];
    expect(scan(f)).toEqual({ ok: true, ids: ['review-pr-confirm'], acceptedAt: panelAt });
  });
  it('returns no ids for a fully finished scan', () => {
    expect(scan(scanFixture({ 'review-pr-done': run({ pending: null }) }))).toEqual({ ok: true, ids: [], acceptedAt: panelAt });
  });
  it('accepts an old resumed confirm only when both starts precede the slack boundary', () => {
    expect(scan(scanFixture({ 'review-pr-confirm': run({ resumeOf: 'review-pr-origin', resumedAt: iso(before) }) })))
      .toEqual({ ok: true, ids: ['review-pr-confirm'], acceptedAt: panelAt });
  });
  it.each([
    ['no verdict', { verdict: null }], ['wrong verdict', { verdict: { verdict: 'accept' } }],
    ['not a confirm', { pending: { kind: 'agent' } }], ['no pending confirm', { verdict: null, pending: null }],
    ['pending effect', { effects: [{ status: 'pending' }] }], ['in-flight effect', { effects: [{ status: 'in-flight' }] }],
    ['missing read start', { stepTimings: [] }], ['invalid read start', { stepTimings: [{ step: 'read', startedAt: 'invalid' }] }],
    ['equal slack boundary', { stepTimings: [{ step: 'read', startedAt: iso(acceptedAt - RUN_MTIME_SLACK_MS) }] }],
    ['within slack', { stepTimings: [{ step: 'read', startedAt: iso(acceptedAt - 1) }] }],
    ['later start', { stepTimings: [{ step: 'read', startedAt: iso(acceptedAt + 1) }] }],
    ['resume missing resumedAt', { resumeOf: 'review-pr-origin' }],
    ['resume invalid resumedAt', { resumeOf: 'review-pr-origin', resumedAt: 'invalid' }],
    ['resume at slack boundary', { resumeOf: 'review-pr-origin', resumedAt: iso(acceptedAt - RUN_MTIME_SLACK_MS) }],
    ['resume after acceptance', { resumeOf: 'review-pr-origin', resumedAt: iso(acceptedAt + 1) }],
  ])('any unfinished run with %s invalidates the whole id list', (_name, over) => {
    expect(scan(scanFixture({ 'review-pr-ignorable': run(), 'review-pr-unsafe': run(over) }))).toEqual({ ok: false, ids: [] });
  });
  it('finished effects do not prevent ignoring an otherwise old confirm', () => {
    expect(scan(scanFixture({ 'review-pr-confirm': run({ effects: [{ status: 'applied' }] }) })))
      .toEqual({ ok: true, ids: ['review-pr-confirm'], acceptedAt: panelAt });
  });
  it('omits abandoned verdict-less terminal attempts using the drain abandonment age', () => {
    const f = scanFixture({ 'review-pr-abandoned': run({ verdict: null, pending: null }) });
    f.stat = () => ({ mtimeMs: f.now - ABANDONED_REVIEW_AFTER_MS });
    expect(scan(f)).toEqual({ ok: true, ids: [], acceptedAt: panelAt });
  });
  it('an old rewound resume is never treated as abandoned', () => {
    const f = scanFixture({ 'review-pr-rewound': run({ verdict: null, pending: null, resumeOf: 'review-pr-origin' }) });
    f.stat = () => ({ mtimeMs: f.now - ABANDONED_REVIEW_AFTER_MS - 1 });
    expect(scan(f)).toEqual({ ok: false, ids: [] });
  });
  it.each([
    ['unaccepted head', f => { f.labels = ['review:prep']; }],
    ['acceptance for another head', f => { f.comments = [accept(old)]; }],
    ['missing acceptance', f => { f.comments = []; }],
    ['later verdict', f => { f.comments.push(trusted('❌ review — changes requested')); }],
    ['later body-derived hold', f => { f.comments.push(trusted('manifest baseline mismatch')); }],
    ['later formal hold', f => { f.reviews = [{ state: 'CHANGES_REQUESTED', submittedAt: iso(acceptedAt + 1) }]; }],
    ['unparseable acceptedAt', f => { f.comments[0].createdAt = 'invalid'; }],
    ['missing acceptedAt', f => { delete f.comments[0].createdAt; }],
    ['unreadable comments', f => { f.comments = undefined; }],
    ['list throws', f => { f.list = () => { throw Error('unreadable directory'); }; }],
    ['read throws', f => { f.read = () => { throw Error('unreadable record'); }; }],
    ['stat throws', f => { f.stat = () => { throw Error('unreadable metadata'); }; }],
  ])('fails closed with no ids when %s', (_name, mutate) => {
    const f = scanFixture(); mutate(f); expect(scan(f)).toEqual({ ok: false, ids: [] });
  });
  it('allows exactly 400 parsed review runs', () => {
    const records = Object.fromEntries(Array.from({ length: 399 }, (_, i) => [`review-pr-${i}`, run({ pending: null })]));
    const f = scanFixture(records); expect(scan(f)).toEqual({ ok: true, ids: [], acceptedAt: panelAt });
    expect(f.read).toHaveBeenCalledTimes(400);
  });
  it('over 400 parses fails closed for operator inspection without partial ids or extra reads', () => {
    const records = Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`review-pr-${i}`, run()]));
    const f = scanFixture(records); expect(scan(f)).toEqual({ ok: false, ids: [] });
    expect(f.read.mock.calls.length).toBeLessThanOrEqual(400);
  });
});

describe('review recovery never removes pending', () => {
  it.each(['missing evidence', 'unreadable evidence', 'cooldown', 'formal hold', 'unreadable reviews'])(
    'retains pending for %s', kind => {
      const o = runFixture({ readEvidence: () => evidence({ loopPayload: undefined }) });
      if (kind === 'missing evidence') o.readEvidence = () => undefined;
      if (kind === 'unreadable evidence') o.readEvidence = () => { throw Error('evidence offline'); };
      if (kind === 'cooldown') o.lastDispatch.set(`${repo}#${pr}@${head}`, o.now() - 1);
      if (kind === 'formal hold') {
        o.rawPrs[0].comments = [];
        o.rawPrs[0].reviews = [{ state: 'CHANGES_REQUESTED', submittedAt: iso(acceptedAt + 1) }];
      }
      if (kind === 'unreadable reviews') {
        o.rawPrs[0].comments = []; o.rawPrs[0].reviews = null; o.readReviews = () => { throw Error('offline'); };
      }
      const row = mod.runRedTeamOnSkip(o).rows[0];
      expect(row.action).toBe('skip'); expect(row).not.toHaveProperty('settle');
      expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
    });
  it.each([
    { lanes: 0, budget: { left: 1 } }, { lanes: 1, budget: { left: 0 } },
    { lanes: 1, remainingStarts: 0 }, undefined,
  ])('retains pending when execution capacity is exhausted: %j', capacity => {
    const o = runFixture({ capacity, readEvidence: () => evidence({ loopPayload: undefined }) });
    mod.runRedTeamOnSkip(o);
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
});

describe('head-bound default pending settlement', () => {
  function setup(state = { headRefOid: head, labels: [{ name: 'red-team:pending' }, { name: 'keep-me' }] }) {
    const provider = { readPrState: vi.fn(() => state), setLabels: vi.fn() };
    expect(mod.settlePendingFor).toBeTypeOf('function');
    return { provider, settle: mod.settlePendingFor({ provider, env: {} }) };
  }
  it('reads the live head and removes only pending', () => {
    const { provider, settle } = setup();
    settle({ repo, pr, head, remove: ['keep-me'] });
    expect(provider.readPrState).toHaveBeenCalledWith(repo, pr);
    expect(provider.setLabels).toHaveBeenCalledOnce();
    expect(provider.setLabels).toHaveBeenCalledWith(repo, pr, { remove: ['red-team:pending'] });
  });
  it('refuses a head moved since planning', () => {
    const { provider, settle } = setup({ headRefOid: old, labels: ['red-team:pending'] });
    expect(settle({ repo, pr, head })).toEqual({ skipped: 'head-moved' });
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it.each([['red-team:pending', 'red-team:blocked'], [{ name: 'red-team:pending' }, { name: 'red-team:blocked' }],
    ['keep-me'], undefined].map(labels => [labels]))('preserves blocked, absent or unreadable pending labels %j', labels => {
    const { provider, settle } = setup({ headRefOid: head, labels });
    try { settle({ repo, pr, head }); } catch { /* Unreadable labels may throw, but never write. */ }
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('missing provenance escalates before attempting to read live state', () => {
    const { provider, settle } = setup();
    provider.readPrState.mockImplementation(() => { throw Error('live state unreadable'); });
    const o = notOwedRunFixture({ settlePending: settle });
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', escalate: true });
    expect(provider.readPrState).not.toHaveBeenCalled(); expect(o.escalate).toHaveBeenCalledOnce();
    expect(provider.setLabels).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
});

describe('runner settles pending without dispatch', () => {
  it.each(['carry', 'needsReview'])('%s escalates lone pending and keeps the merge hold across ticks', path => {
    const f = path === 'carry' ? carryFixture() : fixture({ readEvidence: () => evidence({ loopPayload: undefined }) });
    const o = runFixture({ ...f, now: () => f.now });
    for (let tick = 0; tick < 2; tick++) {
      const row = mod.runRedTeamOnSkip(o).rows[0];
      expect(row).toMatchObject({ action: 'skip', escalate: true, why: 'conflicting label prevents policy-clear' });
      expect(row).not.toHaveProperty('settle');
      expect(o.rawPrs[0].labels).toContain('red-team:pending');
    }
    expect(o.escalate).toHaveBeenCalledTimes(2);
    expect(o.escalate).toHaveBeenCalledWith({ repo, pr, head, why: 'conflicting label prevents policy-clear' });
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
    expect(o.settle).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it('escalation failure preserves why and never removes real conflicts', () => {
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: undefined }) });
    o.rawPrs[0].labels.push('red-team:blocked');
    o.escalate.mockImplementation(() => { throw Error('feed offline'); });
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', escalate: true,
      why: 'conflicting label prevents policy-clear', settleError: 'feed offline' });
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
  });
  it.each(['pending', 'real conflict'])('default settlement is inert under test for %s', kind => {
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: undefined }),
      settlePending: undefined, escalate: undefined });
    if (kind === 'real conflict') o.rawPrs[0].labels.push('red-team:blocked');
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(row.why).toBe('conflicting label prevents policy-clear');
    expect(row).not.toHaveProperty('settleError');
    expect(o.settle).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
  it.each(['pending', 'real conflict'])('dryRun never settles a guard conflict: %s', kind => {
    const o = runFixture({ dryRun: true, readEvidence: () => evidence({ loopPayload: undefined }) });
    if (kind === 'real conflict') o.rawPrs[0].labels.push('red-team:blocked');
    mod.runRedTeamOnSkip(o);
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.escalate).not.toHaveBeenCalled();
  });
  it('not-owed without acceptance provenance keeps pending and escalates', () => {
    const o = notOwedRunFixture(); const out = mod.runRedTeamOnSkip(o);
    expect(o.settlePending).not.toHaveBeenCalled();
    expect(o.escalate).toHaveBeenCalledOnce();
    expect(o.settlePending).not.toHaveBeenCalled();
    expect(out.rows[0]).toMatchObject({ action: 'skip', escalate: true });
    expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
    expect(o.dispatch).not.toHaveBeenCalled(); expect(o.capacity).toEqual({ lanes: 1, budget: { left: 1 } });
  });
  it.each(['red-team:blocked', { name: 'red-team:blocked' }])('not-owed preserves blocked label %j', label => {
    const o = notOwedRunFixture(); o.rawPrs[0].labels.push(label); mod.runRedTeamOnSkip(o);
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
  });
  it.each([false, true])('a result (confirmed break=%s) synchronizes labels only', confirmed => {
    const o = resultRunFixture({}, confirmed ? 'changes' : 'accept'); o.rawPrs[0].comments.push(resultComment(confirmed));
    expect(redTeamForHead(o.rawPrs[0].comments, pr, head)?.findings).toHaveLength(confirmed ? 1 : 0);
    const labels = [];
    o.syncLabels = vi.fn(key => {
      labels.push(planRedTeamStatusLabels({ ...key, labels: o.rawPrs[0].labels,
        comments: o.rawPrs[0].comments, evidence: key.evidence, env: { WE_RED_TEAM_CONFIRMED_BREAKS: 'broken=send-back' }, standingRuling: null }));
    });
    mod.runRedTeamOnSkip(o);
    expect(o.syncLabels).toHaveBeenCalledOnce();
    expect(o.syncLabels).toHaveBeenCalledWith(expect.objectContaining({ repo, pr, head }));
    expect(labels).toEqual([{ add: confirmed ? 'red-team:blocked' : 'red-team:clear', remove: ['red-team:pending'] }]);
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
  it.each(['not-owed', 'result'])('dryRun settles nothing for %s', kind => {
    const o = notOwedRunFixture({ dryRun: true }); if (kind === 'result') o.rawPrs[0].comments.push(resultComment());
    mod.runRedTeamOnSkip(o);
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
  });
  it.each(['escalate', 'syncLabels'])('%s failure is reported in settleError with unchanged why and does not abort the next row', method => {
    const o = method === 'syncLabels' ? resultRunFixture() : notOwedRunFixture();
    if (method === 'syncLabels') o.rawPrs[0].comments.push(resultComment());
    o[method] = vi.fn().mockImplementationOnce(() => { throw Error('settlement offline'); }).mockReturnValue(undefined);
    o.plan.refusals.push({ kind: 'already-reviewed-head', prNumber: pr + 1, headSha: head });
    o.rawPrs.push({ ...o.rawPrs[0], number: pr + 1, comments: [accept(method === 'syncLabels' ? head : old)] });
    if (method === 'syncLabels') o.rawPrs[1].comments.push(trusted(`${redTeamMarker(pr + 1, head)}\nRed team not required on this head: card-only diff`));
    const out = mod.runRedTeamOnSkip(o);
    expect(out.rows).toHaveLength(2); expect(out.rows[0].settleError).toBe('settlement offline');
    expect(out.rows[0].why).toBe(method === 'syncLabels' ? 'red-team result already on head' : 'stored review does not owe a red team');
    expect(out.rows[1]).toMatchObject({ prNumber: pr + 1, ...(method === 'syncLabels' ? { settle: 'result' } : { escalate: true }) });
    expect(o[method]).toHaveBeenCalledTimes(2);
  });
  it.each(['unreadable comments', 'head moved'])('%s never settles pending or result labels', guard => {
    const o = runFixture(); if (guard === 'unreadable comments') o.rawPrs[0].comments = undefined;
    else o.rawPrs[0].headRefOid = old;
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip',
      why: guard === 'head moved' ? 'live head missing or changed' : 'PR comments unreadable' });
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
  });
  it.each(['lone pending', 'real conflict'])('%s escalation publishes needs-you once across two ticks using real skip-published dedupe', kind => {
    const dir = mkdtempSync(join(tmpdir(), 'redteam-pending-settle-'));
    try {
      const publishNeedsYou = vi.fn(), postComment = vi.fn();
      const o = runFixture({ env: { WE_SHARED_RUNS_DIR: join(dir, 'runs') },
        readEvidence: () => evidence({ loopPayload: undefined }) });
      if (kind === 'real conflict') o.rawPrs[0].labels.push('review:changes');
      o.escalate = vi.fn(({ why, ...key }) => settleRedTeamSkip({ ...key,
        redTeam: { status: 'skipped', reason: why },
        io: { env: o.env, publishNeedsYou, postComment } }));
      for (let tick = 0; tick < 2; tick++) {
        expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', escalate: true,
          why: 'conflicting label prevents policy-clear' });
        expect(o.escalate).toHaveBeenCalledTimes(tick + 1);
      }
      for (const [input] of o.escalate.mock.calls) {
        expect(input).toMatchObject({ repo, pr, head,
          why: 'conflicting label prevents policy-clear' });
        expect(input).not.toHaveProperty('policy');
      }
      expect(publishNeedsYou).toHaveBeenCalledOnce();
      expect(publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({ repo, pr, head,
        reason: 'red team skipped (conflicting label prevents policy-clear); not cleared' }));
      expect(postComment).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('dryRun never publishes conflict escalation', () => {
    const o = runFixture({ dryRun: true, readEvidence: () => evidence({ loopPayload: undefined }) });
    o.rawPrs[0].labels.push('red-team:blocked'); mod.runRedTeamOnSkip(o);
    expect(o.settle).not.toHaveBeenCalled(); expect(o.escalate).not.toHaveBeenCalled();
  });
});

describe('audit hardening: unknown effect statuses and checked comments', () => {
  it.each(['bogus', 'weird'].flatMap(status => ['confirm', 'terminal-looking', 'abandoned'].map(kind => [status, kind])))(
    '%s effects in a %s record keep both run scanners closed', (status, kind) => {
      const run = { op: 'review-pr', input: { repo, pr }, ...payload(kind === 'confirm' ? 'needs-human' : 'accept', old),
        pending: kind === 'confirm' ? { kind: 'confirm' } : null, effects: [{ status }],
        stepTimings: [{ step: 'read', startedAt: iso(acceptedAt - RUN_MTIME_SLACK_MS - 1) }] };
      if (kind === 'abandoned') run.verdict = null;
      const input = { repo, pr, head, runsDir: 'fixture-runs', list: () => ['review-pr-unknown', 'review-pr-accepting-panel'],
        read: id => id === 'review-pr-unknown' ? run : { ...run, ...payload('accept'), pending: null, effects: [],
          stepTimings: [{ step: 'read', startedAt: iso(acceptedAt - 10_000) }] },
        stat: () => ({ mtimeMs: acceptedAt - ABANDONED_REVIEW_AFTER_MS - 1 }), now: acceptedAt,
        comments: [accept()], labels: ['review:accepted', 'red-team:pending'], reviews: [] };
      expect(mod.ignorableConfirmRunIds(input)).toEqual({ ok: false, ids: [] });
      expect(mod.headNeverReviewedFromRuns(input)).toBe(false);
    });
  it('hands the synchronizer freshly checked comments and no cached live state', () => {
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload('accept'), status: { status: 'finished', result: { comment: 'posted', foldedVerdict: 'accept' } } }) });
    o.rawPrs[0].comments.push(resultComment());
    const comments = [...o.rawPrs[0].comments, trusted('🔔 conveyor — newly read status')];
    o.readComments = vi.fn(() => comments);
    mod.runRedTeamOnSkip(o);
    expect(o.syncLabels).toHaveBeenCalledOnce();
    expect(o.syncLabels.mock.calls[0][0].comments).toBe(comments);
    expect(o.syncLabels.mock.calls[0][0]).not.toHaveProperty('live');
  });
});


describe('result settlement requires a fresh recorded verdict', () => {
  it.each([null, { status: 'finished', result: { comment: 'withheld' } },
    { status: 'finished', result: { foldedVerdict: 'bogus' } },
    { status: 'error', result: { foldedVerdict: 'accept' } }])('unknown recorded status %j never synchronizes', status => {
    const o = runFixture({ readEvidence: () => evidence({ status }) });
    o.rawPrs[0].comments.push(resultComment());
    expect(mod.runRedTeamOnSkip(o).rows[0].settleError).toBe('no recorded red-team verdict; label unchanged');
    expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
  });
  it.each([false, true])('a withheld changes result cannot clear pending (new confirmed break=%s)', confirmed => {
    const status = { status: 'finished', result: { foldedVerdict: 'changes', comment: 'withheld' } };
    const o = runFixture({ readEvidence: () => evidence({ status }) });
    o.rawPrs[0].comments.push(resultComment());
    if (confirmed) o.rawPrs[0].comments.push(trusted(resultComment(true).body, iso(acceptedAt + 1)));
    const plans = [];
    o.syncLabels.mockImplementation(input => plans.push(planRedTeamStatusLabels({ ...input,
      labels: o.rawPrs[0].labels, standingRuling: null })));
    mod.runRedTeamOnSkip(o);
    expect(o.syncLabels).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    expect(plans).toEqual(confirmed ? [{ add: 'red-team:blocked', remove: ['red-team:pending'] }] : []);
  });
});


describe('not-owed removal requires acceptance provenance', () => {
  const context = 'red-team:pending kept: not-owed review lacks acceptance provenance; needs a human look';
  it.each(['unaccepted', 'different head', 'needs-human', 'changes', 'reject'])(
    '%s keeps pending and escalates without publishing', kind => {
      const status = { status: 'finished', result: 'not-owed' };
      const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload(
        ['needs-human', 'changes', 'reject'].includes(kind) ? kind : 'accept'), status }), readStatus: () => status });
      if (kind === 'unaccepted') o.rawPrs[0].labels = ['red-team:pending'];
      if (kind === 'different head') o.rawPrs[0].comments = [accept(old)];
      const row = mod.runRedTeamOnSkip(o).rows[0];
      expect(row).toMatchObject({ action: 'skip', escalate: true, escalationContext: context });
      expect(row).not.toHaveProperty('settle');
      expect(o.escalate).toHaveBeenCalledOnce();
      expect(o.settlePending).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
      expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
      expect(o.rawPrs[0].labels).toContain('red-team:pending');
    });
  it('needs-human with finished not-owed status preserves a human do not merge hold', () => {
    const o = notOwedRunFixture();
    o.rawPrs[0].comments = [accept(), { body: 'do not merge', createdAt: iso(acceptedAt + 1), author: { login: 'human-reviewer' } }];
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(row).toMatchObject({ action: 'skip', why: 'later verdict or hold supersedes acceptance',
      escalate: true, escalationContext: context });
    expect(row).not.toHaveProperty('settle'); expect(o.escalate).toHaveBeenCalledOnce();
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
});

describe('re-stamped acceptance is not a confirm-exclusion anchor', () => {
  it('ignorableConfirmRunIds fails closed when the latest acceptance is a no-new-review re-stamp', () => {
    const stamp = `\u{1F4CC} review \u2014 acceptance re-stamped after a rebase (no new review)\n<!-- reviewed-sha: ${head} -->`;
    const comments = [{ author: { login: 'web-everything' }, createdAt: iso(acceptedAt), body: stamp }];
    const result = mod.ignorableConfirmRunIds({ repo, pr, head, comments, reviews: [], labels: ['review:accepted'],
      runsDir: '/runs', list: () => [], read: () => ({}), stat: () => ({ mtimeMs: acceptedAt - 3600e3 }), now: acceptedAt + 1000 });
    expect(result.ok).toBe(false);
    expect(result.ids).toEqual([]);
  });
});

describe('confirm exclusion needs an accepting comment, not just a marker', () => {
  it('a changes-requested comment carrying a reviewed-sha marker never anchors exclusion', () => {
    const comments = [{ author: { login: 'web-everything' }, createdAt: iso(acceptedAt),
      body: `\u{1F501} review \u2014 changes requested\n\nFix it.\n<!-- reviewed-sha: ${head} -->` }];
    const result = mod.ignorableConfirmRunIds({ repo, pr, head, comments, reviews: [], labels: ['review:accepted'],
      runsDir: '/runs', list: () => [], read: () => ({}), stat: () => ({ mtimeMs: acceptedAt - 3600e3 }), now: acceptedAt + 1000 });
    expect(result).toEqual({ ok: false, ids: [] });
  });
});


describe('settlement requires a proven accepting comment', () => {
  const falseAccept = () => trusted(`🔁 review — changes requested
<!-- reviewed-sha: ${head} -->`);
  it.each(['human hold without acceptance', 'changes marker', 'newer explicit hold before acceptance in array'])(
    '%s cannot authorize result settlement', kind => {
      const o = resultRunFixture();
      o.rawPrs[0].comments = kind === 'human hold without acceptance'
        ? [{ body: 'do not merge', author: { login: 'human-reviewer' }, createdAt: iso(acceptedAt) }]
        : kind === 'changes marker' ? [falseAccept()]
          : [trusted('🔁 review — changes requested', iso(acceptedAt + 1)), accept()];
      o.rawPrs[0].comments.push(resultComment());
      const row = mod.runRedTeamOnSkip(o).rows[0];
      expect(row.settleError).toBe('no proven acceptance for this head; label unchanged');
      expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
      expect(o.rawPrs[0].labels).toContain('red-team:pending');
    });
  it.each([['red-team:pending'], ['review:accepted', 'red-team:pending', {}]])(
    'unaccepted or unreadable labels %j cannot authorize result settlement', labels => {
      const o = resultRunFixture(); o.rawPrs[0].labels = labels; o.rawPrs[0].comments.push(resultComment());
      expect(mod.runRedTeamOnSkip(o).rows[0].settleError).toBeTruthy();
      expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
    });
  it('a changes-requested reviewed-sha marker cannot authorize policy-clear or pending removal', () => {
    const status = { status: 'finished', result: 'not-owed' };
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload('accept'), status }), readStatus: () => status });
    o.rawPrs[0].comments = [falseAccept()];
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(row.action).toBe('skip'); expect(row).not.toHaveProperty('settle');
    expect(o.settle).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
  it.each(['changes marker', 'newer explicit hold before acceptance in array'])(
    '%s cannot authorize confirm exclusion despite a finished accepting panel', kind => {
      const before = acceptedAt - 30_000;
      const records = {
        'review-pr-confirm': { op: 'review-pr', input: { repo, pr }, ...payload('needs-human'),
          pending: { kind: 'confirm' }, effects: [], stepTimings: [{ step: 'read', startedAt: iso(before) }] },
        'review-pr-panel': { op: 'review-pr', input: { repo, pr }, ...payload('accept'),
          pending: null, effects: [], stepTimings: [{ step: 'read', startedAt: iso(acceptedAt - 10_000) }] },
      };
      const comments = kind === 'changes marker' ? [falseAccept()]
        : [trusted('🔁 review — changes requested', iso(acceptedAt + 1)), accept()];
      expect(mod.ignorableConfirmRunIds({ repo, pr, head, comments, reviews: [],
        labels: ['review:accepted', 'red-team:pending'], runsDir: 'fixture-runs',
        list: () => Object.keys(records), read: id => records[id], stat: () => ({ mtimeMs: before }) }))
        .toEqual({ ok: false, ids: [] });
    });
});

describe('pending soak always replays recovery availability', () => {
  it.each(['missing module', 'missing exports'])('%s fails the replay instead of becoming expected-failure', async kind => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'pending-soak-missing-'));
    try {
      if (kind === 'missing exports') {
        mkdirSync(join(sourceRoot, 'scripts/lib'), { recursive: true });
        writeFileSync(join(sourceRoot, 'scripts/lib/review-red-team-on-skip.mjs'), 'export const unrelated = true;\n');
      }
      expect(pendingBreak.fixPresent(sourceRoot)).toBe(true);
      const report = await pendingBreak.run({ sourceRoot });
      expect(pendingBreak.judge(report).length).toBeGreaterThan(0);
      expect(report.violations.join(' ')).toMatch(/recovery module.*(import|export)/i);
    } finally { rmSync(sourceRoot, { recursive: true, force: true }); }
  });
});

describe('a clean-shaped red-team comment recording a non-accept verdict never clears', () => {
  it.each(['needs-human', 'changes', 'prevention-outstanding'])('recorded verdict %s beside an older accepting status does not synchronize', verdict => {
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: payload('accept'), recorded: false, seatRecorded: false,
      status: { status: 'finished', result: { comment: 'posted', foldedVerdict: 'accept' } } })), readIgnorableConfirms: () => [] });
    const advisory = "Advisory only: this comment changes no label itself; the red-team gate (setting `redTeam.confirmedBreaks`) sends a confirmed broken break back to the fixer. Head `"
      + head.slice(0, 12) + '` \u00b7 red team ';
    o.rawPrs[0].comments.push({ author: { login: 'web-everything' }, createdAt: iso(acceptedAt + 5),
      body: `${redTeamMarker(pr, head)}\n### Post-accept red team \u2014 no break found\n\n${advisory}codex/m \u00b7 recorded verdict \`${verdict}\`.\n\nThe red team tried to break this change and reported nothing.` });
    mod.runRedTeamOnSkip(o);
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
});

describe('zero-padded PR numbers in markers are still validated', () => {
  it('a padded-marker comment with an indented confirmed break blocks an older clean result from clearing', () => {
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: payload('accept'), recorded: false, seatRecorded: false,
      status: { status: 'finished', result: { comment: 'posted', foldedVerdict: 'accept' } } })), readIgnorableConfirms: () => [] });
    o.rawPrs[0].comments.push(resultComment(), { author: { login: 'web-everything' }, createdAt: iso(acceptedAt + 5),
      body: `<!-- we:red-team-advisory pr=0${pr} rev=${head} -->\nRed team not required on this head: x\n  1. [**confirmed**] (edge-case, broken) \u2014 hidden` });
    mod.runRedTeamOnSkip(o);
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
});
