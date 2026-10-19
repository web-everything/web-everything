// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeReserveBlockers, isPriorityLabels, readReserves, writeReserves } from '../priority-reserve.mjs';

const stamp = { num: 1, repo: null, headSha: 'head', files: ['x.mjs', 'backlog/card.md'], at: 1_000 };
const blockers = (over = {}) => activeReserveBlockers({ candidate: { num: 2, key: 'cwd#2', files: ['x.mjs'] }, reserves: { 'cwd#1': stamp }, now: 2_000, ...over });
describe('priority reserves', () => {
  it('blocks overlapping files and permits disjoint files', () => {
    expect(blockers()).toEqual([stamp]);
    expect(blockers({ candidate: { key: 'cwd#2', files: ['other'] } })).toEqual([]);
  });
  it('skips its own key, stale stamps and invalid stamps', () => {
    expect(blockers({ candidate: { key: 'cwd#1', files: ['x.mjs'] } })).toEqual([]);
    expect(blockers({ now: 1_000 + 30 * 60_000 })).toEqual([]);
    expect(blockers({ ttlMs: 1_000 })).toEqual([]);
    expect(blockers({ isValid: () => false })).toEqual([]);
  });
  it('ignores future stamps and accepts stamps at the current time', () => {
    expect(blockers({ now: stamp.at - 1 })).toEqual([]);
    expect(blockers({ now: stamp.at })).toEqual([stamp]);
  });
  it('honours the card overlap setting', () => {
    const candidate = { key: 'cwd#2', files: ['backlog/card.md'] };
    expect(blockers({ candidate })).toEqual([stamp]);
    expect(blockers({ candidate, includeCards: false })).toEqual([]);
  });
  it('recognizes string and object priority labels', () => {
    expect(isPriorityLabels(['priority:now'])).toBe(true);
    expect(isPriorityLabels([{ name: 'priority:urgent' }])).toBe(true);
    expect(isPriorityLabels(['ready-to-merge', 'priority:later'])).toBe(false);
    expect(isPriorityLabels()).toBe(false);
  });
  it('round trips atomic stamps and tolerates missing or unreadable files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'priority-reserve-'));
    const path = join(dir, 'reserves.json');
    try {
      expect(readReserves(path)).toEqual({});
      writeReserves(path, { 'cwd#1': stamp });
      expect(readReserves(path)).toEqual({ 'cwd#1': stamp });
      writeFileSync(path, '{');
      expect(readReserves(path)).toEqual({});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
