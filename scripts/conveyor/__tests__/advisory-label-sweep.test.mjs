/** @file The `advisory:*` staleness sweep — labels come off a PR whose head moved, and only those. No `gh`. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishStoredRedTeamResult } from '../../lib/red-team-withheld-publish.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { describe, expect, it } from 'vitest';

import {
  defaultListUnpublishedStatuses, LIST_COMMENTS_CAP, carriesAdvisoryLabel, commentsMayBeTruncated, defaultReadPr, sweepAdvisoryLabels as realSweep,
} from '../advisory-label-sweep.mjs';

const rawSweep = (options = {}) => realSweep({ listUnpublishedStatuses: () => [], ...options });

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
    expect(calls[0]).toEqual(['gh', 'pr', 'view', '4708', '--repo', 'web-everything/web-everything', '--json', 'number,state,labels,headRefOid,reviews']);
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

describe('unknown red-team evidence settlement during sweep', () => {
  const startedAt = Date.parse('2026-10-10T10:00:00Z');
  const resultComment = (confirmed = false) => ({
    author: { login: 'web-everything' }, createdAt: '2026-10-10T10:30:00Z',
    body: renderRedTeamComment({ pr: 42, rev: NEW_HEAD, provider: 'codex', model: 'fixture',
      foldedVerdict: confirmed ? 'changes' : 'accept', findings: confirmed ? [{
        summary: 'confirmed break', category: 'edge-case', impactIfUnfixed: 'broken',
        confirmedByRecheck: true, file: 'scripts/example.mjs', filesRead: ['scripts/example.mjs'],
      }] : [] }),
  });

  it.each([
    { name: 'keeps clear after an abandoned undecided review', label: 'red-team:clear', desired: 'red-team:clear' },
    { name: 'replaces pending with clear after an abandoned undecided review', label: 'red-team:pending', desired: 'red-team:clear' },
    { name: 'keeps pending while the unfinished review is active', label: 'red-team:pending', desired: 'red-team:pending', active: true },
    { name: 'keeps pending without a result comment', label: 'red-team:pending', desired: 'red-team:pending', missing: true },
    { name: 'keeps pending when the complete head read is incomplete', label: 'red-team:pending', desired: 'red-team:pending', incomplete: true },
    { name: 'marks a recorded confirmed break blocked', label: 'red-team:pending', desired: 'red-team:blocked', confirmed: true },
  ])('$name', ({ label, desired, active, missing, incomplete, confirmed }) => {
    const p = provider();
    p.ensureLabel = () => {};
    const evidence = { ok: false, reason: 'review-unfinished', settleBounds: {
      unfinishedStartedAt: startedAt, unfinishedActiveAt: startedAt,
      evaluatedAt: startedAt + (active ? 30 : 61) * 60_000, unfinishedUndecided: true,
      completeHeadRead: () => ({ complete: !incomplete, blocked: false }),
    } };
    // Only the complete live thread and live head can settle the unknown evidence.
    const listed = pr(42, [label], HEAD, []);
    const live = pr(42, [label], NEW_HEAD, missing ? [] : [resultComment(confirmed)]);
    const out = rawSweep({ repo: 'o/n', provider: p, listPrs: () => [listed], readPr: () => live,
      readStatusEvidence: ({ head }) => { expect(head).toBe(NEW_HEAD); return evidence; }, log: () => {} });
    if (label === desired) {
      expect(out).toEqual([]);
      expect(p.calls.set).toEqual([]);
    } else {
      expect(out).toEqual([{ num: 42, add: desired, remove: [label] }]);
      expect(p.calls.set).toEqual([{ repo: 'o/n', number: 42, spec: { add: desired, remove: [label] } }]);
    }
  });
});

describe('finished red-team publication during sweep', () => {
  const status = { repo: 'o/n', pr: 42, head: HEAD, status: 'finished', result: { status: 'ran', comment: 'withheld', foldedVerdict: 'changes', confirmedMissCount: 1 } };
  function setup(extra = {}) {
    const p = provider();
    p.ensureLabel = () => {};
    const live = pr(42, ['red-team:pending'], HEAD, []);
    return { repo: 'o/n', provider: p, listPrs: () => [live], readPr: () => live,
      readStatusEvidence: () => ({ status, scheduled: true }), log: () => {}, ...extra };
  }
  it('publishes before labeling and reads fresh comments after posting', () => {
    const events = [];
    const o = setup({ publishStored: ({ status: raw }) => {
      expect(raw).toEqual(status); events.push('publish'); return { status: 'posted' };
    } });
    o.provider.readComments = () => { events.push('comments'); return [{ author: { login: 'web-everything' }, body: `<!-- we:red-team-advisory pr=42 rev=${HEAD} -->` }]; };
    const out = rawSweep(o);
    expect(events).toEqual(['publish', 'comments']);
    expect(out).toContainEqual(expect.objectContaining({ num: 42, add: 'red-team:clear' }));
  });
  it('a throwing publisher is logged and recorded but labels and the remaining sweep still run', () => {
    const logs = [];
    const o = setup({ publishStored: () => { throw Error('publisher failed'); }, log: s => logs.push(s) });
    const second = pr(43, ['advisory:accepted'], NEW_HEAD);
    o.listPrs = () => [pr(42, ['red-team:pending'], HEAD, []), second];
    o.readPr = ({ number }) => o.listPrs().find(p => p.number === number);
    const out = rawSweep(o);
    expect(out).toContainEqual(expect.objectContaining({ num: 42, publishError: 'publisher failed', add: 'red-team:blocked' }));
    expect(out).toContainEqual({ num: 43, remove: ['advisory:accepted'] });
    expect(logs.some(s => s.includes('publisher failed'))).toBe(true);
  });
  it('dry-run never invokes the publisher', () => {
    let calls = 0;
    rawSweep(setup({ dryRun: true, publishStored: () => { calls++; } }));
    expect(calls).toBe(0);
  });
});

describe('unlabeled unpublished red-team discovery', () => {
  const status = { repo: 'o/n', pr: 42, head: HEAD, status: 'finished',
    result: { status: 'ran', comment: 'withheld', foldedVerdict: 'changes', findings: [] } };
  it('lists only finished unpublished status files and ignores unreadable files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-discovery-'));
    try {
      writeFileSync(join(dir, 'pending.json'), JSON.stringify(status));
      writeFileSync(join(dir, 'posted.json'), JSON.stringify({ ...status, result: { ...status.result, comment: 'posted' } }));
      writeFileSync(join(dir, 'bad.json'), '{');
      expect(defaultListUnpublishedStatuses({ dir })).toEqual([status]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('publishes for an open PR without a red-team label', () => {
    const calls = [];
    const live = pr(42, [], HEAD, []);
    rawSweep({ repo: 'o/n', listPrs: () => [live], readPr: () => live,
      listUnpublishedStatuses: () => [status], readStatusEvidence: () => ({ status }),
      publishStored: input => { calls.push(input.status); return { status: 'retry' }; },
      provider: { ensureLabel: () => {}, setLabels: () => {} }, log: () => {} });
    expect(calls).toEqual([status]);
  });
  it.each([{ repo: 'other/repo' }, { head: NEW_HEAD }, { pr: 43 }])('does not nominate mismatched status %j', mismatch => {
    let calls = 0;
    rawSweep({ repo: 'o/n', listPrs: () => [pr(42, [], HEAD, [])],
      listUnpublishedStatuses: () => [{ ...status, ...mismatch }],
      readPr: () => { calls++; }, log: () => {} });
    expect(calls).toBe(0);
  });
  it('rechecks comments inside publication rather than reusing the pre-lock live snapshot', () => {
    const live = pr(42, [], HEAD, []);
    const marker = { author: { login: 'web-everything' }, body: `<!-- we:red-team-advisory pr=42 rev=${HEAD} -->` };
    let posts = 0;
    rawSweep({ repo: 'o/n', listPrs: () => [live], readPr: () => live,
      listUnpublishedStatuses: () => [status], readStatusEvidence: () => ({ status }),
      provider: { readComments: () => [marker], postComment: () => { posts++; },
        ensureLabel: () => {}, setLabels: () => {} }, log: () => {},
      publishStored: input => publishStoredRedTeamResult({ ...input,
        withLock: (_path, fn) => fn(), readStatus: () => status,
        writeStatus: () => { throw Error('must not write'); } }) });
    expect(posts).toBe(0);
  });
  it('failed live comment reads count attempts and escalate once after two', () => {
    let fresh = structuredClone(status);
    let posts = 0, escalations = 0;
    const options = { repo: 'o/n', listPrs: () => [pr(42, [], HEAD, [])],
      listUnpublishedStatuses: () => [status], readStatusEvidence: () => ({ status }),
      readPr: () => { throw Error('comments unavailable'); }, log: () => {},
      publishStored: input => publishStoredRedTeamResult({ ...input,
        withLock: (_path, fn) => fn(), readStatus: () => fresh,
        writeStatus: next => { fresh = next; }, postComment: () => { posts++; },
        publishNeedsYou: () => { escalations++; } }) };
    for (let i = 0; i < 3; i++) rawSweep(options);
    expect(fresh).toMatchObject({ publishAttempts: 2, needsYouPublished: true });
    expect(escalations).toBe(1);
    expect(posts).toBe(0);
  });
});

// R707 #2 (flow-sim R6b-G1): a clean result for the head, an unfinished same-head re-review started after it, and an
// operator accept settle to red-team:clear only when the sweep carries the live formal reviews to the settle.
describe('red-team label deadlock: accept stand-in needs the live reviews in the sweep', () => {
  const T = Date.parse('2026-11-06T14:42:13Z');
  const iso = ms => new Date(ms).toISOString();
  const resultComment = ({ rev = NEW_HEAD, confirmed = false } = {}) => ({
    author: { login: 'web-everything' }, createdAt: iso(T),
    body: renderRedTeamComment({ pr: 42, rev, provider: 'codex', model: 'fixture',
      foldedVerdict: confirmed ? 'changes' : 'accept', findings: confirmed ? [{
        summary: 'confirmed break', category: 'edge-case', impactIfUnfixed: 'broken',
        confirmedByRecheck: true, file: 'scripts/example.mjs', filesRead: ['scripts/example.mjs'],
      }] : [] }),
  });
  const accept = (sha = NEW_HEAD) => ({ author: { login: 'web-everything' }, createdAt: iso(T + 14 * 60e3),
    body: `Cleared by operator.\n<!-- reviewed-sha: ${sha} -->\n<!-- cleared-human: chalbert -->` });
  const evidence = () => ({ ok: false, reason: 'review-unfinished', settleBounds: {
    unfinishedStartedAt: T + 6 * 60e3, unfinishedActiveAt: T + 16 * 60e3, evaluatedAt: T + 2 * 3600e3, unfinishedUndecided: true,
    completeHeadRead: () => ({ complete: true, blocked: false }) } });
  const run = ({ comments, reviews, head = NEW_HEAD }) => {
    const p = provider();
    p.ensureLabel = () => {};
    const listed = pr(42, ['red-team:pending'], head, []);
    const live = { ...pr(42, ['red-team:pending'], head, comments), ...(reviews === undefined ? {} : { reviews }) };
    const out = rawSweep({ repo: 'o/n', provider: p, listPrs: () => [listed], readPr: () => live,
      readStatusEvidence: () => evidence(), log: () => {} });
    return { out, p };
  };

  it('settles clear for the deadlock input (clear result, unfinished re-review, operator accept, quiet over 60 min)', () => {
    const { out, p } = run({ comments: [resultComment(), accept()], reviews: [] });
    expect(out).toEqual([{ num: 42, add: 'red-team:clear', remove: ['red-team:pending'] }]);
    expect(p.calls.set).toEqual([{ repo: 'o/n', number: 42, spec: { add: 'red-team:clear', remove: ['red-team:pending'] } }]);
  });
  it('stays pending when the result and accept name an older head (newer head)', () => {
    const { out } = run({ comments: [resultComment({ rev: HEAD }), accept(HEAD)], reviews: [] });
    expect(out).toEqual([]);
  });
  it('stays blocked for a confirmed break', () => {
    const { out } = run({ comments: [resultComment({ confirmed: true }), accept()], reviews: [] });
    expect(out).toEqual([{ num: 42, add: 'red-team:blocked', remove: ['red-team:pending'] }]);
  });
  it('stays pending (fails closed) when the formal reviews are unreadable', () => {
    expect(run({ comments: [resultComment(), accept()], reviews: undefined }).out).toEqual([]);
    expect(run({ comments: [resultComment(), accept()], reviews: null }).out).toEqual([]);
  });
  it('stays pending when a later formal review holds after the accept', () => {
    const hold = { state: 'CHANGES_REQUESTED', submittedAt: iso(T + 20 * 60e3), author: { login: 'chalbert' } };
    expect(run({ comments: [resultComment(), accept()], reviews: [hold] }).out).toEqual([]);
  });
  it('defaultReadPr reads the formal reviews with the live PR', () => {
    const exec = (file, argv) => { expect(argv[argv.indexOf('--json') + 1]).toBe('number,state,labels,headRefOid,reviews'); return JSON.stringify({ reviews: [{ state: 'APPROVED' }] }); };
    expect(defaultReadPr({ repo: 'o/n', number: 1, exec, readComments: () => [] }).reviews).toEqual([{ state: 'APPROVED' }]);
  });
});

describe('sweep cache (skip PRs unchanged since the last completed sweep)', () => {
  const memCache = () => { const m = new Map(); return { get: k => m.get(k), set: (k, v) => { m.set(k, v); }, m }; };
  const calm = () => ({ scheduled: false, recorded: false, inFlight: false });
  const run = (cache, listed, reads, extra = {}) => rawSweep({
    repo: 'o/n', provider: provider(), cache, log: () => {}, readStatusEvidence: calm,
    listPrs: () => listed, readPr: ({ number }) => { reads.push(number); return listed.find(x => x.number === number); }, ...extra,
  });
  const redTeam = body => ({ body, createdAt: '2026-09-19T13:00:00Z', id: 'c2', author: { login: 'web-everything' } });

  it('skips the live re-read when head, labels and comments are identical to the last completed sweep', () => {
    const cache = memCache(); const reads = [];
    const listed = [pr(7, ['red-team:pending'], HEAD, [])];
    run(cache, listed, reads);
    expect(reads).toEqual([7]);
    run(cache, listed, reads);
    expect(reads).toEqual([7]);
  });

  it('re-checks when a new red-team comment lands on the same head', () => {
    const cache = memCache(); const reads = [];
    run(cache, [pr(7, ['red-team:pending'], HEAD, [])], reads);
    run(cache, [pr(7, ['red-team:pending'], HEAD, [redTeam('red-team result')])], reads);
    expect(reads).toEqual([7, 7]);
  });

  it('re-checks when the head moves or a label changes', () => {
    const cache = memCache(); const reads = [];
    run(cache, [pr(7, ['red-team:pending'], HEAD, [])], reads);
    run(cache, [pr(7, ['red-team:pending'], NEW_HEAD, [])], reads);
    run(cache, [pr(7, ['red-team:pending', 'review:human'], NEW_HEAD, [])], reads);
    expect(reads).toEqual([7, 7, 7]);
  });

  it('re-checks when the stored red-team evidence changes without any GitHub change', () => {
    const cache = memCache(); const reads = [];
    const listed = [pr(7, ['red-team:pending'], HEAD, [])];
    run(cache, listed, reads);
    run(cache, listed, reads, { readStatusEvidence: () => ({ ...calm(), recorded: true }) });
    expect(reads).toEqual([7, 7]);
  });

  it('never caches a PR whose sweep changed, errored, or whose comment list may be cut off', () => {
    const cache = memCache(); const reads = [];
    const moved = [pr(1, ['review:human', 'advisory:accepted'], NEW_HEAD)];
    run(cache, moved, reads); run(cache, moved, reads);
    expect(reads).toEqual([1, 1]);
    const many = [pr(2, ['red-team:pending'], HEAD, Array.from({ length: LIST_COMMENTS_CAP }, () => redTeam('x')))];
    run(cache, many, reads); run(cache, many, reads);
    expect(reads).toEqual([1, 1, 2, 2]);
  });

  it('does not touch a cache when none is injected', () => {
    const reads = [];
    const listed = [pr(7, ['red-team:pending'], HEAD, [])];
    run(undefined, listed, reads); run(undefined, listed, reads);
    expect(reads).toEqual([7, 7]);
  });
});
