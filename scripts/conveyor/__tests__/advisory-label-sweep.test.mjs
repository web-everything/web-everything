/** @file The `advisory:*` staleness sweep — labels come off a PR whose head moved, and only those. No `gh`. */
import { describe, expect, it } from 'vitest';

import { carriesAdvisoryLabel, sweepAdvisoryLabels } from '../advisory-label-sweep.mjs';

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
});
