// @vitest-environment node
/** operator-queue main: only the withdrawn-draft row of a still-collecting card batch is suppressed from NEEDS YOU. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';
import { NOTE_COMMENT_MARKER } from '../../conveyor/reconcile-note-comment.mjs';

vi.mock('node:child_process', async (original) => {
  const actual = await original();
  const execFileSync = vi.fn(() => '[]');
  return { ...actual, execFileSync, default: { ...actual.default, execFileSync } };
});
vi.mock('../../lib/gh-throttle.mjs', async (original) => ({ ...await original(), execFileSyncThrottled: (...args) => execFileSync(...args) }));
const { main } = await import('../operator-queue.mjs');

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'queue-batch-')); vi.stubEnv('WE_CARD_BATCH_STATE_DIR', dir); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const note = (kind, number) => ({
  createdAt: '2026-10-15T01:00:00Z', author: { login: AUTOMATION_LOGINS[0] },
  body: `${NOTE_COMMENT_MARKER}\n\nneeds your decision: ${kind}\n\nPR #${number}: ${kind}\n\n<!-- conveyor-note-key: ${kind}:${number} -->`,
});
const pr = (number, { kind = 'draft-withdrawn', isDraft = true } = {}) => ({ number, title: `batch ${number}`, headRefOid: 'a'.repeat(40),
  mergeable: 'MERGEABLE', isDraft, statusCheckRollup: [], labels: [{ name: 'review-status:draft-withdrawn' }], comments: [note(kind, number)] });
// An open, one-card filing batch inside its window — the #5790 shape.
const collecting = number => writeFileSync(join(dir, `o-n-${number}.json`), JSON.stringify({
  batchRef: `lane/card-batch-filing-${number}`, seq: 1, headSha: 'f'.repeat(40), openedAt: new Date().toISOString(),
  members: [{ cardId: 'c1', source: { repo: 'o/n', pr: '1' } }], pr: number, kind: 'filing', repo: 'o/n', holdApplied: true }));

function needsPersonNumbers(prs) {
  execFileSync.mockReturnValue(JSON.stringify(prs));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  main(['--repo=o/n', '--json'], {});
  return JSON.parse(log.mock.calls[0][0]).needsPerson.map(row => row.number);
}

it('suppresses only the draft-withdrawn row of a collecting batch; every other person-note still raises', () => {
  for (const n of [5790, 5792, 5793]) collecting(n);
  expect(needsPersonNumbers([
    pr(5790),                                            // collecting batch's withdrawn draft: expected hold, suppressed
    pr(5791),                                            // withdrawn draft with no batch state: raises
    pr(5792, { kind: 'round-cap-exhausted' }),           // a collecting batch's PR with a DIFFERENT person-note: raises
    pr(5793, { isDraft: false }),                        // draft-withdrawn note but the PR is no longer a draft: raises
  ])).toEqual([5791, 5792, 5793]);
});

it('does not let another repo\'s collecting batch with the same PR number suppress the row', () => {
  writeFileSync(join(dir, 'x-y-5794.json'), JSON.stringify({
    batchRef: 'lane/card-batch-filing-5794', seq: 1, headSha: 'f'.repeat(40), openedAt: new Date().toISOString(),
    members: [{ cardId: 'c1', source: { repo: 'x/y', pr: '1' } }], pr: 5794, kind: 'filing', repo: 'x/y', holdApplied: true }));
  expect(needsPersonNumbers([pr(5794)])).toEqual([5794]);
});

it('raises the withdrawn draft once its batch is no longer collecting (sealed or failed)', () => {
  writeFileSync(join(dir, 'o-n-5790.json'), JSON.stringify({
    batchRef: 'lane/card-batch-filing-5790', seq: 1, headSha: 'f'.repeat(40), openedAt: new Date().toISOString(),
    members: [{ cardId: 'c1', source: { repo: 'o/n', pr: '1' } }], pr: 5790, kind: 'filing', repo: 'o/n',
    sealFailure: { reason: 'verify red' } }));
  expect(needsPersonNumbers([pr(5790)])).toEqual([5790]);
});

it('keeps alerting when the batch state directory is unreadable', () => {
  vi.stubEnv('WE_CARD_BATCH_STATE_DIR', join(dir, 'missing'));
  expect(needsPersonNumbers([pr(5790)])).toEqual([5790]);
});
