/** @file The `advisory:*` staleness sweep — labels come off a PR whose head moved, and only those. No `gh`. */
import { describe, expect, it } from 'vitest';
import { redTeamGateMarker, redTeamResultId, parseRedTeamComment } from '../../lib/red-team-gate.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { buildRoundExtensionComment } from '../round-extension-mark.mjs';

import {
  LIST_COMMENTS_CAP, redTeamRegateOwed, carriesAdvisoryLabel, commentsMayBeTruncated, defaultReadPr, sweepAdvisoryLabels as rawSweep,
} from '../advisory-label-sweep.mjs';

const HEAD = 'fd37ce270'.padEnd(40, 'a');
const NEW_HEAD = 'b'.repeat(40);
const advisory = (head = HEAD, login = 'web-everything') => ({
  body: `**Verdict:** 🚦 human review required\n**Advisory outcome:** \`accept\` — x.\nNet basis: \`${'a'.repeat(40)}..${head}\``,
  createdAt: '2026-09-19T12:00:00Z',
  author: { login },
});
const pr = (number, names, headRefOid, comments = [advisory()]) => ({
  number, headRefOid, comments, labels: names.map((name) => ({ name })),
});

// Every write is re-read live first (#4708). By default the "live" read returns the listed PR itself, so the
// pre-existing cases keep testing the plan; the #4708 cases inject a live read that differs from the snapshot.
const sweepAdvisoryLabels = (o = {}) => {
  const listed = () => o.listPrs?.() ?? [];
  return rawSweep({ readPr: ({ number }) => listed().find((x) => x.number === number), ...o });
};

function provider() {
  const calls = { set: [], currentRepo: 0 };
  return {
    calls,
    setLabels: (repo, number, spec) => { calls.set.push({ repo, number, spec }); },
    currentRepo: () => { calls.currentRepo += 1; return 'o/n'; },
  };
}

