import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { summarizeSelection, formatSelection, selectionNotice, verdictNotice, parseSelectionLine, SELECTION_NOTICE_PREFIX } from '../verify-selection-log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const shrink = (selectionMode, extra = {}) => ({ decision: { mode: 'shrink', changedFiles: ['a.mjs', 'b.mjs'], targets: ['a.mjs', 'b.mjs', 't.test.mjs'],
  selection: { selectedTestCount: 4 }, selectionMode, ...extra } });

describe('verify selection log line (#xlewnhs)', () => {
  it('names since-last-green, pr, full, explicit and unresolved runs with files/tests counts', () => {
    expect(summarizeSelection({ gate: shrink({ mode: 'since-last-green', base: 'abc', reason: 'delta is the PR\'s own commits' }) }))
      .toEqual({ mode: 'since-last-green', reason: 'delta is the PR\'s own commits', files: 2, tests: 4 });
    expect(summarizeSelection({ gate: shrink({ mode: 'pr', reason: 'fallback — no green ancestor' }) }))
      .toEqual({ mode: 'pr', reason: 'fallback — no green ancestor', files: 2, tests: 4 });
    expect(summarizeSelection({ gate: { decision: { mode: 'full', changedFiles: ['package.json'], reasons: ['dependency change'], selectionMode: { mode: 'pr', reason: "verify.selection is 'pr'" } } } }))
      .toEqual({ mode: 'full', reason: "dependency change (pr: verify.selection is 'pr')", files: 1, tests: 'all' });
    expect(summarizeSelection({ explicitGate: true }).mode).toBe('explicit');
    expect(summarizeSelection({}).mode).toBe('unresolved');
  });
  it('prints one notice the dispatcher copies, and the parser reads it back from the daemon-log copy', () => {
    const summary = summarizeSelection({ gate: shrink({ mode: 'since-last-green', base: 'abc', reason: 'own "commits"' }) });
    const line = selectionNotice({ sha: '1a2b3c4d5e6f', summary });
    expect(line).toBe(`${SELECTION_NOTICE_PREFIX} selection @ 1a2b3c4d mode=since-last-green reason="own \\"commits\\"" files=2 tests=4`);
    // The dispatcher's onNotice rewrites the prefix to the lane name (verify-dispatch.mjs).
    const logged = `[2026-10-10T15:00:00Z]   ${line.replace(/^⚠ verify-lane:/, '⚠ web-everything/lane-16:')}`;
    expect(parseSelectionLine(logged)).toEqual({ kind: 'selection', sha: '1a2b3c4d', mode: 'since-last-green', reason: 'own "commits"', files: 2, tests: 4 });
    const verdict = verdictNotice({ sha: 'ffff0000aaaa', status: 'green', summary: summarizeSelection({ gate: { decision: { mode: 'full', changedFiles: null, reasons: [] } } }) });
    expect(parseSelectionLine(verdict)).toMatchObject({ kind: 'verdict', status: 'green', mode: 'full', files: null, tests: 'all' });
    expect(formatSelection(null)).toBe('mode=unresolved reason="no selection was resolved" files=? tests=?');
    expect(parseSelectionLine('  dispatching verify for web-everything/lane-1 @ 12345678 (suites: default)…')).toBeNull();
  });
  it('verify-lane prints both lines only for a daemon-dispatched run, through the existing notice channel', () => {
    const src = readFileSync(join(HERE, '../../verify-lane.mjs'), 'utf8');
    expect(src).toMatch(/DISPATCHED_RUN && MODE === 'verify'\) process\.stderr\.write\(`\$\{selectionNotice\(/);
    expect(src).toMatch(/verdictNotice\(\{ sha: result\.sha, status: result\.status, summary: SELECTION \}\)/);
    const dispatch = readFileSync(join(HERE, '../../conveyor/verify-dispatch.mjs'), 'utf8');
    expect(dispatch).toContain("line.startsWith('⚠ verify-lane:')");
  });
});
