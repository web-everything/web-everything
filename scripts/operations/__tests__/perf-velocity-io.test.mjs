/**
 * @file perf-velocity-io.test.mjs - the REAL mechanism of `perf-velocity-io.mjs` (#2949 fidelity qualifier): a real
 * git repo for the card history (including the JIT rename x<hash> -> NNN) and a real estimate file the estimator
 * appends to. The model call is the injected seam; its decisions are pinned in `perf-velocity.test.mjs`.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectVelocity, estimatesPath, heldItemText, loadEstimateRows, runEstimates, buildBrief, stripHtmlComments } from '../perf-velocity-io.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';

const cardText = (fm) => `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n# t\n`;
const WINDOW = { since: '2000-01-01T00:00:00Z', until: '2100-01-01T00:00:00Z' };

describe('collectVelocity against a real git history', () => {
  it('counts a card once through its x<hash> -> NNN rename, and splits code from card-only merges', async () => {
    await withRealRepo(async (ctx) => {
      ctx.commit({ 'backlog/xabc123-feat.md': cardText({ kind: 'story', size: 5, status: 'resolved' }), 'scripts/a.mjs': '1\n' }, 'Merge pull request #7 from x/lane/a');
      ctx.git(['mv', 'backlog/xabc123-feat.md', 'backlog/7001-feat.md']);
      ctx.commit({ 'backlog/7001-feat.md': cardText({ bornAs: 'xabc123', kind: 'story', size: 5, status: 'resolved' }) }, 'drain: JIT-number xabc123');
      ctx.commit({ 'backlog/7002-only.md': cardText({ kind: 'story', size: 3, status: 'open' }) }, 'Merge pull request #8 from x/lane/b');
      ctx.commit({ 'scripts/b.mjs': '2\n' }, 'Merge pull request #9 from x/lane/c');
      const c = collectVelocity({ root: ctx.root, window: WINDOW, now: new Date().toISOString(), storePath: join(ctx.root, 'snapshots.jsonl'), ref: 'HEAD', since: '2000-01-01' });
      expect(c.events).toHaveLength(1);
      expect(c.events[0]).toMatchObject({ id: 'xabc123', size: 5 });
      expect(c.merges.map((m) => [m.pr, m.kind, m.covered])).toEqual([[9, 'code', false], [8, 'card-only', true], [7, 'code', true]]);
      expect(c.metrics['velocity.prs.code.merged'].v).toBe(2);
      expect(c.metrics['velocity.prs.cardOnly.merged'].v).toBe(1);
      expect(c.metrics['velocity.estimate.missingPrs'].v).toBe(1);
    });
  });
});

describe('runEstimates: calibrate, estimate once, store beside the snapshots', () => {
  it('writes estimate and calibration rows once, labelled, and a re-run spends nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-est-'));
    const storePath = join(dir, 'snapshots.jsonl');
    const merges = [
      { pr: 1, kind: 'code', covered: true, hash: 'h1', at: '2026-10-06T10:00:00Z' },
      { pr: 2, kind: 'code', covered: false, hash: 'h2', at: '2026-10-06T11:00:00Z' },
      { pr: 3, kind: 'card-only', covered: false, hash: 'h3', at: '2026-10-06T12:00:00Z' },
    ];
    const collected = { events: [{ id: 'a', hash: 'dr1', size: 3 }], merges: merges.map((m) => (m.pr === 1 ? { ...m, cardIds: ['a'] } : m)) };
    let calls = 0;
    const spawn = async ({ input }) => { calls++; return { value: { size: /BIG/.test(input) ? 8 : 5, reason: 'r' }, costUsd: 0.01 }; };
    const gh = (args) => ({ title: `t${args[1].split('/').at(-1)}`, body: args[1].endsWith('/2') ? 'BIG change' : 'small' });
    const first = await runEstimates({ collected, storePath, gh, spawn, now: () => '2026-10-07T00:00:00Z' });
    expect(first).toMatchObject({ newCalibration: 1, newEstimates: 1, failures: 0, costUsd: 0.02, calibration: { n: 1, mae: 2, bias: 2 } });
    const rows = readFileSync(estimatesPath(storePath), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.find((r) => r.kind === 'estimate')).toMatchObject({ pr: 2, size: 8, source: 'estimated-from-brief' });
    expect(rows.find((r) => r.kind === 'calibration')).toMatchObject({ pr: 1, actual: 3, estimate: 5 });
    const second = await runEstimates({ collected, storePath, gh, spawn });
    expect(second).toMatchObject({ newCalibration: 0, newEstimates: 0, costUsd: 0 });
    expect(calls).toBe(2);
  });

  it('leaves a PR unestimated when the model fails or gh cannot read it, and honours the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-est-'));
    const storePath = join(dir, 'snapshots.jsonl');
    const merges = [2, 3, 4].map((pr) => ({ pr, kind: 'code', covered: false, hash: `h${pr}`, at: '2026-10-06T11:00:00Z' }));
    const spawn = async ({ input }) => { if (/FAIL/.test(input)) throw new Error('budget'); return { value: { size: 2, reason: '' }, costUsd: 0 }; };
    const gh = (args) => (args[1].endsWith('/4') ? null : { title: 't', body: args[1].endsWith('/2') ? 'FAIL' : 'ok' });
    const r = await runEstimates({ collected: { events: [], merges }, storePath, gh, spawn, cap: 3, concurrency: 1 });
    expect(r).toMatchObject({ newEstimates: 1, failures: 2 });
    expect([...loadEstimateRows(estimatesPath(storePath)).estimates.keys()]).toEqual([3]);
    const capped = await runEstimates({ collected: { events: [], merges: [{ pr: 9, kind: 'code', covered: false, hash: 'x' }, { pr: 10, kind: 'code', covered: false, hash: 'y' }] }, storePath, gh: () => ({ title: 't', body: 'b' }), spawn, cap: 1 });
    expect(capped).toMatchObject({ newEstimates: 1, remaining: 1 });
  });

  it('adds the held-item line to the brief only when the PR names that item', () => {
    const held = '129. Velocity in perf-snapshot\n129 ADD (operator): backfill\n130. Other';
    expect(heldItemText('Build held item 129', '', held)).toBe('129. Velocity in perf-snapshot\n129 ADD (operator): backfill');
    expect(heldItemText('Fix a thing', 'card 5319', held)).toBe('');
    expect(buildBrief({ title: 'T', body: 'a<!-- hidden -->b', heldText: 'H' })).toBe('TITLE: T\n\nBODY:\nab\n\nHELD ITEM TEXT:\nH');
  });

  it('never leaves a comment opener behind, even when stripping splices one together or one is unterminated', () => {
    expect(stripHtmlComments('<!<!-- x -->--y')).toBe('');
    expect(stripHtmlComments('a<!-- b')).toBe('a');
    expect(stripHtmlComments('a<!-- b --><!-- c -->d')).toBe('ad');
    for (const body of ['<!<!-- x -->-- z', '<<!-- x -->!-- z', 'p<!--', '<!-- a <!-- b --> -->']) {
      expect(stripHtmlComments(body)).not.toContain('<!--');
      expect(buildBrief({ title: 'T', body })).not.toContain('<!--');
    }
  });
});
