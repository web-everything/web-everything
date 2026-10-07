/**
 * @file perf-snapshot-real.test.mjs — the REAL mechanism of `perf-snapshot-io.mjs` (#2949 fidelity qualifier): a real
 * git repo for the HEAD read, a real tick log on disk for starvation, and a real store file the sink appends to.
 * The decisions (diff, metrics) are pinned in `perf-snapshot.test.mjs`; this file pins the shell-outs and the files.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { builderStarvation, parseStore } from '../perf-snapshot.mjs';
import { createPerfSnapshotReader, fetchMergedSince, headSha, readTicks } from '../perf-snapshot-io.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';

describe('perf-snapshot-io against the real filesystem and git', () => {
  it('reads the short HEAD of a real checkout, and null outside one', async () => {
    await withRealRepo(async (ctx) => {
      const sha = headSha(ctx.root);
      expect(sha).toMatch(/^[0-9a-f]{7,}$/);
      expect(ctx.head().startsWith(sha)).toBe(true);
    });
    expect(headSha(mkdtempSync(join(tmpdir(), 'perf-nogit-')))).toBeNull();
  });

  it('reads tick rows from a real build-dispatch log (and its rotated half) and counts starvation', () => {
    const home = mkdtempSync(join(tmpdir(), 'perf-ticks-'));
    const coord = join(home, 'coord');
    mkdirSync(coord, { recursive: true });
    const row = (at, extra) => `2026-10-07T00:00:00.000Z tick ${JSON.stringify({ at, dispatched: [], inFlight: [], capacity: { free: true }, ...extra })}`;
    writeFileSync(join(coord, 'build-dispatch-daemon.log.1'), `${row('2026-10-07T10:00:00.000Z')}\n`);
    writeFileSync(join(coord, 'build-dispatch-daemon.log'), `not a tick\n${row('2026-10-07T10:05:00.000Z', { inFlight: [{ num: 1 }] })}\n${row('2026-10-07T10:10:00.000Z')}\n`);
    const ticks = readTicks({ env: { WE_CORONER_COORD: coord }, home });
    expect(ticks.map((t) => t.at)).toEqual(['2026-10-07T10:00:00.000Z', '2026-10-07T10:05:00.000Z', '2026-10-07T10:10:00.000Z']);
    const out = builderStarvation(ticks, { since: '2026-10-07T10:00:00.000Z', until: '2026-10-07T10:15:00.000Z' });
    expect(out['builder.starvedMin'].v).toBe(10);
    expect(out['builder.starvedTicks'].v).toBe(2);
  });

  it('the reader loads a real store file, skipping a bad line, and finds the archive next to it', () => {
    const home = mkdtempSync(join(tmpdir(), 'perf-store-'));
    const dir = join(home, 'perf');
    mkdirSync(join(dir, '2026-10-07'), { recursive: true });
    writeFileSync(join(dir, '2026-10-07', 'coroner-24h.json'), '{}');
    const store = join(dir, 'snapshots.jsonl');
    writeFileSync(store, `${JSON.stringify({ schema: 1, kind: 'baseline', date: '2026-10-07', metrics: {} })}\nbroken\n`);
    const read = createPerfSnapshotReader({ env: {}, home, now: () => '2026-10-08T00:00:00.000Z' })({ store });
    expect(parseStore(readFileSync(store, 'utf8'))).toHaveLength(1);
    expect(read).toMatchObject({ store, dir, hasBaseline: true, archiveFound: true, now: '2026-10-08T00:00:00.000Z' });
  });

  it('merged-PR tags page the REST list and keep only PRs merged after the cut', () => {
    const calls = [];
    const gh = (args) => { calls.push(args[1]); return [{ number: 3, title: 'new', merged_at: '2026-10-08T01:00:00Z', updated_at: '2026-10-08T01:00:00Z' }, { number: 2, title: 'closed unmerged', merged_at: null, updated_at: '2026-10-08T00:30:00Z' }, { number: 1, title: 'old', merged_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' }]; };
    expect(fetchMergedSince('2026-10-07T14:00:00.000Z', gh)).toEqual([{ number: 3, title: 'new', mergedAt: '2026-10-08T01:00:00Z' }]);
    expect(calls).toHaveLength(1);
    expect(fetchMergedSince('2026-10-07T14:00:00.000Z', () => null)).toBeNull();
    expect(fetchMergedSince('2026-10-07T14:00:00.000Z', null)).toBeNull();
  });
});