describe('sweepAdvisoryLabels', () => {
  it('drops advisory:accepted from a PR whose head moved, and leaves every other label alone', () => {
    const p = provider();
    const results = sweepAdvisoryLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(1, ['review:human', 'advisory:accepted'], NEW_HEAD)],
    });
    expect(results).toEqual([{ num: 1, remove: ['advisory:accepted'] }]);
    // Remove-only: no `add`, so `review:human` cannot be touched and nothing is ever added.
    expect(p.calls.set).toEqual([{ repo: 'o/n', number: 1, spec: { remove: ['advisory:accepted'] } }]);
  });

  it('bounce-then-sweep: a sent-back PR (review:changes) does not get advisory:accepted re-added while the head is unchanged', () => {
    const p = provider();
    expect(sweepAdvisoryLabels({
      repo: 'o/n', provider: p, listPrs: () => [pr(9, ['review:changes', 'review:human'], HEAD)],
    })).toEqual([]);
    expect(p.calls.set).toEqual([]);
  });

  it('drops advisory:changes as well', () => {
    const p = provider();
    sweepAdvisoryLabels({ repo: 'o/n', provider: p, listPrs: () => [pr(2, ['review:human', 'advisory:changes'], NEW_HEAD)] });
    expect(p.calls.set[0].spec.remove).toEqual(['advisory:changes']);
  });

  it('leaves a PR alone while its head is still the one the advisory judged', () => {
    const p = provider();
    expect(sweepAdvisoryLabels({
      repo: 'o/n', provider: p, listPrs: () => [pr(3, ['review:human', 'advisory:accepted'], HEAD)],
    })).toEqual([]);
    expect(p.calls.set).toEqual([]);
  });

  it('ignores PRs that carry no advisory label, whatever their head', () => {
    const p = provider();
    expect(sweepAdvisoryLabels({ repo: 'o/n', provider: p, listPrs: () => [pr(4, ['review:human'], NEW_HEAD)] })).toEqual([]);
    expect(carriesAdvisoryLabel(pr(4, ['review:human'], NEW_HEAD))).toBe(false);
    expect(carriesAdvisoryLabel(pr(5, ['advisory:changes'], NEW_HEAD))).toBe(true);
  });

  it('dry-run reports what it would remove without writing', () => {
    const p = provider();
    const results = sweepAdvisoryLabels({
      repo: 'o/n', provider: p, dryRun: true, listPrs: () => [pr(6, ['advisory:accepted'], NEW_HEAD)],
    });
    expect(results).toEqual([{ num: 6, remove: ['advisory:accepted'] }]);
    expect(p.calls.set).toEqual([]);
  });

  it('resolves the repo lazily when none was given, only once a write is about to happen', () => {
    const p = provider();
    sweepAdvisoryLabels({ provider: p, listPrs: () => [pr(7, ['advisory:accepted'], HEAD)] });
    expect(p.calls.currentRepo).toBe(0);
    sweepAdvisoryLabels({
      provider: p, listPrs: () => [pr(8, ['advisory:accepted'], NEW_HEAD), pr(9, ['advisory:changes'], NEW_HEAD)],
    });
    expect(p.calls.currentRepo).toBe(1);
    expect(p.calls.set.map((c) => c.repo)).toEqual(['o/n', 'o/n']);
  });

  it('reports a failed write on the entry and keeps sweeping the rest', () => {
    const p = provider();
    p.setLabels = (repo, number) => { if (number === 10) throw new Error('rate limited\nsecond line'); };
    const results = sweepAdvisoryLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(10, ['advisory:accepted'], NEW_HEAD), pr(11, ['advisory:accepted'], NEW_HEAD)],
    });
    expect(results).toEqual([
      { num: 10, remove: ['advisory:accepted'], error: 'rate limited' },
      { num: 11, remove: ['advisory:accepted'] },
    ]);
  });

  // Live 2026-10-05, PR #4015: the advise label write hit a rate limit, the accept note still posted, and an
  // older advisory:changes sat under it on the same head. The sweep must re-derive the label from the comment.
  it('repairs advisory:changes under a newer accept note that covers the live head', () => {
    const p = provider();
    p.ensureLabel = (...a) => { p.calls.ensured = a; };
    const older = { body: advisory(HEAD).body.replace('`accept`', '`changes`'), createdAt: '2026-09-19T11:00:00Z' };
    const results = sweepAdvisoryLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(12, ['review:human', 'review:pending', 'advisory:changes'], HEAD, [older, advisory(HEAD)])],
    });
    expect(results).toEqual([{ num: 12, remove: ['advisory:changes', 'review:pending'], add: 'advisory:accepted' }]);
    expect(p.calls.set).toEqual([{ repo: 'o/n', number: 12, spec: { add: 'advisory:accepted', remove: ['advisory:changes', 'review:pending'] } }]);
    expect(p.calls.ensured[1]).toBe('advisory:accepted');
  });

  it('adds the missing label on a human-gated PR with a covering advisory, but never without review:human', () => {
    const p = provider();
    const results = sweepAdvisoryLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(13, ['review:human'], HEAD), pr(14, ['review:accepted'], HEAD)],
    });
    expect(results).toEqual([{ num: 13, remove: [], add: 'advisory:accepted' }]);
  });

  // Steady state: the daemon visits every human-gated PR each tick, so a PR that already shows its advisory
  // outcome must cost zero provider calls (no label-create, no pr-edit) or the sweep re-creates the rate-limit incident.
  it('makes no write at all for a human-gated PR already showing its covering advisory (steady state)', () => {
    const p = provider();
    p.ensureLabel = (...a) => { p.calls.ensured = a; };
    expect(sweepAdvisoryLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(15, ['review:human', 'advisory:accepted'], HEAD, [advisory(HEAD)])],
    })).toEqual([]);
    expect(p.calls.set).toEqual([]);
    expect(p.calls.ensured).toBeUndefined();
    expect(p.calls.currentRepo).toBe(0);
  });

  it('does not repair a missing label from an advisory for an older head', () => {
    const p = provider();
    expect(sweepAdvisoryLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(16, ['review:human', 'review:pending'], NEW_HEAD, [advisory(HEAD)])],
    })).toEqual([]);
    expect(p.calls.set).toEqual([]);
  });

  it('never labels from a forged advisory authored by another login', () => {
    const p = provider();
    p.ensureLabel = (...a) => { p.calls.ensured = a; };
    expect(sweepAdvisoryLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(17, ['review:human', 'review:pending'], HEAD, [advisory(HEAD, 'drive-by-user')])],
    })).toEqual([]);
    expect(p.calls.set).toEqual([]);
    expect(p.calls.ensured).toBeUndefined();
  });

  it('a forged note for another head cannot strip a legitimate label, and cannot make the sweep flap', () => {
    const p = provider();
    expect(sweepAdvisoryLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(18, ['review:human', 'advisory:accepted'], HEAD, [advisory(HEAD), advisory(NEW_HEAD, 'drive-by-user')])],
    })).toEqual([]);
    expect(p.calls.set).toEqual([]);
  });

  // An advisory label with NO advisory comment behind it is not proof the head moved (#4708 rule (a)): only an
  // advisory that names a DIFFERENT head removes a label.
  it('never removes a label when no trusted advisory names a different head', () => {
    const p = provider();
    expect(sweepAdvisoryLabels({
      repo: 'o/n', provider: p, listPrs: () => [pr(19, ['review:human', 'advisory:accepted'], NEW_HEAD, [])],
    })).toEqual([]);
    expect(p.calls.set).toEqual([]);
  });
});

