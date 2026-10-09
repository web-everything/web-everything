// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { evaluatePrGates, evaluateGroup, groupPrNumbers, asQueuedPr } from '../merge-gate-ci.mjs';
import { DRAIN_GATES } from '../merge-gate-inventory.mjs';
import { MANIFEST_BODY_BEGIN, MANIFEST_BODY_END, extractManifestFromBody } from '../../readiness/lane-manifest.mjs';

const HEAD = 'a'.repeat(40);
const base = () => ({
  repo: 'o/r', num: 7, defaultBranch: 'main',
  pr: { number: 7, title: 't', body: 'A real body', baseRefName: 'main', headRefName: 'lane/x', headRefOid: HEAD,
    labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }],
    commits: [{ oid: HEAD, messageHeadline: 'x', messageBody: 'Co-Authored-By: Claude <noreply@anthropic.com>' }],
    statusCheckRollup: [] },
  manifest: { live: null },
  netSignals: { scored: true, changedFiles: ['docs/a.md'], diffLines: 2, humanBasisFiles: ['docs/a.md'], cumulativeDiffLines: 2, basisNarrowed: true, netDiffText: { text: '', scored: true }, diffHunks: '' },
  acceptance: { headSha: HEAD, acceptedSha: HEAD, acceptedDiff: null, acceptedContribution: null, operatorClearance: null, humanClearedSha: null, headDiff: null, headContribution: null, headReadFailed: false },
  bodyHistory: { bodies: ['A real body'], complete: true },
  duplicateIds: { main: [] },
  redMain: { source: 'ops/red-main', frozen: false },
  enqueueClearance: null,
});

