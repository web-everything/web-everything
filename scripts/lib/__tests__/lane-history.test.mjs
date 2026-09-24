/**
 * @file scripts/lib/__tests__/lane-history.test.mjs
 * @description Proof of #3383's lane-history ledger: `appendLaneHistory` writes ONE JSON line per event into
 * `<lane>/.git/lane-history.jsonl` (never tracked — inside `.git/`), `readLaneHistory` reads it back tolerant
 * of a corrupt trailing line, and the ledger stays SMALL (trimmed to `MAX_HISTORY_LINES`) no matter how many
 * events a long-lived lane accumulates.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  appendLaneHistory, readLaneHistory, lastLaneHistoryEntry, laneHistoryEntry, inferPrNumber,
  laneHistoryPath, MAX_HISTORY_LINES,
} from '../lane-history.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lane-history-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('laneHistoryEntry', () => {
  it('shapes only the fields it was given, omitting everything unknown', () => {
    const e = laneHistoryEntry({ event: 'acquire', nowMs: 0, session: 's1' });
    expect(e).toEqual({ ts: new Date(0).toISOString(), event: 'acquire', session: 's1' });
  });

  it('throws without an event name — a ledger line must always say what happened', () => {
    expect(() => laneHistoryEntry({})).toThrow();
  });

  it('infers a PR number from an explicit pr field first', () => {
    const e = laneHistoryEntry({ event: 'release', pr: 2606, session: 'fix-9999' });
    expect(e.pr).toBe(2606);
  });

  it('falls back to a review-<pr>/fix-<pr> session naming convention', () => {
    expect(inferPrNumber({ session: 'review-2606' })).toBe(2606);
    expect(inferPrNumber({ holder: 'fix-2606-lane-3-ab12' })).toBe(2606);
    expect(inferPrNumber({ session: 'unrelated-name' })).toBeNull();
  });
});

describe('appendLaneHistory / readLaneHistory', () => {
  it('appends a line the reader can parse straight back', () => {
    const entry = laneHistoryEntry({ event: 'acquire', nowMs: 1000, session: 's1', item: '3901' });
    expect(appendLaneHistory(dir, entry)).toBe(true);
    expect(readLaneHistory(dir)).toEqual([entry]);
  });

  it('accumulates multiple events in order, and lastLaneHistoryEntry is the newest', () => {
    appendLaneHistory(dir, laneHistoryEntry({ event: 'acquire', nowMs: 1 }));
    appendLaneHistory(dir, laneHistoryEntry({ event: 'release', nowMs: 2 }));
    const all = readLaneHistory(dir);
    expect(all.map((e) => e.event)).toEqual(['acquire', 'release']);
    expect(lastLaneHistoryEntry(all).event).toBe('release');
  });

  it('is a no-op (never throws) when the dir is not a git checkout at all', () => {
    const notGit = mkdtempSync(join(tmpdir(), 'lane-history-nogit-'));
    expect(appendLaneHistory(notGit, laneHistoryEntry({ event: 'acquire' }))).toBe(false);
    rmSync(notGit, { recursive: true, force: true });
  });

  it('lives inside .git/ — never a tracked/dirty file in the lane\'s own working tree', () => {
    appendLaneHistory(dir, laneHistoryEntry({ event: 'acquire' }));
    expect(laneHistoryPath(dir)).toBe(join(dir, '.git', 'lane-history.jsonl'));
    expect(existsSync(join(dir, 'lane-history.jsonl'))).toBe(false);
  });

  it('skips a corrupt trailing line rather than losing the whole read', () => {
    const file = laneHistoryPath(dir);
    writeFileSync(file, `${JSON.stringify(laneHistoryEntry({ event: 'acquire', nowMs: 1 }))}\n{not json\n`);
    const entries = readLaneHistory(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toBe('acquire');
  });

  it('reads back [] for a lane that was never touched by history-aware code', () => {
    expect(readLaneHistory(dir)).toEqual([]);
  });

  it('trims to the last MAX_HISTORY_LINES entries — "keep it small"', () => {
    for (let i = 0; i < MAX_HISTORY_LINES + 50; i += 1) {
      appendLaneHistory(dir, laneHistoryEntry({ event: 'acquire', nowMs: i, session: `s${i}` }));
    }
    const entries = readLaneHistory(dir);
    expect(entries).toHaveLength(MAX_HISTORY_LINES);
    // the OLDEST 50 were dropped; the newest one (s<last>) survived.
    expect(entries[entries.length - 1].session).toBe(`s${MAX_HISTORY_LINES + 49}`);
    expect(entries[0].session).toBe('s50');
  });
});
