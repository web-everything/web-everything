// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as mod from '../review-red-team-on-skip.mjs';
import pendingBreak from '../../conveyor/soak/breaks/redteam-pending-label-never-settles.mjs';
import { latestAcceptRecord } from '../accept-carry-forward.mjs';
import { redTeamMarker, redTeamForHead } from '../red-team-gate.mjs';
import { redTeamOwedFor } from '../review-red-team-policy.mjs';
import { settleRedTeamSkip } from '../red-team-skip-outcome.mjs';
import { planRedTeamStatusLabels } from '../red-team-status-labels.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';

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
      const row = mod.runRedTeamOnSkip(o).rows[0];
      expect(row).toMatchObject({ action: 'skip', why: change === 'review changed'
        ? 'review-unfinished' : 'clear failed: evidence changed before settlement' });
      if (change === 'review changed') {
        expect(row).toMatchObject({ escalate: true,
          escalationContext: 'review-unfinished: an unfinished review run holds this head; a human must answer or cancel the pending confirmation' });
        expect(o.escalate).toHaveBeenCalledOnce(); expect(o.settlePending).not.toHaveBeenCalled();
      }
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
    const o = runFixture({ readEvidence: vi.fn(() => unknown) });
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
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: {}, recorded: false, seatRecorded: false, ...active })) });
    o.rawPrs[0].comments.push(resultComment());
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(o.syncLabels).not.toHaveBeenCalled();
    expect(row.settleError).toBe('red-team pass still active; label unchanged');
  });
  it('a result comment holding only the head marker (no explicit outcome) never synchronizes', () => {
    const o = resultRunFixture({  });
    o.rawPrs[0].comments.push({ author: { login: 'web-everything' }, body: redTeamMarker(pr, head) });
    expect(mod.runRedTeamOnSkip(o).rows[0].settleError).toBe('result comment not strictly clean');
    expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
    expect(o.rawPrs[0].labels).toContain('red-team:pending');
  });
  it('a newer marker-bearing comment with an indented confirmed break blocks clearing despite an older clean result', () => {
    const o = resultRunFixture({  });
    o.rawPrs[0].comments.push(resultComment(), { author: { login: 'web-everything' },
      body: `${redTeamMarker(pr, head)}\nRed team not required on this head: prior policy-clear carried\n  1. [**confirmed**] (edge-case, broken) — hidden break` });
    expect(mod.runRedTeamOnSkip(o).rows[0].settleError).toBe('result comment not strictly clean');
    expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
    expect(o.rawPrs[0].labels).toContain('red-team:pending');
  });
  it('an uppercase-marker comment with an indented confirmed break also blocks clearing', () => {
    const o = resultRunFixture({  });
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
       });
      if (!patch) {
        o.readWitness = vi.fn(() => ({ ok: false, reason: 'review-unfinished' }));
      }
      o.rawPrs[0].comments.push(resultComment());
      mod.runRedTeamOnSkip(o);
      expect(o.syncLabels).not.toHaveBeenCalled();
    }
  });
  it('a parsed confirmed break plus an extra indented unparsed finding line never clears, even with a later clean result', () => {
    const o = resultRunFixture({  });
    o.rawPrs[0].comments.push({ author: { login: 'web-everything' }, createdAt: iso(acceptedAt + 1),
      body: `${redTeamMarker(pr, head)}\n### Post-accept red team — 1 possible break(s), 1 confirmed by Claude's re-check\n\n1. [**confirmed**] (edge-case, broken) — real\n  2. [**confirmed**] (edge-case, broken) — hidden` },
    { ...resultComment(), createdAt: iso(acceptedAt + 2) });
    expect(mod.runRedTeamOnSkip(o).rows[0].settleError).toBe('result comment not strictly clean');
    expect(o.syncLabels).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
    expect(o.rawPrs[0].labels).toContain('red-team:pending');
  });
  it('a rejecting review payload beside an older accepting red-team status never clears', () => {
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: { verdict: { verdict: 'changes' } }, recorded: false, seatRecorded: false,
      status: { status: 'finished', result: { foldedVerdict: 'accept' } } })) });
    o.rawPrs[0].comments.push(resultComment());
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(o.syncLabels).not.toHaveBeenCalled();
    expect(row.settleError).toBe('review payload is not an accept; label unchanged');
  });
  it.each(['withheld', 'error', undefined])('an accept whose comment is %s (not confirmed posted) never clears on an older comment', comment => {
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: payload('accept'), recorded: false, seatRecorded: false,
      status: { status: 'finished', result: { status: 'ran', foldedVerdict: 'accept', ...(comment ? { comment } : {}) } } })) });
    o.rawPrs[0].comments.push(resultComment());
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(o.syncLabels).not.toHaveBeenCalled();
    expect(row.settleError).toBe('red-team result comment not confirmed posted; label unchanged');
  });
  it('a newer same-head changes run in the witness blocks clearing on an older accepting status', () => {
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: payload('accept'), recorded: false, seatRecorded: false,
      status: { status: 'finished', result: { status: 'ran', comment: 'posted', foldedVerdict: 'accept' } } })) });
    o.readWitness = vi.fn(() => ({ ok: true, newest: { verdict: { verdict: 'changes' } }, rawWriter: { parsed: null }, markers: {}, seats: [] }));
    o.rawPrs[0].comments.push(resultComment());
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(o.syncLabels).not.toHaveBeenCalled();
    expect(row.settleError).toBe('newest same-head review is not an accept; label unchanged');
  });
  it.each([
    ['execution failed', { status: 'failed', comment: 'posted', foldedVerdict: 'accept' }, undefined],
    ['completion not recorded', { status: 'ran', comment: 'posted', foldedVerdict: 'accept' }, false],
  ])('an accepting status with %s never clears', (_name, result, completedRecorded) => {
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: payload('accept'), recorded: false, seatRecorded: false,
      ...(completedRecorded === undefined ? {} : { completedRecorded }), status: { status: 'finished', result } })) });
    o.rawPrs[0].comments.push(resultComment());
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(o.syncLabels).not.toHaveBeenCalled();
    expect(row.settleError).toBe('red-team execution not proven complete; label unchanged');
  });
  it.each(['red-team:blocked', 'review:changes', 'review-status:pending'])('a clean accepted result never clears while the hold label %s is present', label => {
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: payload('accept'), recorded: false, seatRecorded: false,
      status: { status: 'finished', result: { status: 'ran', comment: 'posted', foldedVerdict: 'accept' } } })) });
    o.rawPrs[0].labels.push(label);
    o.rawPrs[0].comments.push(resultComment());
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(o.syncLabels).not.toHaveBeenCalled();
    expect(row.settleError).toBeTruthy();
  });
  it('a hold label that appears at the synchronizer\'s own read or write is not overwritten', () => {
    for (const when of ['read', 'write']) {
      let reads = 0;
      const labelsFor = n => (n > (when === 'read' ? 0 : 1) ? ['review:accepted', 'red-team:pending', 'red-team:blocked'] : ['review:accepted', 'red-team:pending']);
      const provider = { readPrState: vi.fn(() => ({ headRefOid: head, labels: labelsFor(++reads), comments: [] })),
        readComments: vi.fn(() => []), ensureLabel: vi.fn(), setLabels: vi.fn() };
      const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: payload('accept'), recorded: false, seatRecorded: false,
        status: { status: 'finished', result: { status: 'ran', comment: 'posted', foldedVerdict: 'accept' } } })), provider });
      o.syncLabels = (input) => {
        input.provider.readPrState(repo, pr);
        input.provider.setLabels(repo, pr, { add: 'red-team:clear', remove: ['red-team:pending'] });
      };
      o.rawPrs[0].comments.push(resultComment());
      const row = mod.runRedTeamOnSkip(o).rows[0];
      expect(provider.setLabels).not.toHaveBeenCalled();
      expect(row.settleError).toMatch(/hold label (appeared before settlement|present); label unchanged/);
    }
  });
  it('a throwing result evidence read settles nothing and reports settleError', () => {
    const o = runFixture({ readEvidence: () => { throw Error('fresh evidence offline'); } });
    o.rawPrs[0].comments.push(resultComment());
    expect(mod.runRedTeamOnSkip(o).rows[0].settleError).toBe('fresh evidence offline');
    expect(o.syncLabels).not.toHaveBeenCalled();
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

describe('non-accept verdicts retain pending', () => {
  it.each(['needs-human', 'changes', 'reject'])('accepted + pending + stored %s never settles', verdict => {
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload(verdict) }) });
    expect(mod.runRedTeamOnSkip(o).rows[0]).not.toHaveProperty('settle');
    expect(o.settlePending).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
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

describe('audit hardening: checked comments', () => {
  it('hands the synchronizer freshly checked comments and no cached live state', () => {
    const o = runFixture({ readEvidence: () => evidence({ loopPayload: payload('accept'), status: { status: 'finished', result: { status: 'ran', comment: 'posted', foldedVerdict: 'accept' } } }) });
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
      status: { status: 'finished', result: { status: 'ran', comment: 'posted', foldedVerdict: 'accept' } } })) });
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
      status: { status: 'finished', result: { status: 'ran', comment: 'posted', foldedVerdict: 'accept' } } })) });
    o.rawPrs[0].comments.push(resultComment(), { author: { login: 'web-everything' }, createdAt: iso(acceptedAt + 5),
      body: `<!-- we:red-team-advisory pr=0${pr} rev=${head} -->\nRed team not required on this head: x\n  1. [**confirmed**] (edge-case, broken) \u2014 hidden` });
    mod.runRedTeamOnSkip(o);
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
});

