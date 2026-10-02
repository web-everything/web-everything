// @vitest-environment node
import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWatchGeneration, readJournal, appendDecisions, receiptsFromJournal, readResponderConfig, readReceipts, archivedReceipts, rotateJournalIfNeeded, readLatestDecisions, responderDir } from '../health-responder-state.mjs';
import { decide } from '../health-responder-core.mjs';
const replay = JSON.parse(readFileSync(new URL('./fixtures/health-responder/replay.json', import.meta.url)));
const green = replay.cases.find((c) => c.name === 'D1-fresh-green');
const roots = []; const temp = () => { const p = mkdtempSync(join(tmpdir(), 'health-responder-')); roots.push(p); return p; };
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function watch(dir) {
  mkdirSync(join(dir, 'episodes'));
  const tick = { completedAt: replay.now };
  writeFileSync(join(dir, 'last-tick.json'), JSON.stringify(tick));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ lastTick: tick, episodes: { [green.episode.key]: green.episode } }));
  writeFileSync(join(dir, 'episodes', `${green.episode.id}.json`), JSON.stringify(green.episode));
}
it('reads only snapshot subjects, never retained closed history', () => {
  const dir = temp(); watch(dir);
  writeFileSync(join(dir, 'episodes', 'history.json'), '{broken historical report');
  expect(readWatchGeneration(dir).episodes).toEqual([green.episode]);
  expect(readWatchGeneration(dir).watchGeneration.valid).toBe(true);
});
it('rejects changed report identity/samples/status and mixed completion generations', () => {
  for (const field of ['id', 'openedAt', 'samples', 'lastBreachAt', 'status']) {
    const dir = temp(); watch(dir);
    writeFileSync(join(dir, 'episodes', `${green.episode.id}.json`), JSON.stringify({ ...green.episode, [field]: 'changed' }));
    expect(readWatchGeneration(dir).watchGeneration.valid).toBe(false);
  }
  const dir = temp(); watch(dir);
  let n = 0;
  const result = readWatchGeneration(dir, { readJson: (p) => {
    const value = JSON.parse(readFileSync(p));
    if (p.endsWith('last-tick.json')) value.completedAt += ++n;
    return value;
  } });
  expect(result.watchGeneration).toMatchObject({ valid: false, reason: 'mixed watch generation after retry' });
});
it('rejects corrupt, missing, path-traversing and oversized watch input', () => {
  const dir = temp(); expect(readWatchGeneration(dir).watchGeneration.valid).toBe(false);
  watch(dir);
  const e = { ...green.episode, id: '../../outside' };
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ episodes: { [e.key]: e }, lastTick: { completedAt: replay.now } }));
  expect(readWatchGeneration(dir).watchGeneration.valid).toBe(false);
  writeFileSync(join(dir, 'state.json'), ' '.repeat(8 * 1024 * 1024 + 1));
  expect(readWatchGeneration(dir).watchGeneration.valid).toBe(false);
});
it('journals every decision durably; restart rebuilds only shadow prepared receipts', () => {
  const dir = temp();
  const rows = decide({ now: replay.now, episodes: [green.episode], watchGeneration: { valid: true, completedAt: replay.now },
    subjectFacts: { [green.episode.key]: green.facts }, config: { version: 1, enabled: true, mode: 'shadow', smells: { [green.episode.smell]: true } } });
  appendDecisions(dir, rows); const before = readFileSync(join(dir, 'decisions.jsonl'), 'utf8');
  appendDecisions(dir, [{ ...rows[0], decision: 'hold', rule: 'test-hold' }]);
  expect(readFileSync(join(dir, 'decisions.jsonl'), 'utf8').startsWith(before)).toBe(true);
  const receipts = receiptsFromJournal(readJournal(dir));
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ state: 'prepared', mode: 'shadow', successfulLiveAction: false, submittedAt: null, recoveredAt: null });
  expect(JSON.parse(readFileSync(join(dir, 'receipts.json'))).liveBudgets).toEqual([]);
  writeFileSync(join(dir, 'decisions.jsonl'), before + '{partial');
  expect(() => appendDecisions(dir, rows)).toThrow('partial journal');
  expect(readFileSync(join(dir, 'decisions.jsonl'), 'utf8')).toBe(before + '{partial');
});
it('missing config defaults disabled, corrupt config stays unknown', () => {
  const dir = temp(); expect(readResponderConfig(dir).enabled).toBe(false);
  writeFileSync(join(dir, 'config.json'), '{'); expect(readResponderConfig(dir)).toBe(null);
});
const actRows = () => decide({ now: replay.now, episodes: [green.episode], watchGeneration: { valid: true, completedAt: replay.now },
  subjectFacts: { [green.episode.key]: green.facts }, config: { version: 1, enabled: true, mode: 'shadow', smells: { [green.episode.smell]: true } } });
