/**
 * @file fixer-verify-never-settles.test.mjs — the backstop for a verify that can never settle (live 2026-10-04:
 * a pool-root file failed every verify-daemon tick; PR #3890's fixer looped 9 `check --wait` timeouts). The smell
 * on fixtures, plus `probeLaneVerifyMarkers` over a fixture pool that holds the exact `.metadata_never_index` file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import smell from '../fixer-verify-never-settles.mjs';
import { probeLaneVerifyMarkers } from '../../health-watch.mjs';

const NOW = Date.parse('2026-10-04T15:30:00.000Z');
const SHA = '0d1f5972d59ecdfbfcd76f06245a215337fde9b5';
const row = (o) => ({ pool: 'web-everything', lane: 2, sha: SHA, head: SHA, startedAt: '2026-10-04T14:02:52.772Z', runId: null, suites: 'x', ...o });
const evaluate = (rows) => smell.evaluate({ laneVerifyMarkers: rows }, { now: NOW });

describe('fixer-verify-never-settles', () => {
  it('breaches on the live #3890 shape: running for HEAD, never dispatched (no runId), 87 min old', () => {
    const [d] = evaluate([row()]);
    expect(d).toMatchObject({ subject: 'lane:web-everything/lane-2', breach: true });
    expect(d.measure).toMatchObject({ dispatched: false, ageMin: 87, limitMin: 20 });
    expect(d.summary).toMatch(/never dispatched/);
  });

  it('does not breach a fresh request, a marker for an old sha, or a dispatched run inside its ceilings', () => {
    const fresh = row({ startedAt: '2026-10-04T15:20:00.000Z' });
    const oldSha = row({ head: 'f'.repeat(40) });
    const dispatched = row({ runId: 'r-1' });
    const out = evaluate([fresh, oldSha, dispatched]);
    expect(out.filter((d) => d.breach)).toEqual([]);
    expect(out).toHaveLength(2); // the old-sha marker is not even a subject
  });

  it('breaches a dispatched run that outlived every dispatcher ceiling', () => {
    const [d] = evaluate([row({ runId: 'r-1', startedAt: '2026-10-04T12:00:00.000Z' })]);
    expect(d).toMatchObject({ breach: true });
    expect(d.measure.dispatched).toBe(true);
  });

  it('a malformed row (no startedAt / no head) is skipped, never a crash', () => {
    expect(evaluate([row({ startedAt: null }), row({ head: null })])).toEqual([]);
  });
});

describe('probeLaneVerifyMarkers', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lane-verify-markers-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('reads only running markers, survives a plain file at the pool root, and carries runId + HEAD', () => {
    writeFileSync(join(root, '.metadata_never_index'), '');
    const mk = (lane, marker) => {
      const g = join(root, 'web-everything', `lane-${lane}`, '.git');
      mkdirSync(g, { recursive: true });
      if (marker) writeFileSync(join(g, '.lane-verify'), JSON.stringify(marker));
    };
    mk(2, { sha: SHA, status: 'running', startedAt: '2026-10-04T14:02:52.772Z' });
    mk(3, { sha: SHA, status: 'green', startedAt: 'x' });
    mk(4, null);
    mk(5, { sha: SHA, status: 'running', startedAt: 'y', runId: 'r-9' });
    const rows = probeLaneVerifyMarkers({ poolRoot: root, readHead: () => SHA });
    expect(rows).toEqual([
      { pool: 'web-everything', lane: 2, sha: SHA, head: SHA, startedAt: '2026-10-04T14:02:52.772Z', runId: null, suites: null },
      { pool: 'web-everything', lane: 5, sha: SHA, head: SHA, startedAt: 'y', runId: 'r-9', suites: null },
    ]);
  });
});