describe('head movement at the synchronizer is refused', () => {
  it('a new head observed at the write-time read never gets the previous head\'s clear', () => {
    let reads = 0;
    const provider = { readPrState: vi.fn(() => ({ headRefOid: ++reads > 1 ? 'b'.repeat(40) : head, labels: ['review:accepted', 'red-team:pending'], comments: [] })),
      readComments: vi.fn(() => []), ensureLabel: vi.fn(), setLabels: vi.fn() };
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: payload('accept'), recorded: false, seatRecorded: false,
      status: { status: 'finished', result: { status: 'ran', comment: 'posted', foldedVerdict: 'accept' } } })), provider });
    o.syncLabels = input => input.provider.setLabels(repo, pr, { add: 'red-team:clear', remove: ['red-team:pending'] });
    o.rawPrs[0].comments.push(resultComment());
    const row = mod.runRedTeamOnSkip(o).rows[0];
    expect(provider.setLabels).not.toHaveBeenCalled();
    expect(row.settleError).toMatch(/head moved/);
  });
});

describe('malformed label entries at the synchronizer are refused', () => {
  it.each([{}, null, 7, { name: 5 }])('a later read containing the label entry %j never authorises the clear', bad => {
    let reads = 0;
    const provider = { readPrState: vi.fn(() => ({ headRefOid: head, labels: ++reads > 1 ? ['review:accepted', 'red-team:pending', bad] : ['review:accepted', 'red-team:pending'], comments: [] })),
      readComments: vi.fn(() => []), ensureLabel: vi.fn(), setLabels: vi.fn() };
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: payload('accept'), recorded: false, seatRecorded: false,
      status: { status: 'finished', result: { status: 'ran', comment: 'posted', foldedVerdict: 'accept' } } })), provider });
    o.syncLabels = input => input.provider.setLabels(repo, pr, { add: 'red-team:clear', remove: ['red-team:pending'] });
    o.rawPrs[0].comments.push(resultComment());
    mod.runRedTeamOnSkip(o);
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
});