// ── Live PR #4708 (2026-10-10). `gh pr list --json comments` returns only the FIRST 100 comments (oldest first),
// and #4708 had 120. The shared snapshot's newest advisory was therefore the 15:37Z `pending-referral` note for
// 483aab1e2, not the 20:47:49Z `accept` note for the live head 34590bfe2: at 20:50:12Z the sweep removed
// `advisory:accepted` ("head moved past the advisory"), and every later tick read the same cut-off list, so the
// repair never fired. Bodies below are the real comments' load-bearing lines, verbatim.
describe('PR #4708 — a cut-off comment list never removes a label, and the live read repairs it', () => {
  const LIVE_HEAD = '34590bfe2a8b8bcacd14370365e534a02a0cc477';
  const CEREMONY = '**This PR still needs the human ceremony.** Clearing `review:human` requires the operator to run `/review 4708`.';
  const at = (createdAt, body, login = 'web-everything') => ({ author: { login }, createdAt, body });
  const filler = (i) => at(new Date(Date.parse('2026-10-09T22:18:14Z') + i * 60_000).toISOString(), `🔔 conveyor — note ${i}`);
  const pendingReferral = at('2026-10-10T15:37:45Z', [
    '**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.** Pending: 2 mandatory referral(s) await a ruling · 2 later-round advisory finding(s) moved to card suggestions',
    '**Verdict:** 🚦 human review required',
    '**Advisory outcome:** `pending-referral` — mandatory referrals still need a ruling; no `advisory:*` label is applied',
    'Net basis: `79d5c68979a203d13de48005bcf48a2989737c77..483aab1e27ec5219ef636392f69055834e748e2d` (rev `origin/lane/gh-merge-queue-gate` at review time) — 20 net changed file(s) vs current main (#2450), not `gh pr diff`\'s three-dot list.',
    CEREMONY,
  ].join('\n'));
  const owner = (t) => at(t, 'Mandatory review owner: 5a611fea-ed8d-8f93-ba36-2e577cbedd16 (correctness).\n<!-- mandatory-referrals-v1: x -->');
  const accept = at('2026-10-10T20:47:49Z', [
    '**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.** Accept: no blocking findings on this head · 1 later-round advisory finding(s) moved to card suggestions',
    '**Verdict:** 🚦 human review required',
    '**Advisory outcome:** `accept` — no blocking findings on this head; `advisory:accepted` is applied.',
    'Net basis: `d8c6943154feadc4d7643def50330b7dda848538..34590bfe2a8b8bcacd14370365e534a02a0cc477` (rev `origin/lane/gh-merge-queue-gate` at review time) — 20 net changed file(s) vs current main (#2450), not `gh pr diff`\'s three-dot list.',
    CEREMONY,
  ].join('\n'));
  // 120 comments in thread order: the 97th (index 96) is the pending-referral note, then "Mandatory review owner"
  // notes, the accept note last. The list read keeps only the first LIST_COMMENTS_CAP of them.
  const allComments = [
    ...Array.from({ length: 96 }, (_, i) => filler(i)), pendingReferral,
    ...Array.from({ length: 22 }, (_, i) => owner(`2026-10-10T20:4${i < 10 ? 3 : 6}:${String(10 + i).padStart(2, '0')}Z`)), accept,
  ];
  const LABELS = ['review:human', 'review-status:reviewing', 'review-round:8', 'status:awaiting-review'];
  const listed = (labels) => ({ number: 4708, headRefOid: LIVE_HEAD, labels: labels.map((name) => ({ name })), comments: allComments.slice(0, LIST_COMMENTS_CAP) });
  const live = (labels) => ({ number: 4708, state: 'OPEN', headRefOid: LIVE_HEAD, labels: labels.map((name) => ({ name })), comments: allComments });

  it('the fixture has the real shape: 120 comments, the list read cut at 100, the accept note covering the live head', () => {
    expect(allComments).toHaveLength(120);
    expect(commentsMayBeTruncated(listed(LABELS))).toBe(true);
    expect(commentsMayBeTruncated({ comments: allComments.slice(0, 99) })).toBe(false);
  });

  it('BEFORE (20:50:12Z): the cut-off snapshot alone no longer removes advisory:accepted — the live read keeps it', () => {
    const p = provider();
    const reads = [];
    const results = rawSweep({
      repo: 'web-everything/web-everything', provider: p,
      listPrs: () => [listed([...LABELS, 'advisory:accepted'])],
      readPr: (a) => { reads.push(a); return live([...LABELS, 'advisory:accepted']); },
    });
    expect(results).toEqual([]);
    expect(p.calls.set).toEqual([]);
    expect(reads).toEqual([{ repo: 'web-everything/web-everything', number: 4708 }]);
  });

  it('AFTER (20:52Z+): the label is gone, and the sweep restores it from the live read', () => {
    const p = provider();
    p.ensureLabel = (...a) => { p.calls.ensured = a; };
    const results = rawSweep({
      repo: 'web-everything/web-everything', provider: p,
      listPrs: () => [listed(LABELS)],
      readPr: () => live(LABELS),
    });
    expect(results).toEqual([{ num: 4708, remove: [], add: 'advisory:accepted' }]);
    expect(p.calls.set).toEqual([{ repo: 'web-everything/web-everything', number: 4708, spec: { add: 'advisory:accepted', remove: [] } }]);
    expect(p.calls.ensured[1]).toBe('advisory:accepted');
  });

  it('a stale snapshot never removes a label: the live read decides, and a failed live read writes nothing', () => {
    const p = provider();
    // Snapshot says the head moved; live says the advisory covers the live head → no write.
    const snapMoved = { ...listed([...LABELS, 'advisory:accepted']), headRefOid: 'b'.repeat(40), comments: allComments };
    expect(rawSweep({ repo: 'o/n', provider: p, listPrs: () => [snapMoved], readPr: () => live([...LABELS, 'advisory:accepted']) })).toEqual([]);
    // The live read throws → nothing is written, the failure is reported.
    const failed = rawSweep({ repo: 'o/n', provider: p, listPrs: () => [snapMoved], readPr: () => { throw new Error('HTTP 502\nmore'); } });
    expect(failed).toEqual([{ num: 4708, remove: [], skipped: 'live re-read failed: HTTP 502' }]);
    // A closed PR is never written to.
    expect(rawSweep({ repo: 'o/n', provider: p, listPrs: () => [snapMoved], readPr: () => ({ ...live([...LABELS, 'advisory:accepted']), headRefOid: 'c'.repeat(40), state: 'MERGED' }) })).toEqual([]);
    expect(p.calls.set).toEqual([]);
  });

  it('the live head moved for real: the label comes off only because the live advisory names a different head', () => {
    const p = provider();
    const moved = 'e'.repeat(40);
    const results = rawSweep({
      repo: 'o/n', provider: p,
      listPrs: () => [listed([...LABELS, 'advisory:accepted'])],
      readPr: () => ({ ...live([...LABELS, 'advisory:accepted']), headRefOid: moved }),
    });
    expect(results).toEqual([{ num: 4708, remove: ['advisory:accepted'] }]);
  });

  it('defaultReadPr reads ONE PR: labels/head from `gh pr view`, the WHOLE thread from the paginated reader', () => {
    const calls = [];
    const exec = (file, argv) => { calls.push([file, ...argv]); const { comments, ...rest } = live(LABELS); return JSON.stringify(rest); };
    const readComments = (number, o) => { calls.push(['readComments', number, o.repo]); return allComments; };
    const got = defaultReadPr({ repo: 'web-everything/web-everything', number: 4708, exec, readComments });
    expect(got.comments).toHaveLength(120);
    expect(got.headRefOid).toBe(LIVE_HEAD);
    expect(calls[0]).toEqual(['gh', 'pr', 'view', '4708', '--repo', 'web-everything/web-everything', '--json', 'number,state,labels,headRefOid']);
    expect(calls[1]).toEqual(['readComments', 4708, 'web-everything/web-everything']);
    // A failed comment read throws (never a partial thread).
    expect(() => defaultReadPr({ repo: 'o/n', number: 1, exec, readComments: () => { throw new Error('502'); } })).toThrow('502');
  });
});

  it('removes stale red-team status after a head change through the existing sweep writer', () => {
    const writes = [];
    const listed = pr(42, ['red-team:clear'], HEAD, []);
    const live = pr(42, ['red-team:clear'], NEW_HEAD, []);
    const out = rawSweep({ repo: 'o/n', listPrs: () => [listed], readPr: () => live,
      readStatusEvidence: () => ({ scheduled: false, recorded: false, inFlight: false }), log: () => {},
      provider: { setLabels: (...args) => writes.push(args) } });
    expect(out).toEqual([{ num: 42, add: null, remove: ['red-team:clear'] }]);
    expect(writes).toEqual([['o/n', 42, { add: null, remove: ['red-team:clear'] }]]);
  });