// Merge one level of fact fields; each call starts with fresh objects and arrays.
function facts(over = {}) {
  const result = base();
  for (const [key, value] of Object.entries(over)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...result[key], ...value } : value;
  }
  return result;
}
function check(input, id, status, ok = false, options) {
  const result = evaluatePrGates(input, options);
  expect(result.results.find((gate) => gate.id === id), JSON.stringify(result.blocking)).toMatchObject({ id, status });
  expect(result.ok, JSON.stringify(result.blocking)).toBe(ok);
  return result;
}
const labels = (...names) => names.map((name) => ({ name }));
const codeql = [{ name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-01-01T00:00:00Z' }];
const manifestBody = `${MANIFEST_BODY_BEGIN}\n${JSON.stringify({ item: '123', blockedBy: ['9'], dismissedFindings: 2 })}\n${MANIFEST_BODY_END}`;

describe('evaluatePrGates', () => {
  it('passes the accepted baseline', () => {
    const result = evaluatePrGates(base());
    expect(result.ok, JSON.stringify(result.blocking)).toBe(true);
    for (const gate of DRAIN_GATES.filter((gate) => gate.where === 'merge-gate')) {
      expect(result.results.find((row) => row.id === gate.id)).toMatchObject({ status: 'pass' });
    }
  });

  it.each([
    ['missing shared red-main source', { redMain: { source: null } }, 'red-main-freeze', 'fail-closed'],
    ['frozen main', { redMain: { frozen: true } }, 'red-main-freeze', 'hold'],
    ['missing candidate label', { pr: { labels: labels('review:accepted') } }, 'candidate-label', 'hold'],
    ['pending review label', { pr: { labels: labels('ready-to-merge', 'review:pending') } }, 'review-hold-labels', 'hold'],
    ['pending acceptance', { pr: { labels: labels('ready-to-merge', 'review:pending') } }, 'review-acceptance', 'hold'],
    ['human review label', { pr: { labels: labels('ready-to-merge', 'review:human') } }, 'review-hold-labels', 'hold'],
    ['unreadable acceptance', { acceptance: { error: 'boom' } }, 'review-acceptance', 'fail-closed'],
    ['stale acceptance', { acceptance: { acceptedSha: 'b'.repeat(40) } }, 'review-acceptance', 'hold'],
    ['blank body', { pr: { body: '   ' } }, 'non-empty-body', 'hold'],
    ['non-default base', { pr: { baseRefName: 'lane/y' } }, 'default-base', 'hold'],
    ['unknown default branch', { defaultBranch: null }, 'default-base', 'fail-closed'],
    ['failed CodeQL', { pr: { statusCheckRollup: codeql } }, 'codeql', 'hold'],
    ['deleted test', { netSignals: { netDiffText: { text: "diff --git a/x.test.mjs b/x.test.mjs\ndeleted file mode 100644\n--- a/x.test.mjs\n+++ /dev/null\n@@ -1 +0,0 @@\n-it('a', () => {})\n", scored: true } } }, 'test-gaming', 'hold'],
    ['unscored diff without fallback files', { netSignals: { scored: false } }, 'test-gaming', 'fail-closed'],
    ['removed historical manifest', { bodyHistory: { bodies: ['A real body', manifestBody] } }, 'manifest-baseline', 'hold'],
    ['incomplete body history', { bodyHistory: { complete: false } }, 'manifest-baseline', 'fail-closed'],
    ['tree manifest', { manifest: { fromTree: true } }, 'manifest-baseline', 'fail-closed'],
    ['duplicate on main', { duplicateIds: { main: [{ id: '12' }] } }, 'duplicate-id-on-main', 'hold'],
    ['unreadable duplicates', { duplicateIds: { error: 'x' } }, 'duplicate-id-on-main', 'fail-closed'],
    ['duplicate in group', { duplicateIds: { main: [], group: [{ id: '5' }] } }, 'duplicate-id-on-main', 'hold'],
  ])('%s', (_name, over, id, status) => {
    check(facts(over), id, status);
  });

  it('allows failed CodeQL when explicitly disabled', () => {
    check(facts({ pr: { statusCheckRollup: codeql } }), 'codeql', 'pass', true, { blockOnCodeQL: false });
  });

  it('requires head-covering enqueue clearance for both manifest ordering gates', () => {
    const live = extractManifestFromBody(manifestBody);
    expect(live).toMatchObject({ item: 123, blockedBy: [9], dismissedFindings: 2 });
    const over = { pr: { body: manifestBody }, manifest: { live } };
    for (const id of ['blocked-by', 'couple-whole']) {
      check(facts(over), id, 'fail-closed');
      check(facts({ ...over, enqueueClearance: { coversHead: true } }), id, 'pass', true);
    }
  });

  it('fails every merge gate closed on a PR read error', () => {
    const result = evaluatePrGates(facts({ prReadError: 'unreadable' }));
    expect(result.ok).toBe(false);
    for (const gate of DRAIN_GATES.filter((gate) => gate.where === 'merge-gate')) {
      expect(result.results.find((row) => row.id === gate.id)).toMatchObject({ status: 'fail-closed' });
    }
  });

  it('reports queue and enqueue ownership without blocking', () => {
    const result = evaluatePrGates(facts());
    expect(result.ok).toBe(true);
    expect(result.blocking).toEqual([]);
    for (const gate of DRAIN_GATES.filter((gate) => gate.where !== 'merge-gate')) {
      expect(result.results.find((row) => row.id === gate.id)).toMatchObject({ status: gate.where });
    }
    expect(result.results).toContainEqual(expect.objectContaining({ id: 'freshness', status: 'queue' }));
    expect(result.results).toContainEqual(expect.objectContaining({ id: 'overlap-yield', status: 'enqueue' }));
  });

  it('skips CodeQL in CI when drain-direct policy keeps it in the drain', () => {
    check(facts({ pr: { statusCheckRollup: codeql } }), 'codeql', 'skipped-by-policy', true, {
      policy: { strategy: 'drain-direct', gatePlacement: { codeql: 'drain' } },
    });
  });
});

describe('merge group helpers', () => {
  it('rejects an empty group and identifies a failing PR', () => {
    expect(evaluateGroup([]).ok).toBe(false);
    expect(evaluateGroup([{ num: 1, ok: true }, { num: 2, ok: false }])).toMatchObject({ ok: false, reason: expect.stringContaining('#2') });
  });

  it('unions ref, subjects and entries up to the group head', () => {
    expect(groupPrNumbers({
      headRef: 'refs/heads/gh-readonly-queue/main/pr-42-abc123', headSha: 'h',
      entries: [
        { position: 1, headCommit: { oid: 'x' }, pullRequest: { number: 40 } },
        { position: 2, headCommit: { oid: 'h' }, pullRequest: { number: 42 } },
        { position: 3, headCommit: { oid: 'z' }, pullRequest: { number: 43 } },
      ], commitSubjects: ['Merge pull request #41 from a/b'],
    })).toEqual([40, 41, 42]);
  });

  it('replaces existing test rows and preserves other checks', () => {
    const other = { name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE' };
    const pr = { mergeable: 'UNKNOWN', mergeStateStatus: 'BEHIND', statusCheckRollup: [
      { name: 'test', conclusion: 'FAILURE' }, { context: 'test', state: 'PENDING' }, other,
    ] };
    const result = asQueuedPr(pr);
    expect(result).toMatchObject({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
    expect(result.statusCheckRollup).toEqual([other, expect.objectContaining({ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' })]);
    expect(pr.statusCheckRollup).toHaveLength(3);
  });
});