describe('policy-clear needs a proven acceptance even without a pending label', () => {
  it('a changes-requested comment carrying a reviewed-sha marker never authorises the clear action', () => {
    const f = notOwedFixture();
    const o = runFixture({ ...f, now: () => f.now });
    o.rawPrs[0].labels = o.rawPrs[0].labels.filter(label => (label.name ?? label) !== 'red-team:pending');
    o.rawPrs[0].comments = [{ author: { login: 'web-everything' }, createdAt: iso(acceptedAt),
      body: `\u{1F501} review \u2014 changes requested\n\nFix it.\n<!-- reviewed-sha: ${head} -->` }];
    mod.runRedTeamOnSkip(o);
    expect(o.settle).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
});


describe.each(['readWitness', 'readEvidence'])('unfinished review holds through %s', reader => {
  it.each([false, true])('publishes one needs-you note per head across two ticks (posted result=%s)', posted => {
    const dir = mkdtempSync(join(tmpdir(), 'unfinished-review-hold-'));
    try {
      const publishNeedsYou = vi.fn(), postComment = vi.fn();
      const o = posted ? resultRunFixture() : runFixture();
      o.env = { WE_SHARED_RUNS_DIR: join(dir, 'runs') };
      if (posted) o.rawPrs[0].comments.push(resultComment());
      o[reader] = vi.fn(() => ({ ok: false, reason: 'review-unfinished' }));
      o.escalate = vi.fn(({ why, ...key }) => settleRedTeamSkip({ ...key,
        redTeam: { status: 'skipped', reason: why }, io: { env: o.env, publishNeedsYou, postComment } }));
      for (let tick = 0; tick < 2; tick++) {
        const row = mod.runRedTeamOnSkip(o).rows[0];
        expect(row).toMatchObject({ action: 'skip', why: 'review-unfinished', escalate: true,
          escalationContext: 'review-unfinished: an unfinished review run holds this head; a human must answer or cancel the pending confirmation' });
        expect(row).not.toHaveProperty('settle');
        expect(o.rawPrs[0].labels).toContain('red-team:pending');
      }
      expect(o.escalate).toHaveBeenCalledTimes(2); expect(publishNeedsYou).toHaveBeenCalledOnce();
      expect(o[reader]).toHaveBeenCalledTimes(2);
      expect(o.dispatch).not.toHaveBeenCalled(); expect(o.settle).not.toHaveBeenCalled();
      expect(o.settlePending).not.toHaveBeenCalled(); expect(o.syncLabels).not.toHaveBeenCalled();
      expect(postComment).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['scan-capped', 'review-unreadable'])('%s does not trigger unfinished-review escalation', reason => {
    const o = runFixture(); o[reader] = vi.fn(() => ({ ok: false, reason }));
    expect(mod.runRedTeamOnSkip(o).rows[0]).toMatchObject({ action: 'skip', why: reason });
    expect(o.escalate).not.toHaveBeenCalled(); expect(o[reader]).toHaveBeenCalledOnce();
    expect(o.dispatch).not.toHaveBeenCalled(); expect(o.settlePending).not.toHaveBeenCalled();
    expect(o.syncLabels).not.toHaveBeenCalled();
  });
});

describe('write-time guard also requires acceptance and covers the policy-clear action', () => {
  const guarded = labelsOnWrite => {
    let reads = 0;
    const provider = { readPrState: vi.fn(() => ({ headRefOid: head, labels: ++reads > 1 ? labelsOnWrite : ['review:accepted', 'red-team:pending'], comments: [] })),
      readComments: vi.fn(() => []), ensureLabel: vi.fn(), setLabels: vi.fn() };
    return provider;
  };
  it.each([[['red-team:pending']], [['review:accepted', 'red-team:pending', 'red-team:blocked']]])('result settle refuses at write time with labels %j', labels => {
    const provider = guarded(labels);
    const o = runFixture({ readEvidence: vi.fn(() => ({ loopPayload: payload('accept'), recorded: false, seatRecorded: false,
      status: { status: 'finished', result: { status: 'ran', comment: 'posted', foldedVerdict: 'accept' } } })), readIgnorableConfirms: () => [], provider });
    o.syncLabels = input => input.provider.setLabels(repo, pr, { add: 'red-team:clear', remove: ['red-team:pending'] });
    o.rawPrs[0].comments.push(resultComment());
    mod.runRedTeamOnSkip(o);
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it.each([[['red-team:pending']], [['review:accepted', 'red-team:pending', 'red-team:blocked']]])('the policy-clear action refuses at write time with labels %j', labels => {
    const provider = guarded(labels);
    const f = notOwedFixture();
    const o = runFixture({ ...f, now: () => f.now, provider });
    o.syncLabels = input => input.provider.setLabels(repo, pr, { add: 'red-team:clear', remove: ['red-team:pending'] });
    mod.runRedTeamOnSkip(o);
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
});
