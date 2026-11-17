import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:child_process', async (original) => ({ ...await original(), execFileSync: vi.fn() }));
vi.mock('../../lib/gh-throttle.mjs', async (original) => ({
  ...await original(), execFileSyncThrottled: (...args) => execFileSync(...args),
}));
import { execFileSync } from 'node:child_process';
import { evaluateCeremonyOwed, main } from '../operator-queue.mjs';
import { formatPrResult } from '../../lib/merge-gate-verdict.mjs';
import { GATE_IDS } from '../../lib/merge-gate-inventory.mjs';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { redTeamGateMarker, redTeamQueueReason } from '../../lib/red-team-gate.mjs';

const HEAD = 'aa96f0c47' + 'a'.repeat(31);
const REPO = 'web-everything/web-everything';
const HOLD = `human-only: the diff at ${HEAD.slice(0, 9)} touches .github/workflows/ci.yml — only a clear-human ceremony at this exact head can accept it`;
const check = { name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE',
  detailsUrl: `https://github.com/${REPO}/actions/runs/123/job/456` };
const pr = () => ({ number: 5193, title: 'Update CI', headRefOid: HEAD, mergeable: 'MERGEABLE', isDraft: false,
  labels: ['ready-to-merge', 'review:accepted'].map((name) => ({ name })), comments: [],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, check,
    { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' }],
});
const verdict = () => ({ headSha: HEAD, results: GATE_IDS.map((id) => ({ id,
  status: id === 'review-acceptance' ? 'hold' : 'pass', reason: id === 'review-acceptance' ? HOLD : 'ok',
})) });
const evaluate = (subject = pr(), evidence = verdict()) => evaluateCeremonyOwed(subject, { mergeGateVerdict: evidence });

beforeEach(() => { execFileSync.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('clear-human ceremony owed at the live head', () => {
  it('requests evidence only once all other conditions pass', () => {
    expect(evaluateCeremonyOwed(pr())).toMatchObject({ owed: false, needsMergeGateVerdict: true, mergeGateCheck: check });
  });
  it('surfaces #5193 with its live human-only hold and stale acceptance', () => {
    const result = evaluate();
    expect(result).toMatchObject({ owed: true, reasons: [], holds: ['review-acceptance'] });
    for (const text of ['review-acceptance', 'human-only', HEAD.slice(0, 9), 'review:accepted is stale (from an older head)']) {
      expect(result.reason).toContain(text);
    }
    expect(evaluate({ ...pr(), labels: [] }).reason).not.toContain('is stale');
    expect(evaluate(pr(), { ...verdict(), headSha: HEAD.toUpperCase() }).owed).toBe(true);
  });
  it.each(['other head', 'unreadable', 'missing results', 'extra hold', 'no human-only text'])('fails closed: %s', (kind) => {
    const evidence = verdict();
    if (kind === 'other head') evidence.headSha = 'b'.repeat(40);
    if (kind === 'unreadable') evidence.error = 'missing log';
    if (kind === 'missing results') delete evidence.results;
    if (kind === 'extra hold') evidence.results.find((row) => row.id === 'required-check-green').status = 'hold';
    if (kind === 'no human-only text') evidence.results.find((row) => row.id === 'review-acceptance').reason = 'human review required';
    expect(evaluate(pr(), evidence).owed).toBe(false);
  });
  it.each(['pending', 'second failure', 'duplicate merge-gate', 'green merge-gate', 'CONFLICTING', 'UNKNOWN', 'draft',
    'review:human', 'review:changes', 'review:pending', 'status:sent-back-red-team', 'ci:failed', 'merge-status:conflicting'])
  ('does not request evidence or list a PR blocked by %s', (kind) => {
    const subject = pr();
    if (kind === 'pending') subject.statusCheckRollup[0].status = 'IN_PROGRESS';
    else if (kind === 'second failure') subject.statusCheckRollup[0].conclusion = 'FAILURE';
    else if (kind === 'duplicate merge-gate') subject.statusCheckRollup.push({ ...check });
    else if (kind === 'green merge-gate') subject.statusCheckRollup[1] = { ...check, conclusion: 'SUCCESS' };
    else if (['CONFLICTING', 'UNKNOWN'].includes(kind)) subject.mergeable = kind;
    else if (kind === 'draft') subject.isDraft = true;
    else subject.labels.push({ name: kind });
    expect(evaluate(subject).owed).toBe(false);
    expect(evaluateCeremonyOwed(subject).needsMergeGateVerdict).not.toBe(true);
  });
  it('excludes a confirmed red-team break sent back on the live head', () => {
    const subject = pr();
    subject.labels.push({ name: 'review:changes' });
    subject.comments = [{ author: { login: 'web-everything' }, createdAt: '2026-10-10T02:04:41Z',
      body: renderRedTeamComment({ pr: 5193, rev: HEAD, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
        findings: [{ summary: 'two writers', category: 'edge-case', impactIfUnfixed: 'broken', file: 'a.mjs', line: 1, confirmedByRecheck: true }] }) },
    { author: { login: 'web-everything' }, body: redTeamGateMarker(5193, HEAD, 'sent-back') }];
    expect(redTeamQueueReason(subject)).toMatch(/^red team:/);
    expect(evaluate(subject).owed).toBe(false);
    expect(evaluateCeremonyOwed(subject).needsMergeGateVerdict).not.toBe(true);
  });
});

const run = (args = [], evidence = verdict(), subject = pr()) => {
  execFileSync.mockReturnValueOnce(JSON.stringify([subject]))
    .mockReturnValueOnce(JSON.stringify({ head_sha: evidence.headSha }))
    .mockReturnValueOnce(evidence.error ? 'unreadable log' : formatPrResult({ num: 5193, ok: false, results: evidence.results }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  main([`--repo=${REPO}`, ...args], { unsupportedPath: '/nonexistent-operator-queue-test/unsupported-repo.json' });
  return log.mock.calls.map(([line]) => line).join('\n');
};

describe('operator queue ceremony output', () => {
  it('prints the owed reason and read-only ceremony suggestion under NEEDS YOU', () => {
    const output = run();
    expect(output).toContain('NEEDS YOU (review:human + advisory:accepted, all gates pass; or a clear-human owed at the live head):');
    expect(output).toContain(`${REPO}#5193  Update CI — ${evaluate().reason}\n    clear-human: node scripts/review-set-label.mjs 5193 --repo=${REPO} --to=clear-human --actor=<your login> --reason='<your words>'`);
    expect(execFileSync.mock.calls.map(([cmd, args]) => [cmd, args.slice(0, 2)])).toEqual([
      ['gh', ['pr', 'list']], ['gh', ['api', `repos/${REPO}/actions/jobs/456`]], ['gh', ['api', `repos/${REPO}/actions/jobs/456/logs`]],
    ]);
  });
  it('adds the ceremony fields to JSON ready without adding a NOT READY row', () => {
    const report = JSON.parse(run(['--json']));
    expect(report.ready).toEqual([{ repo: REPO, number: 5193, title: 'Update CI', ceremonyOwed: true,
      reason: evaluate().reason, humanHolds: ['review-acceptance'] }]);
    expect(report.notReady).toEqual([]);
  });
  it.each(['unreadable', 'other head'])('does not list %s evidence in either section', (kind) => {
    const evidence = kind === 'unreadable' ? { ...verdict(), error: 'no log' } : { ...verdict(), headSha: 'b'.repeat(40) };
    const report = JSON.parse(run(['--json'], evidence));
    expect(report.ready).toEqual([]);
    expect(report.notReady).toEqual([]);
  });
});
