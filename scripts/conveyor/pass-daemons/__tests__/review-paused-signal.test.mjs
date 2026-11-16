// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runMergeWatchSignals, pausedReviewSignal, readReviewRuns } from '../pr-merge-watch-signals.mjs';

const repo = 'example/widgets', head = 'a'.repeat(40), other = 'b'.repeat(40);
const now = Date.UTC(2026, 10, 15, 22, 13);
const iso = new Date(now - 3600_000).toISOString();
const config = { noProgressMinutes: 10 ** 9, noProgressDraftMinutes: 10 ** 9, ciJobOverdueFactor: 3 };
const parked = (id, h = head) => ({ id, repo, pr: 6889, head: h, verdict: 'prevention-outstanding', recorded: false, reason: 'prevention-outstanding: 1 guard owed' });
const readFor = sha => args => {
  const path = args[1];
  if (path.includes('/timeline?')) return [];
  if (path.includes('/check-runs?')) return { check_runs: [] };
  if (path.includes('/commits/')) return { sha, commit: { committer: { date: iso } } };
  throw Error('unexpected read');
};
const read = readFor(head);
function harness(runs, { labels = [], pr: prOverride = {}, receipt = {} } = {}) {
  const sent = [], pr = { number: 6889, headRefOid: head, isDraft: false, labels: labels.map(name => ({ name })), ...prOverride };
  const run = () => runMergeWatchSignals({ repo, pr, receipt, now, config, read: readFor(pr.headRefOid), send: async e => { sent.push(e); }, save: () => {},
    failure: vi.fn(), signalLogs: () => [''], reviewRuns: () => runs });
  return { sent, receipt, run, pr };
}
const paused = sent => sent.filter(e => e.kind === 'review-paused-no-verdict');

describe('review-paused-no-verdict event', () => {
  it('publishes one event for a paused review with no verdict on the head (live #6889 state)', async () => {
    const h = harness([parked('r1'), parked('r2'), parked('r3')]);
    await h.run();
    expect(paused(h.sent)).toHaveLength(1);
    expect(h.sent.find(e => e.kind === 'review-paused-no-verdict')).toMatchObject({ repo, pr: 6889,
      detail: { head, runs: 3, reason: 'prevention-outstanding: 1 guard owed' } });
  });
  it('does not repeat on a second pass for the same head', async () => {
    const h = harness([parked('r1'), parked('r2'), parked('r3')]);
    await h.run(); await h.run();
    expect(paused(h.sent)).toHaveLength(1);
  });
  it('fires again for a new head (a new head carries a fresh receipt)', async () => {
    const runs = [parked('r1'), parked('r2'), parked('r3'), parked('r4', other), parked('r5', other), parked('r6', other)];
    const first = harness(runs);
    await first.run();
    const next = harness(runs, { pr: { headRefOid: other } });
    await next.run();
    expect(paused(first.sent)).toHaveLength(1);
    expect(paused(next.sent)).toHaveLength(1);
    expect(paused(next.sent)[0].detail.head).toBe(other);
  });
  it('stays silent when a recorded verdict exists on the head', async () => {
    const h = harness([parked('r1'), parked('r2'), { id: 'r3', repo, pr: 6889, head, verdict: 'accept', recorded: true, reason: '' }]);
    await h.run();
    expect(paused(h.sent)).toHaveLength(0);
  });
  it('ignores runs on other heads and fewer than the run cap', async () => {
    const h = harness([parked('r1'), parked('r2'), parked('r3', other)]);
    await h.run();
    expect(paused(h.sent)).toHaveLength(0);
  });
  it('stays silent for a PR waiting on an operator (review:human) or already accepted', async () => {
    for (const label of ['review:human', 'review:accepted']) {
      const h = harness([parked('r1'), parked('r2'), parked('r3')], { labels: [label] });
      await h.run();
      expect(paused(h.sent)).toHaveLength(0);
    }
  });
  it('fails closed when the run records are unreadable: no event, failure counted', async () => {
    const sent = [], failure = vi.fn();
    await runMergeWatchSignals({ repo, pr: { number: 1, headRefOid: head, isDraft: false, labels: [] }, receipt: {}, now, config, read,
      send: async e => { sent.push(e); }, save: () => {}, failure, signalLogs: () => [''], reviewRuns: () => { throw Error('unreadable'); } });
    expect(paused(sent)).toHaveLength(0);
    expect(failure).toHaveBeenCalled();
  });
  it('uses a name the stall-event monitor filters do not match', () => {
    expect('review-paused-no-verdict').not.toMatch(/stalled-same-head|pr-no-progress/);
  });
  it('does not count a record step that was refused as a recorded verdict', () => {
    const runs = [parked('r1'), parked('r2'), { ...parked('r3'), verdict: 'accept', recorded: false }];
    expect(pausedReviewSignal(runs, { head, labels: [] })).toMatchObject({ runs: 3 });
  });
  it('reads run records from disk: applied record only; over the file cap fails closed', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'paused-runs-'));
    try {
      const rec = (n, applied) => writeFileSync(join(dir, `review-pr-${n}.json`), JSON.stringify({ id: `review-pr-${n}`, input: { repo, pr: 7 },
        findings: { read: { headRefOid: head }, ...(applied === undefined ? {} : { record: { applied, effects: applied ? [{ type: 'review.label-swap', status: 'applied' }] : [] } }) }, verdict: { verdict: 'accept' } }));
      rec('a', true); rec('b', false); rec('abstain', true);
      writeFileSync(join(dir, 'review-pr-abstain.json'), JSON.stringify({ id: 'review-pr-abstain', input: { repo, pr: 7 }, findings: { read: { headRefOid: head }, record: { applied: true, effects: [] } }, verdict: { verdict: 'accept' } }));
      const rows = readReviewRuns({ dir, now: Date.now() + 61_000 });
      expect(rows.find(r => r.id.endsWith('a')).recorded).toBe(true);
      expect(rows.find(r => r.id.endsWith('b')).recorded).toBe(false);
      expect(rows.find(r => r.id.endsWith('abstain')).recorded).toBe(false);
      for (let i = 0; i < 1001; i++) rec(`x${i}`, false);
      expect(() => readReviewRuns({ dir, now: Date.now() + 122_000 })).toThrow(/incomplete bounded evidence/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
