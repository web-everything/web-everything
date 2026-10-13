// @vitest-environment node
import { it, expect } from 'vitest';
import { evaluatePrGates, formatPrResult } from '../lib/merge-gate-ci.mjs';
import { deferCandidacyHoldsOnPrEvent, parsePrResultTable } from '../lib/merge-gate-hold-class.mjs';
const HEAD = 'a'.repeat(40);
const base = () => ({
  repo: 'o/r', num: 7, defaultBranch: 'main',
  pr: { number: 7, title: 't', body: 'A real body', baseRefName: 'main', headRefName: 'lane/x', headRefOid: HEAD, isCrossRepository: false,
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
  ledger: { authority: 'labels', folded: null, derived: null },
  pinnedHead: { sha: HEAD },
  gatePaths: { files: ['docs/a.md'] },
});


it('prints a parseable PASS for #5011 candidacy alone, with merge-group and off unchanged', () => {
  const facts = base();
  facts.num = facts.pr.number = 5011;
  facts.pr.labels = [{ name: 'review:pending' }];
  facts.pr.commits = [{ oid: HEAD, messageHeadline: 'x', messageBody: '' }];
  facts.duplicateIds.group = [];
  for (const [mergeEvent, setting, ok] of [['pull_request', 'on', true], ['pull_request', 'off', false], ['merge_group', 'on', false]]) {
    const original = evaluatePrGates(facts, { mergeEvent });
    expect(original.blocking.map(r => r.id).sort()).toEqual(['candidate-label', 'producer-certified', 'review-hold-labels', 'review-acceptance', 'ledger'].sort());
    const out = deferCandidacyHoldsOnPrEvent(original, { mergeEvent, setting });
    expect(out.ok).toBe(ok);
    const printed = formatPrResult(out);
    expect(printed).toContain(`#5011: ${ok ? 'PASS' : 'HOLD'}`);
    // The parser requires the job's known table-only HOLD footer (formatPrResult prints only the table).
    const log = ok ? printed : `${printed}\nmerge-gate: HOLD — held`;
    expect(parsePrResultTable(log, 5011)).toMatchObject({ ok, results: out.results });
  }
});
it('preserves the real workflow-edit human-only hold on a PR event', () => {
  const facts = base();
  facts.gatePaths.files = ['.github/workflows/ci.yml'];
  const original = evaluatePrGates(facts, { mergeEvent: 'pull_request' });
  expect(original.results).toContainEqual(expect.objectContaining({ id: 'review-acceptance', status: 'hold', reason: expect.stringMatching(/^human-only:/) }));
  const out = deferCandidacyHoldsOnPrEvent(original, { mergeEvent: 'pull_request', setting: 'on' });
  expect(out.ok).toBe(false);
  expect(out.blocking).toContainEqual(expect.objectContaining({ id: 'review-acceptance', reason: expect.stringMatching(/^human-only:/) }));
});
