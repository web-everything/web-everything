// @vitest-environment node
import { it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWatchGeneration, readJournal, appendDecisions, receiptsFromJournal, readResponderConfig, readReceipts, archivedReceipts, rotateJournalIfNeeded, readLatestDecisions, responderDir } from '../health-responder-state.mjs';
import { decide } from '../health-responder-core.mjs';
import { shadowTick } from '../health-responder.mjs';
import { healthDir } from '../health-watch-section.mjs';
import { scrubDeep } from '../health-watch-core.mjs';
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
function cachedStore(dir = temp()) {
  appendDecisions(dir, actRows());
  rotateJournalIfNeeded(dir, { rotateBytes: 1 });
  return { dir, segment: join(dir, segmentsOf(dir)[0]), archive: join(dir, 'receipts-archive.json') };
}
const storeBytes = (dir) => Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name))]));
it.each([
  ['partial final line', (text) => text + '{partial'],
  ['malformed JSON', () => '{broken}\n'],
  ['invalid schema', (text) => text.replace('"schema":1', '"schema":2')],
])('refuses a cached segment with %s without changing store bytes', (_, corrupt) => {
  const { dir, segment } = cachedStore();
  writeFileSync(segment, corrupt(readFileSync(segment, 'utf8')));
  const before = storeBytes(dir);
  expect(() => readReceipts(dir)).toThrow();
  expect(storeBytes(dir)).toEqual(before);
});
it.each(['replace', 'remove', 'inject', 'malformed'])('repairs %s cached receipts from journal rows', (change) => {
  const { dir, segment, archive } = cachedStore();
  const expected = readReceipts(dir), bytes = readFileSync(segment);
  const cached = JSON.parse(readFileSync(archive));
  const forged = { ...expected[0], familyKey: 'forged', identity: 'forged' };
  if (change === 'replace') cached.segments[0].receipts = [forged];
  if (change === 'remove') delete cached.segments[0].receipts;
  if (change === 'inject') cached.segments[0].receipts.push(forged);
  if (change === 'malformed') cached.segments[0].receipts = { forged: true };
  writeFileSync(archive, JSON.stringify(cached));
  const inode = statSync(archive).ino;
  expect(readReceipts(dir)).toEqual(expected);
  expect(statSync(archive).ino).not.toBe(inode);
  expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  expect(JSON.parse(readFileSync(archive)).segments[0].receipts).toEqual(JSON.parse(JSON.stringify(expected)));
  expect(readFileSync(segment)).toEqual(bytes);
});
it.each(['same-length identity', 'non-receipt field', 'blank line'])('rejects a digest mismatch for %s bytes', (change) => {
  const { dir, segment, archive } = cachedStore();
  const original = readFileSync(segment, 'utf8'), row = JSON.parse(original);
  if (change === 'same-length identity') row.episodeIdentity.id = row.episodeIdentity.id.replace(/[a-z]/, (c) => c === 'x' ? 'y' : 'x');
  if (change === 'non-receipt field') row.rule = 'x'.repeat(row.rule.length);
  const changed = change === 'blank line' ? original + '\n' : JSON.stringify(row) + '\n';
  if (change !== 'blank line') expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
  if (change === 'non-receipt field') expect(receiptsFromJournal([row])).toEqual(receiptsFromJournal([JSON.parse(original)]));
  writeFileSync(segment, changed);
  // A broken projection must not turn the retained hash into a cache miss.
  const cached = JSON.parse(readFileSync(archive)); delete cached.segments[0].receipts;
  writeFileSync(archive, JSON.stringify(cached));
  const before = storeBytes(dir);
  expect(() => readReceipts(dir)).toThrow(`journal segment integrity mismatch: ${segmentsOf(dir)[0]}`);
  expect(storeBytes(dir)).toEqual(before);
});
it.each([undefined, null, '', 'bad', 'a'.repeat(63), 'g'.repeat(64), 123, {}])('rebuilds invalid or legacy digest metadata %j only from valid segments', (contentHash) => {
  const { dir, segment, archive } = cachedStore(), expected = readReceipts(dir);
  const cached = JSON.parse(readFileSync(archive));
  cached.segments[0].contentHash = contentHash;
  cached.segments[0].receipts = [];
  const stale = JSON.stringify(cached);
  writeFileSync(archive, stale);
  expect(readReceipts(dir)).toEqual(expected);
  expect(JSON.parse(readFileSync(archive)).segments[0].contentHash).toBe(createHash('sha256').update(readFileSync(segment)).digest('hex'));
  writeFileSync(archive, stale);
  writeFileSync(segment, '{broken}\n');
  const before = storeBytes(dir);
  expect(() => readReceipts(dir)).toThrow();
  expect(storeBytes(dir)).toEqual(before);
});
it.each(['missing', 'broken', 'empty', 'stale', 'wrong schema'])('validates segments before rebuilding a %s archive', (kind) => {
  const { dir, segment, archive } = cachedStore(), expected = readReceipts(dir);
  const invalidate = () => {
    if (kind === 'missing') rmSync(archive);
    else if (kind === 'broken') writeFileSync(archive, '{broken');
    else writeFileSync(archive, JSON.stringify({ schema: kind === 'wrong schema' ? 2 : 1,
      segments: kind === 'stale' ? [{ name: 'stale', receipts: [] }] : [] }));
  };
  invalidate();
  expect(readReceipts(dir)).toEqual(expected);
  const rebuilt = readFileSync(archive);
  invalidate();
  expect(readReceipts(dir)).toEqual(expected);
  expect(readFileSync(archive)).toEqual(rebuilt);
  invalidate(); writeFileSync(segment, '{broken}\n');
  const before = storeBytes(dir);
  expect(() => readReceipts(dir)).toThrow();
  expect(storeBytes(dir)).toEqual(before);
});
it('removes stale index entries, including after the final segment is removed', () => {
  const { dir, segment, archive } = cachedStore(), expected = readReceipts(dir);
  const cached = JSON.parse(readFileSync(archive));
  cached.segments.unshift({ ...cached.segments[0], name: 'stale' });
  writeFileSync(archive, JSON.stringify(cached));
  expect(readReceipts(dir)).toEqual(expected);
  expect(JSON.parse(readFileSync(archive)).segments.map((s) => s.name)).toEqual(segmentsOf(dir));
  rmSync(segment);
  expect(readReceipts(dir)).toEqual([]);
  expect(JSON.parse(readFileSync(archive)).segments).toEqual([]);
});
it('keeps every valid duplicate digest baseline when rebuilding a malformed index', () => {
  const { dir, segment, archive } = cachedStore();
  const cached = JSON.parse(readFileSync(archive));
  cached.segments.push({ name: cached.segments[0].name, receipts: [] });
  writeFileSync(archive, JSON.stringify(cached));
  writeFileSync(segment, readFileSync(segment, 'utf8') + '\n');
  const before = storeBytes(dir);
  expect(() => readReceipts(dir)).toThrow('integrity mismatch');
  expect(storeBytes(dir)).toEqual(before);
});
it.each(['partial', 'digest'])('publishes no partial repair when a later segment fails %s validation', (failure) => {
  const { dir, archive } = cachedStore();
  appendDecisions(dir, actRows()); rotateJournalIfNeeded(dir, { rotateBytes: 1 });
  const cached = JSON.parse(readFileSync(archive));
  delete cached.segments[0].contentHash; cached.segments[0].receipts = [];
  writeFileSync(archive, JSON.stringify(cached));
  const later = join(dir, cached.segments[1].name);
  writeFileSync(later, readFileSync(later, 'utf8') + (failure === 'partial' ? '{partial' : '\n'));
  const before = storeBytes(dir);
  expect(() => readReceipts(dir)).toThrow();
  expect(storeBytes(dir)).toEqual(before);
});
it.each(['symlink', 'directory'])('rejects a cached segment replaced by a %s', (kind) => {
  const { dir, segment, archive } = cachedStore(), before = readFileSync(archive);
  const target = join(temp(), 'target.jsonl'), original = readFileSync(segment);
  writeFileSync(target, original); rmSync(segment);
  if (kind === 'symlink') symlinkSync(target, segment); else mkdirSync(segment);
  expect(() => readReceipts(dir)).toThrow();
  expect(readFileSync(archive)).toEqual(before);
  expect(readFileSync(target)).toEqual(original);
});
it.each(['partial', 'digest'])('blocks append and shadowTick before facts or decisions on cached %s corruption', async (failure) => {
  const root = temp(), { dir, segment } = cachedStore(responderDir(root));
  mkdirSync(healthDir(root), { recursive: true }); watch(healthDir(root));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, enabled: true, mode: 'shadow', smells: { [green.episode.smell]: true } }));
  writeFileSync(join(dir, 'last-tick.json'), JSON.stringify({ completedAt: replay.now - 1 }));
  expect(readWatchGeneration(healthDir(root)).watchGeneration.valid).toBe(true);
  expect(readResponderConfig(dir).enabled).toBe(true);
  writeFileSync(segment, readFileSync(segment, 'utf8') + (failure === 'partial' ? '{partial' : '\n'));
  const before = storeBytes(dir);
  expect(() => appendDecisions(dir, actRows())).toThrow();
  expect(storeBytes(dir)).toEqual(before);
  const readFacts = vi.fn(async () => { throw new Error('fact-reader tripwire'); });
  await expect(shadowTick({ stateRoot: root, now: replay.now, clock: () => replay.now, readFacts })).rejects.toThrow();
  expect(readFacts).not.toHaveBeenCalled();
  expect(storeBytes(dir)).toEqual(before);
});
it('hashes raw multi-byte chunks and avoids rewriting intact persisted projections', () => {
  const dir = temp(), row = { ...actRows()[0], schema: 1, familyKey: 'token ' + 'a'.repeat(20), pad: 'é'.repeat(700_000) };
  delete row.expectedHeadOrLease; // undefined receipt fields are omitted by JSON persistence.
  let bytes = Buffer.from('\n' + JSON.stringify(row) + '\n\n');
  if (bytes[1024 * 1024] !== 0xa9) bytes = Buffer.concat([Buffer.from('\n'), bytes]);
  expect(bytes[1024 * 1024]).toBe(0xa9); // The next chunk starts midway through é.
  writeFileSync(join(dir, 'decisions.jsonl'), bytes);
  rotateJournalIfNeeded(dir, { rotateBytes: 1 });
  const archive = join(dir, 'receipts-archive.json'), before = readFileSync(archive), stat = statSync(archive);
  const cached = JSON.parse(before).segments[0];
  expect(cached.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(cached.receipts).toEqual(JSON.parse(JSON.stringify(scrubDeep(receiptsFromJournal([row])))));
  for (let i = 0; i < 2; i++) expect(readReceipts(dir)).toEqual(receiptsFromJournal([row]));
  expect(readFileSync(archive)).toEqual(before);
  expect(statSync(archive).ino).toBe(stat.ino);
  expect(statSync(archive).mtimeMs).toBe(stat.mtimeMs);
  expect(readFileSync(join(dir, segmentsOf(dir)[0]))).toEqual(bytes);
});
it('preserves generated digest baselines even when the text scrubber considers them secret-shaped', () => {
  const dir = temp(), row = { ...actRows()[0], schema: 1 };
  let bytes, digest;
  for (let nonce = 0; nonce < 1000; nonce++) {
    bytes = JSON.stringify({ ...row, nonce }) + '\n';
    digest = createHash('sha256').update(bytes).digest('hex');
    if (scrubDeep(digest) !== digest) break;
  }
  expect(scrubDeep(digest)).not.toBe(digest);
  writeFileSync(join(dir, 'decisions.jsonl'), bytes);
  rotateJournalIfNeeded(dir, { rotateBytes: 1 });
  expect(JSON.parse(readFileSync(join(dir, 'receipts-archive.json'))).segments[0].contentHash).toBe(digest);
  const segment = join(dir, segmentsOf(dir)[0]);
  writeFileSync(segment, bytes + '\n');
  const before = storeBytes(dir);
  expect(() => readReceipts(dir)).toThrow('integrity mismatch');
  expect(storeBytes(dir)).toEqual(before);
});
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
