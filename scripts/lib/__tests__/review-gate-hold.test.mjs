import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { annotateReviewGateHold } from '../review-gate-hold.mjs';
import { readReviewCiGate } from '../review-ci-gate-io.mjs';
import { REVIEW_HOLD_LABELS } from '../review-escalation.mjs';

const repo = 'other/product', headSha = 'a'.repeat(40);
const marker = 'review-gate-review-hold: {"holds":["review-hold-labels"]}';
const cli = labels => spawnSync(process.execPath, ['scripts/check-review-gate.mjs', `--labels-json=${JSON.stringify(labels)}`],
  { encoding: 'utf8', timeout: 15_000 });
const step = { name: 'Check for an un-cleared review hold', status: 'completed', conclusion: 'failure' };
const row = { name: 'review-gate', id: 33, head_sha: headSha, status: 'completed', conclusion: 'failure',
  details_url: `https://github.com/${repo}/actions/runs/44/job/22` };
const job = { id: 22, run_id: 44, name: 'review-gate', head_sha: headSha, status: 'completed', conclusion: 'failure',
  check_run_url: `https://api.github.com/repos/${repo}/check-runs/33`, steps: [step] };
const reader = ({ metadata = job, log = `2026-11-15T20:00:00.000Z ${marker}\n` } = {}) => vi.fn((argv, options) => {
  expect(options).toMatchObject({ timeout: 15_000, maxBuffer: 1024 * 1024, throttle: { repo } });
  if (argv.join(' ') === `api repos/${repo}/actions/jobs/22`) return JSON.stringify(metadata);
  if (argv.join(' ') === `api repos/${repo}/actions/jobs/22/logs`) return log;
  throw Error(`unexpected IO: ${argv}`);
});
const annotate = (options = {}, rows = [row]) => annotateReviewGateHold(rows, { repo, headSha, runGh: reader(options) });
const scratch = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('review-gate hold producers and publication evidence', () => {
  it.each(REVIEW_HOLD_LABELS)('CLI emits explicit hold evidence only for hold label %s', label => {
    const held = cli([{ name: label }]);
    expect(held.status).toBe(1);
    expect(held.stderr.split('\n')).toContain(marker);
    expect(annotate({ log: held.stdout + held.stderr })[0].reviewGateReviewHold.holds).toEqual(['review-hold-labels']);
  });
  it('CLI clear and usage-error exits emit no hold evidence', () => {
    for (const labels of [[], ['review:accepted']]) {
      const clear = cli(labels);
      expect(clear.status).toBe(0);
      expect(clear.stdout + clear.stderr).not.toContain('review-gate-review-hold:');
    }
    const usage = spawnSync(process.execPath, ['scripts/check-review-gate.mjs', '--labels-json={'], { encoding: 'utf8', timeout: 15_000 });
    expect(usage.status).toBe(3);
    expect(usage.stdout + usage.stderr).not.toContain('review-gate-review-hold:');
  });
  it('workflow fast path emits the same evidence and keeps its failure exit', () => {
    const workflow = readFileSync('.github/workflows/review-gate.yml', 'utf8');
    const block = /id: fast[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      -)/.exec(workflow)?.[1];
    expect(block).toBeTruthy();
    const script = block.split('\n').map(line => line.replace(/^          /, '')).join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'review-gate-fast-')); scratch.push(dir);
    for (const labels of [[], ...REVIEW_HOLD_LABELS.map(name => [{ name }])]) {
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, GITHUB_OUTPUT: join(dir, 'output'), LABELS_JSON: JSON.stringify(labels) } });
      expect(result.status).toBe(labels.length ? 1 : 0);
      if (labels.length) {
        expect(result.stdout.split('\n')).toContain(marker);
        expect(annotate({ metadata: { ...job, steps: [{ ...step, name: 'Fast verdict for a non-review label event' }] },
          log: result.stdout + result.stderr })[0].reviewGateReviewHold.holds).toEqual(['review-hold-labels']);
      } else expect(result.stdout + result.stderr).not.toContain('review-gate-review-hold:');
    }
  });
  it('wires real CLI evidence through the fresh CI reader into the failed row annotation', () => {
    const result = cli(['review:pending']);
    const runGh = reader({ log: result.stdout + result.stderr });
    const gate = readReviewCiGate({ repo, pr: 7, policy: { startAfter: 'ci-green' },
      readHead: () => headSha, readRequired: () => ({ source: 'live', checks: ['review-gate'] }),
      readChecks: () => [row], annotateReviewGate: (rows, args) => annotateReviewGateHold(rows, { ...args, runGh }) });
    expect(gate).toMatchObject({ allowed: false, affected: [{ name: 'review-gate', reason: 'failure' }],
      checks: [{ reviewGateReviewHold: { holds: ['review-hold-labels'], jobId: 22 } }] });
    expect(runGh).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['absent', 'infrastructure failure'],
    ['empty', 'review-gate-review-hold: {"holds":[]}'],
    ['mixed', 'review-gate-review-hold: {"holds":["review-hold-labels","red-main-freeze"]}'],
    ['non-human', 'review-gate-review-hold: {"holds":["red-main-freeze"]}'],
    ['non-array', 'review-gate-review-hold: {"holds":"review-hold-labels"}'],
    ['malformed', 'review-gate-review-hold: {'],
    ['duplicate', `${marker}\n${marker}`],
    ['truncated', 'review-gate-review-hold: {"holds":["review-hold-labels"'],
    ['oversized marker', `review-gate-review-hold: ${JSON.stringify({ holds: Array(100).fill('review-hold-labels') })}`],
    ['oversized', 'x'.repeat(1024 * 1024) + `\n${marker}`],
  ])('keeps %s log evidence unannotated', (_kind, log) => {
    const rows = [row];
    expect(annotate({ log }, rows)).toBe(rows);
  });
  it.each([
    ['wrong head', { head_sha: 'b'.repeat(40) }],
    ['wrong job', { id: 99 }],
    ['wrong run', { run_id: 99 }],
    ['wrong check', { check_run_url: 'https://api.github.com/repos/other/product/check-runs/99' }],
    ['wrong name', { name: 'test' }],
    ['unfinished', { status: 'in_progress' }],
    ['cancelled', { conclusion: 'cancelled' }],
    ['missing steps', { steps: undefined }],
    ['empty steps', { steps: [] }],
    ['setup failure', { steps: [{ ...step, name: 'Set up job' }] }],
    ['cleanup failure', { steps: [step, { ...step, name: 'Post actions/checkout@v4' }] }],
    ['cleanup cancelled', { steps: [step, { ...step, name: 'Cleanup', conclusion: 'cancelled' }] }],
  ])('keeps %s job evidence unannotated', (_kind, patch) => {
    const rows = [row];
    expect(annotate({ metadata: { ...job, ...patch } }, rows)).toBe(rows);
  });
  it.each([
    { head_sha: 'b'.repeat(40) }, { conclusion: 'timed_out' }, { status: 'in_progress' },
    { details_url: undefined }, { details_url: 'https://github.com/wrong/repo/actions/runs/44/job/22' },
    { details_url: 'https://example.com/other/product/actions/runs/44/job/22' },
  ])('does not read logs for ineligible check $details_url', patch => {
    const rows = [{ ...row, ...patch }], runGh = reader();
    expect(annotateReviewGateHold(rows, { repo, headSha, runGh })).toBe(rows);
    expect(runGh).not.toHaveBeenCalled();
  });
  it('does not borrow older job proof when a newer failure supersedes it', () => {
    const rows = [row, { ...row, id: 34, details_url: undefined }], runGh = reader();
    expect(annotateReviewGateHold(rows, { repo, headSha, runGh })).toBe(rows);
    expect(runGh).not.toHaveBeenCalled();
  });
  it('keeps unreadable and oversized remote output held without any write or rerun', () => {
    const rows = [row];
    for (const error of ['offline', 'maxBuffer exceeded']) {
      const runGh = vi.fn(() => { throw Error(error); });
      expect(annotateReviewGateHold(rows, { repo, headSha, runGh })).toBe(rows);
      expect(runGh).toHaveBeenCalledTimes(1);
      expect(runGh.mock.calls[0][0]).toEqual(['api', `repos/${repo}/actions/jobs/22`]);
    }
  });
});