const segmentsOf = (dir) => readdirSync(dir).filter((n) => /^decisions\..+\.jsonl$/.test(n)).sort();
it('rotates the active journal at the size threshold; segments are complete and receipts survive rotation', () => {
  const dir = temp(), rows = actRows();
  appendDecisions(dir, rows, { rotateBytes: 1 << 30 });
  const first = readFileSync(join(dir, 'decisions.jsonl'));
  appendDecisions(dir, [{ ...rows[0], decision: 'hold', rule: 'later' }], { rotateBytes: first.length });
  const [segment] = segmentsOf(dir);
  expect(segmentsOf(dir)).toHaveLength(1);
  expect(readFileSync(join(dir, segment)).equals(first)).toBe(true);
  expect(readJournal(dir).map((r) => r.rule)).toEqual(['later']);
  expect(readReceipts(dir)).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(dir, 'receipts.json'))).receipts).toHaveLength(1);
  expect(rotateJournalIfNeeded(dir, { rotateBytes: 1 << 30 })).toBe(null);
});
it('same-millisecond rotations get distinct segment names and nothing is overwritten', () => {
  const root = temp(), dir = responderDir(root), rows = actRows(), now = () => 1_800_000_000_000;
  for (let i = 0; i < 12; i++) { appendDecisions(dir, [{ ...rows[0], rule: `r${i}` }]); rotateJournalIfNeeded(dir, { rotateBytes: 1, now }); }
  expect(segmentsOf(dir)).toHaveLength(12);
  expect(readReceipts(dir)).toHaveLength(12);
  // The feed's fallback picks the LAST rotation, though `-1`/`-10` sort before the bare name as plain strings.
  expect(readLatestDecisions({ stateRoot: root }).records.map((r) => r.rule)).toEqual(['r11']);
});
it('never buries a corrupt or torn active journal in a segment, whatever its size', () => {
  const dir = temp(), rows = actRows();
  appendDecisions(dir, rows);
  const torn = readFileSync(join(dir, 'decisions.jsonl'), 'utf8') + '{partial';
  writeFileSync(join(dir, 'decisions.jsonl'), torn);
  expect(() => rotateJournalIfNeeded(dir, { rotateBytes: 1 })).toThrow('partial journal');
  expect(segmentsOf(dir)).toHaveLength(0);
  expect(readFileSync(join(dir, 'decisions.jsonl'), 'utf8')).toBe(torn);
});
it('rebuilds the receipt archive from the segments when it is lost, stale or corrupt', () => {
  const dir = temp(), rows = actRows();
  appendDecisions(dir, rows); rotateJournalIfNeeded(dir, { rotateBytes: 1 });
  const expected = archivedReceipts(dir);
  expect(expected).toHaveLength(1);
  rmSync(join(dir, 'receipts-archive.json'));
  expect(archivedReceipts(dir)).toEqual(expected);
  writeFileSync(join(dir, 'receipts-archive.json'), '{broken');
  expect(archivedReceipts(dir)).toEqual(expected);
  writeFileSync(join(dir, 'receipts-archive.json'), JSON.stringify({ schema: 1, segments: [] }));
  expect(archivedReceipts(dir)).toEqual(expected);
});
it('a corrupt or partial segment still freezes the tick instead of being skipped', () => {
  const dir = temp(), rows = actRows();
  appendDecisions(dir, rows); rotateJournalIfNeeded(dir, { rotateBytes: 1 });
  const [segment] = segmentsOf(dir);
  rmSync(join(dir, 'receipts-archive.json'));
  writeFileSync(join(dir, segment), readFileSync(join(dir, segment), 'utf8') + '{partial');
  expect(() => archivedReceipts(dir)).toThrow('partial journal');
});
it('reads a multi-megabyte journal with long lines through bounded chunks', () => {
  const dir = temp(), row = actRows()[0];
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ ...row, schema: 1, pad: 'é'.repeat(700_000) }) + '\n'; // spans chunk boundaries mid-character
  writeFileSync(join(dir, 'decisions.jsonl'), line.repeat(5));
  expect(readJournal(dir)).toHaveLength(5);
});
it('the read-only feed spans a fresh rotation and reports a store with nothing recorded', () => {
  const root = temp(), dir = responderDir(root), rows = actRows();
  expect(readLatestDecisions({ stateRoot: root }).error).toBe('No decisions recorded');
  appendDecisions(dir, rows); rotateJournalIfNeeded(dir, { rotateBytes: 1 });
  expect(readLatestDecisions({ stateRoot: root }).records).toHaveLength(1);
  appendDecisions(dir, [{ ...rows[0], decision: 'hold', rule: 'later' }], { rotateBytes: 1 << 30 });
  expect(readLatestDecisions({ stateRoot: root }).records.map((r) => r.rule)).toEqual([rows[0].rule, 'later']);
});