describe('red-team re-gate after a round grant (live PR #5485)', () => {
  const REPO = 'web-everything/web-everything';
  const RT_HEAD = 'c'.repeat(40);
  const finding = { summary: 'log:false crashes', category: 'edge-case', impactIfUnfixed: 'broken', file: 'scripts/x.mjs', line: 8,
    failure_scenario: 'run it', confirmedByRecheck: true, recheckReason: 'reproduced' };
  const bodyRt = renderRedTeamComment({ pr: 5485, rev: RT_HEAD, provider: 'codex', model: 'm', findings: [finding], recheckStatus: 'ok', foldedVerdict: 'changes' });
  const rid = redTeamResultId(parseRedTeamComment(bodyRt));
  const bot = (body, createdAt) => ({ author: { login: 'web-everything' }, body, createdAt });
  const gateRec = (outcome, createdAt) => bot(`${redTeamGateMarker(5485, RT_HEAD, outcome, rid)}\n**Red-team gate** x`, createdAt);
  const grant = (createdAt) => ({ author: { login: 'chalbert' }, createdAt,
    body: buildRoundExtensionComment({ repo: REPO, pr: 5485, by: 1, actor: 'chalbert', channel: 'chat', reason: 'Block', at: createdAt }) });
  const t = (n) => `2026-10-20T22:${String(n).padStart(2, '0')}:00Z`;
  const capped = [bot(bodyRt, t(34)), gateRec('round-cap', t(35))];
  const prOf = (comments) => ({ number: 5485, headRefOid: RT_HEAD, comments, labels: [{ name: 'red-team:blocked' }, { name: 'review:human' }] });

  it('owed when a grant follows the round-cap record; not before, not once the gate has recorded again', () => {
    expect(redTeamRegateOwed(prOf(capped), REPO)).toBe(false);
    expect(redTeamRegateOwed(prOf([...capped, grant(t(47))]), REPO)).toBe(true);
    expect(redTeamRegateOwed(prOf([...capped, grant(t(47)), gateRec('sent-back', t(48))]), REPO)).toBe(false);
    expect(redTeamRegateOwed(prOf([...capped, grant(t(47)), gateRec('round-cap', t(48))]), REPO)).toBe(false);
    expect(redTeamRegateOwed({ ...prOf([...capped, grant(t(47))]), headRefOid: 'd'.repeat(40) }, REPO)).toBe(false);
    expect(redTeamRegateOwed(prOf([...capped, grant(t(47))]), null)).toBe(false);
  });

  it('a grant from a non-operator does not owe a re-gate', () => {
    const forged = { ...grant(t(47)), author: { login: 'someone-else' } };
    expect(redTeamRegateOwed(prOf([...capped, forged]), REPO)).toBe(false);
  });

  const sweep = (comments, o = {}) => {
    const calls = [];
    const p = prOf(comments);
    const results = rawSweep({ repo: REPO, listPrs: () => [p], readPr: () => ({ ...p, state: 'OPEN' }),
      readStatusEvidence: () => ({ scheduled: false, recorded: true, inFlight: false }), log: () => {},
      provider: { setLabels: () => {}, ensureLabel: () => {}, readPrState: () => p, readComments: () => comments, currentRepo: () => REPO },
      regate: (a) => { calls.push(a); return { status: 'applied', outcome: 'sent-back' }; }, ...o });
    return { calls, results };
  };

  it('the sweep re-runs the gate once for the reopened PR and reports the gate status', () => {
    const { calls, results } = sweep([...capped, grant(t(47))]);
    expect(calls).toEqual([{ repo: REPO, pr: 5485 }]);
    expect(results.find((r) => r.regate)).toMatchObject({ num: 5485, regate: 'applied', outcome: 'sent-back' });
  });

  it('no re-run without a grant, on a dry run, or without a regate hook', () => {
    expect(sweep(capped).calls).toEqual([]);
    expect(sweep([...capped, grant(t(47))], { dryRun: true }).calls).toEqual([]);
    expect(() => sweep([...capped, grant(t(47))], { regate: null })).not.toThrow();
  });
});
