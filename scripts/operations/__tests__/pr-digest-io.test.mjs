// @vitest-environment node
/** Hermetic PR digest fixtures: cache, bounded rendering, paginated reads and chunked local evidence. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createPrDigestReader, createPrDigestSinks, readDigestLedger, readDigestDaemon, readLatestCommentId, COMMENTS_MAX_BUFFER, HISTORY_LINE_MAX_BYTES } from '../pr-digest-io.mjs';
import { cacheHeader, PR_DIGEST_EFFECT, finishPrDigest, prDigestOperation, renderPrDigest } from '../pr-digest.mjs';
import { runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { createRegistry } from '../registry.mjs';
import { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, validateReferralRecord, validateOperatorRuling } from '../../lib/jury-core.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';
import { hugeThread } from './fixtures/pr-digest/huge-thread.mjs';

it('reads real checkout histories and atomically writes and revalidates a digest with only GitHub doubled', async () => {
  await withRealRepo(async ({ root, head, commit }) => {
    const row = { ...completeOutcome, head: head(), outcome: 'no-change' };
    commit({ 'ledger.jsonl': JSON.stringify(row) + '\n' });
    const pr = { ...fixture.pr, headRefOid: head(), labels: [] };
    const gh = vi.fn(args => {
      if (args[1] === 'view') return JSON.stringify(pr);
      if (args.includes('--paginate')) return '';
      throw new Error('unexpected GitHub call');
    });
    const read = createPrDigestReader({ gh });
    const input = { pr: 42, 'out-dir': join(root, '.operations', 'digests'), ledger: join(root, 'ledger.jsonl'),
      'daemon-log': join(root, 'daemon.log') };
    const written = read(input).results[0];
    expect(written.status).toBe('written');
    expect(readFileSync(written.path, 'utf8')).toContain('Blocked on: nothing detected');
    expect(readFileSync(`${written.path}.cache`, 'utf8')).toMatch(/^[a-f0-9]{64} [a-f0-9]{64}\n$/);
    expect(read(input).results[0].status).toBe('cached');
    writeFileSync(input.ledger, JSON.stringify({ ...row, outcome: 'failed', reason: 'real history changed' }));
    expect(read(input).results[0].status).toBe('written');
    const before = readFileSync(written.path, 'utf8');
    expect(before).toContain('Blocked on: failing fix-loop outcome');
    writeFileSync(input.ledger, JSON.stringify({ ...row, outcome: '' }));
    expect(() => read(input)).toThrow('incomplete outcome');
    expect(readFileSync(written.path, 'utf8')).toBe(before);
  });
});

const fixture = JSON.parse(readFileSync(new URL('./fixtures/pr-digest/thread.json', import.meta.url), 'utf8'));
const roots = [];
afterEach(() => { roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'pr-digest-')); roots.push(p); return p; };
const trusted = comments => comments.map(c => ({ ...c, trusted: true }));
const tsv = value => String(value ?? '').replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n').replaceAll('\r', '\\r');

function harness(options = {}) {
  const out = temp();
  const state = structuredClone(fixture);
  const gh = vi.fn((args, opts) => {
    expect(opts.maxBuffer).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ ...state.pr, number: Number(args[2]) });
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{ number: 42 }, { number: 43 }]);
    if (args.includes('--paginate') && args.at(-1) === '.[].id') return state.comments.map(c => c.id).join('\n');
    if (args.includes('--paginate')) return state.comments.map(c => [c.body, '2026-10-23T10:00:00Z', c.author.login, `IC_${c.id}`, ''].map(tsv).join('\t')).join('\n');
    throw new Error('unexpected gh invocation');
  });
  const write = vi.fn(writeFileSync);
  const writeCache = vi.fn(writeFileSync);
  const readLedger = vi.fn(() => []), readDaemon = vi.fn(() => []);
  const read = createPrDigestReader({ gh, write, writeCache, readLedger, readDaemon, ...options });
  return { state, gh, write, writeCache, readLedger, readDaemon, read, input: { pr: 42, 'out-dir': out }, path: join(out, 'pr-42.md'), out };
}
const render = (extra = {}) => renderPrDigest({ repo: 'web-everything/web-everything', pr: fixture.pr, lastComment: 104, validateRuling: (r, referral, body) => referral ? validateReferralRecord(r) : validateOperatorRuling(r) && buildOperatorRulingComment(r) === body?.replace(/\r\n/g, '\n').trimEnd(), ...extra, comments: (extra.comments ?? trusted(fixture.comments)).map(c => ({ author: { login: 'chalbert' }, ...c })) });

function bounded(text) {
  expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(60);
  expect(text.trimEnd().split('\n').every(l => l.length <= 200)).toBe(true);
}

describe('pr-digest', () => {
  it('writes and caches digests only through the persisted writing effect sink', async () => {
    const h = harness();
    const out = join(h.out, 'nested', 'digests');
    const path = join(out, 'pr-42.md');
    const registry = createRegistry();
    const declaration = prDigestOperation();
    registry.register(declaration);
    expect(declaration.verdictFrom).toBe('assess');
    for (const status of ['written', 'cached']) {
      const outcome = await runOperationCli({ declaration, argv: ['--pr=42', `--out-dir=${out}`],
        registry, store: createMemoryRunStore(), sinks: { [PR_DIGEST_EFFECT]: h.read }, newRunId: () => `digest-${status}` });
      expect(outcome.code).toBe(0);
      const run = JSON.parse(JSON.stringify(outcome.run));
      const expected = { results: [{ pr: 42, path, status }], all: false };
      expect(run.findings.read).toEqual({ pr: 42, 'out-dir': out });
      expect(run.effects).toHaveLength(1);
      expect(run.effects[0].status).toBe('applied');
      expect(run.effects[0].result).toEqual(expected);
      expect(readFileSync(path, 'utf8').split('\n')[0]).toBe(cacheHeader(fixture.pr.headRefOid, 104));
      expect(run.verdict).toEqual(run.findings.read);
      expect(finishPrDigest({ run, code: 0, lines: [] }).lines).toEqual([`${path} ${status}`]);
      expect(finishPrDigest({ run, code: 0, lines: [], json: true }).lines).toEqual([JSON.stringify(expected)]);
    }
    expect(h.write).toHaveBeenCalledTimes(1);
  });

  it('writes a bounded cache miss with every section and summarized findings', () => {
    const h = harness();
    expect(h.read(h.input).results[0].status).toBe('written');
    const text = readFileSync(h.path, 'utf8');
    expect(text.split('\n')[0]).toBe(cacheHeader(fixture.pr.headRefOid, 104));
    for (const section of ['Purpose', 'Latest review verdict', 'Rulings', 'Open send-backs', 'Red-team results by head', 'Fix-loop outcomes', 'Daemon decisions (last 2h)']) expect(text).toContain(`## ${section}`);
    expect(text).toContain('Round/cap: 3/4');
    expect(text).toContain('scripts/other.mjs:24 (broken, edge-case)');
    expect(text).toContain('scripts/example.mjs:33 (unknown, judge)');
    expect(text).toContain('card=1');
    expect(text).toContain('scripts/red.mjs:8 - A missing key crashes.');
    expect(text).not.toMatch(/NEVER PASTE|DO NOT PASTE|THIRD PURPOSE/);
    expect(text).toContain('Blocked on: open send-back without evidence');
    bounded(text);
    expect(h.gh.mock.calls.every(([args]) => args[0] === 'api' || ['view', 'list'].includes(args[1]))).toBe(true);
  });

  it('revalidates the full thread and local histories and returns cached without rewriting unchanged digests', () => {
    const h = harness();
    h.read(h.input);
    const before = statSync(h.path);
    h.gh.mockClear(); h.readLedger.mockClear(); h.readDaemon.mockClear();
    expect(h.read(h.input).results[0].status).toBe('cached');
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.writeCache).toHaveBeenCalledTimes(2);
    expect(statSync(h.path).mtimeMs).toBe(before.mtimeMs);
    // One paginated latest-id probe plus one paginated full-thread read.
    expect(h.gh.mock.calls.filter(([args]) => args.includes('--paginate'))).toHaveLength(2);
    expect(h.readLedger).toHaveBeenCalledTimes(1); expect(h.readDaemon).toHaveBeenCalledTimes(1);
  });

  it('regenerates a hand-edited ruling as incomplete and accepts only a canonical correction without new IDs or HEAD', () => {
    const h = harness();
    h.state.pr.labels = [];
    h.state.comments = [structuredClone(fixture.comments[1]), { id: 104, body: 'Routine progress', author: { login: 'chalbert' } }];
    const ids = h.state.comments.map(c => c.id);
    h.read(h.input);
    const before = readFileSync(h.path, 'utf8');
    expect(before).toContain('not-real=0 card=1 block=0');
    expect(h.read(h.input).results[0].status).toBe('cached');
    const body = h.state.comments[0].body;
    const payload = body.match(/mandatory-referral-operator-ruling-v1: (\S+) -->/)[1];
    const record = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    record.rulings[0].result = 'not-real'; delete record.rulings[0].card;
    h.state.comments[0].body = body.replace(payload, Buffer.from(JSON.stringify(record)).toString('base64'));
    expect(h.state.comments.map(c => c.id)).toEqual(ids);
    expect(h.read(h.input).results[0].status).toBe('written');
    const incomplete = readFileSync(h.path, 'utf8');
    expect(incomplete.split('\n')[0]).toBe(before.split('\n')[0]);
    expect(incomplete).toContain('incomplete; inspect GitHub thread');
    expect(incomplete).toContain('Blocked on: referrals need a ruling');
    h.state.comments[0].body = buildOperatorRulingComment(record);
    expect(h.state.comments.map(c => c.id)).toEqual(ids);
    expect(h.read(h.input).results[0].status).toBe('written');
    const after = readFileSync(h.path, 'utf8');
    expect(after.split('\n')[0]).toBe(before.split('\n')[0]);
    expect(after).toContain('not-real=1 card=0 block=0');
    expect(after).not.toContain('not-real=0 card=1 block=0');
    expect(h.read(h.input).results[0].status).toBe('cached');
    expect(h.write).toHaveBeenCalledTimes(3);
  });

  it.each(['failed', 'incomplete'])('fails closed on a %s full-thread read despite a matching cache', kind => {
    const readComments = vi.fn(() => structuredClone(fixture.comments));
    const h = harness({ readComments }); h.read(h.input);
    const before = readFileSync(h.path, 'utf8');
    if (kind === 'failed') readComments.mockImplementation(() => { throw new Error('thread read failed'); });
    else readComments.mockReturnValue([{ id: 101 }]);
    expect(() => h.read(h.input)).toThrow(kind === 'failed' ? 'thread read failed' : 'incomplete comment thread');
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.writeCache).toHaveBeenCalledTimes(2);
    expect(readFileSync(h.path, 'utf8')).toBe(before);
  });

  it('regenerates for a label-only change with unchanged HEAD and latest comment ID', () => {
    const h = harness();
    h.state.comments = []; h.state.pr.labels = [];
    h.read(h.input);
    expect(readFileSync(h.path, 'utf8')).toContain('Blocked on: nothing detected');
    const header = readFileSync(h.path, 'utf8').split('\n')[0];
    h.state.pr.labels = [{ name: 'review:human' }];
    expect(h.read(h.input).results[0].status).toBe('written');
    const text = readFileSync(h.path, 'utf8');
    expect(text.split('\n')[0]).toBe(header);
    expect(text).toContain('Labels: review:human');
    expect(text).toContain('Blocked on: human review required');
    expect(h.write).toHaveBeenCalledTimes(2);
  });

  it.each(['ledger', 'daemon'])('regenerates for a %s-only update with unchanged HEAD and latest comment ID', kind => {
    const h = harness({ readLedger: readDigestLedger, readDaemon: readDigestDaemon, now: () => Date.parse('2026-10-23T11:00:00Z') });
    h.state.comments = []; h.state.pr.labels = [];
    const input = { ...h.input, ledger: join(h.out, 'ledger.jsonl'), 'daemon-log': join(h.out, 'daemon.log') };
    h.read(input);
    const header = readFileSync(h.path, 'utf8').split('\n')[0];
    if (kind === 'ledger') writeFileSync(input.ledger, JSON.stringify({ v: 1, session: 'fix-42', infra: false, head: 'a'.repeat(40), kind: 'outcome', repo: 'web-everything/web-everything', pr: 42, at: '2026-10-23T10:00:00Z', outcome: 'failed', reason: 'new local outcome' }));
    else writeFileSync(input['daemon-log'], '2026-10-23T10:00:00Z #42 new local decision\n');
    expect(h.read(input).results[0].status).toBe('written');
    const text = readFileSync(h.path, 'utf8');
    expect(text.split('\n')[0]).toBe(header);
    expect(text).toContain(kind === 'ledger' ? 'new local outcome' : 'new local decision');
    if (kind === 'ledger') expect(text).toContain('Blocked on: failing fix-loop outcome');
    expect(h.write).toHaveBeenCalledTimes(2);
  });

  it('regenerates when a daemon decision ages out without a log or GitHub update', () => {
    let now = Date.parse('2026-10-23T11:00:00Z');
    const h = harness({ readDaemon: readDigestDaemon, now: () => now });
    const log = join(h.out, 'daemon.log');
    const input = { ...h.input, 'daemon-log': log };
    writeFileSync(log, '2026-10-23T10:00:00Z #42 expiring decision\n');
    h.read(input);
    expect(readFileSync(h.path, 'utf8')).toContain('expiring decision');
    now = Date.parse('2026-10-23T12:01:00Z');
    expect(h.read(input).results[0].status).toBe('written');
    expect(readFileSync(h.path, 'utf8')).not.toContain('expiring decision');
    expect(h.read(input).results[0].status).toBe('cached');
  });

  it.each(['title', 'body'])('regenerates for a %s-only metadata change', field => {
    const h = harness(); h.read(h.input);
    h.state.pr[field] = 'Updated PR metadata';
    expect(h.read(h.input).results[0].status).toBe('written');
    expect(readFileSync(h.path, 'utf8')).toContain('Updated PR metadata');
  });

  it('regenerates a historical header-only digest without a cache sidecar', () => {
    const h = harness();
    writeFileSync(h.path, `${cacheHeader(fixture.pr.headRefOid, 104)}\nstale digest\n`);
    expect(h.read(h.input).results[0].status).toBe('written');
    expect(readFileSync(h.path, 'utf8')).not.toContain('stale digest');
    expect(h.read(h.input).results[0].status).toBe('cached');
  });

  it('regenerates when the cache sidecar is incomplete', () => {
    const h = harness(); h.read(h.input);
    writeFileSync(`${h.path}.cache`, 'incomplete');
    expect(h.read(h.input).results[0].status).toBe('written');
    expect(h.read(h.input).results[0].status).toBe('cached');
  });

  it.each(['ledger', 'daemon'])('fails closed on unreadable %s evidence despite matching GitHub cache headers', kind => {
    const readLedger = vi.fn(() => []), readDaemon = vi.fn(() => []);
    const h = harness({ readLedger, readDaemon });
    h.read(h.input);
    const before = readFileSync(h.path, 'utf8');
    (kind === 'ledger' ? readLedger : readDaemon).mockImplementation(() => { throw new Error('unreadable local history'); });
    expect(() => h.read(h.input)).toThrow('unreadable local history');
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(readFileSync(h.path, 'utf8')).toBe(before);
  });

  it('invalidates the old fingerprint before a failed cache write so reverted inputs regenerate', () => {
    const writeCache = vi.fn(writeFileSync);
    const h = harness({ writeCache }); h.read(h.input);
    const original = readFileSync(h.path, 'utf8');
    const title = h.state.pr.title;
    h.state.pr.title = 'Changed title';
    writeCache.mockImplementationOnce(writeFileSync).mockImplementationOnce(() => { throw new Error('cache write failed'); });
    expect(() => h.read(h.input)).toThrow('cache write failed');
    h.state.pr.title = title;
    expect(h.read(h.input).results[0].status).toBe('written');
    expect(readFileSync(h.path, 'utf8')).toBe(original);
  });

  it.each(['head', 'comment'])('regenerates when the %s changes', kind => {
    const h = harness(); h.read(h.input);
    if (kind === 'head') h.state.pr.headRefOid = 'b'.repeat(40);
    else h.state.comments.push({ id: 105, body: 'Progress', author: { login: 'chalbert' } });
    expect(h.read(h.input).results[0].status).toBe('written');
    expect(h.write).toHaveBeenCalledTimes(2);
  });

  it('summarizes 400 comments over 20 KB each with a raised child buffer', () => {
    const h = harness(); h.state.comments = hugeThread(fixture.comments);
    expect(h.state.comments.every(c => c.body.length >= 20_000)).toBe(true);
    h.read(h.input);
    const text = readFileSync(h.path, 'utf8'); bounded(text);
    expect(text).not.toContain('HUGE_BODY_SENTINEL');
    expect(text).toContain('changes requested'); expect(text).toContain('scripts/red.mjs:8');
    const call = h.gh.mock.calls.find(([args]) => args.includes('--paginate') && args.at(-1) !== '.[].id');
    expect(call[1].maxBuffer).toBe(COMMENTS_MAX_BUFFER);
  });

  it('processes --all sequentially and formats per-PR statuses and the final count', () => {
    const h = harness();
    const verdict = h.read({ all: true, 'out-dir': h.out });
    expect(verdict.results.map(r => r.pr)).toEqual([42, 43]);
    const calls = h.gh.mock.calls.map(([args]) => args);
    expect(calls.findIndex(a => a.includes('--paginate'))).toBeLessThan(calls.findIndex(a => a[1] === 'view' && a[2] === '43'));
    expect(finishPrDigest({ run: { effects: [{ type: PR_DIGEST_EFFECT, status: 'applied', result: verdict }] }, code: 0, lines: [] }).lines).toEqual(['#42 written', '#43 written', '2 PRs: 2 written, 0 cached']);
    expect(finishPrDigest({ run: { effects: [{ type: PR_DIGEST_EFFECT, status: 'applied', result: { ...verdict, all: false } }] }, code: 0, lines: [] }).lines[0]).toBe(`${h.path} written`);
  });

  it('fails closed on incomplete PR metadata and writes nothing', () => {
    const h = harness(); delete h.state.pr.labels;
    expect(() => h.read(h.input)).toThrow('incomplete PR metadata');
    expect(h.write).not.toHaveBeenCalled();
  });

  it('propagates failed full-thread reads and writes nothing', () => {
    const h = harness({ readComments: () => { throw new Error('buffer exhausted: rerun with a larger reader'); } });
    expect(() => h.read(h.input)).toThrow('buffer exhausted'); expect(h.write).not.toHaveBeenCalled();
  });

  it.each(['not HTTP', '{}', '[]', 'null', '101\nnull', 'null\n102', '101\n\n102', '0', '-1', '1.5', '9007199254740992', undefined, null])(
    'rejects invalid or missing comment ID metadata (%s) instead of assuming an empty thread', output => {
      expect(() => readLatestCommentId(42, () => output)).toThrow('invalid comments metadata');
    });

  it('reads all pages of comment IDs and returns the last ID with the raised child buffer', () => {
    const ids = Array.from({ length: 205 }, (_, i) => String(1000 + i));
    const gh = vi.fn(() => ids.join('\n') + '\n');
    expect(readLatestCommentId(42, gh)).toBe('1204');
    expect(gh).toHaveBeenCalledTimes(1);
    expect(gh).toHaveBeenCalledWith(
      ['api', '--paginate', 'repos/web-everything/web-everything/issues/42/comments?per_page=100', '--jq', '.[].id'],
      expect.objectContaining({ maxBuffer: COMMENTS_MAX_BUFFER, timeout: 120_000, killSignal: 'SIGKILL' }));
  });

  it('returns zero for a thread with zero comments', () => {
    expect(readLatestCommentId(42, () => '')).toBe('0');
  });

  it('propagates failed paginated ID reads instead of assuming an empty thread', () => {
    expect(() => readLatestCommentId(42, () => { throw new Error('comment IDs exceeded maxBuffer'); }))
      .toThrow('comment IDs exceeded maxBuffer');
  });

  it('keeps newest five ledger outcomes for this PR and filters daemon timestamps and PR boundaries', () => {
    const dir = temp(), ledger = join(dir, 'ledger.jsonl'), log = join(dir, 'daemon.log');
    const at = i => `2026-10-23T10:0${i}:00Z`;
    const records = Array.from({ length: 9 }, (_, i) => ({ v: 1, session: 'fix-42', infra: false, head: 'a'.repeat(40), kind: 'outcome', repo: 'web-everything/web-everything', pr: 42, at: at(i), outcome: 'failed', reason: 'x'.repeat(20_000) }));
    writeFileSync(ledger, [...records, { ...records[8], pr: 420 }, { ...records[8], kind: 'start' }].map(JSON.stringify).join('\n'));
    const rows = readDigestLedger(ledger, 42);
    expect(rows.map(r => r.at)).toEqual(records.slice(-5).map(r => r.at));
    writeFileSync(log, ['2026-10-23T07:00:00Z #42 old', '2026-10-23T10:00:00Z #420 unrelated', ...Array.from({ length: 8 }, (_, i) => `${at(i)} ${['#42', 'PR 42', 'pr=42'][i % 3]} decision ${i}`), '2026-10-23T12:00:00Z #42 future'].join('\n'));
    const daemon = readDigestDaemon(log, 42, Date.parse('2026-10-23T11:00:00Z'));
    expect(daemon).toHaveLength(5); expect(daemon[0]).toContain('decision 3'); expect(daemon.at(-1)).toContain('decision 7');
    const text = render({ ledger: rows, daemon }); bounded(text);
    expect(text).toContain('aaaaaaaa'.slice(0, 7));
    expect(readDigestLedger(join(dir, 'absent'), 42)).toEqual([]);
    expect(readDigestDaemon(join(dir, 'absent'), 42, Date.now())).toEqual([]);
    writeFileSync(ledger, '{broken');
    expect(() => readDigestLedger(ledger, 42)).toThrow('malformed ledger');
  });

  it('preserves long lines, split UTF-8 characters and final unterminated rows in local histories', () => {
    const dir = temp(), ledger = join(dir, 'ledger.jsonl'), log = join(dir, 'daemon.log');
    const prefix = JSON.stringify({ v: 1, session: 'fix-42', infra: false, head: 'a'.repeat(40), kind: 'outcome',
      repo: 'web-everything/web-everything', pr: 42, at: '2026-10-23T10:00:00Z', outcome: 'failed', reason: '' }).slice(0, -2);
    const reason = `${'x'.repeat(64 * 1024 - 1 - Buffer.byteLength(prefix))}🙂${'y'.repeat(70_000)}`;
    const row = { v: 1, session: 'fix-42', infra: false, head: 'a'.repeat(40), kind: 'outcome', repo: 'web-everything/web-everything', pr: 42, at: '2026-10-23T10:00:00Z', outcome: 'failed', reason };
    const final = { ...row, at: '2026-10-23T10:01:00Z', reason: 'last' };
    writeFileSync(ledger, `${JSON.stringify(row)}\n${JSON.stringify(final)}`);
    expect(readDigestLedger(ledger, 42)).toEqual([row, final]);
    const logPrefix = '2026-10-23T10:00:00Z #42 ';
    const line = `${logPrefix}${'x'.repeat(64 * 1024 - 1 - Buffer.byteLength(logPrefix))}🙂${'y'.repeat(70_000)}`;
    const finalLine = '2026-10-23T10:01:00Z PR 42 last';
    writeFileSync(log, `${line}\n${finalLine}`);
    expect(readDigestDaemon(log, 42, Date.parse('2026-10-23T11:00:00Z'))).toEqual([line, finalLine]);
  });

  it('throws synchronously on unreadable histories and incomplete ledger outcomes', () => {
    const dir = temp(), ledger = join(dir, 'ledger.jsonl');
    expect(() => readDigestLedger(dir, 42)).toThrow();
    expect(() => readDigestDaemon(dir, 42, Date.now())).toThrow();
    writeFileSync(ledger, JSON.stringify({ v: 1, session: 'fix-42', infra: false, head: 'a'.repeat(40), kind: 'outcome', repo: 'web-everything/web-everything', pr: 42, at: 'invalid', outcome: 'failed' }));
    expect(() => readDigestLedger(ledger, 42)).toThrow('incomplete outcome');
  });

  it('uses path overrides for local histories', () => {
    const h = harness(); h.read({ ...h.input, ledger: 'fixture-ledger', 'daemon-log': 'fixture-daemon' });
    expect(h.readLedger).toHaveBeenCalledWith('fixture-ledger', 42);
    expect(h.readDaemon).toHaveBeenCalledWith('fixture-daemon', 42, expect.any(Number));
  });

  it('marks older-head rulings superseded and detects unruled referrals before human review', () => {
    const comments = trusted([
      { body: 'Mandatory review owner: judge\nHead: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n- ["judge","x.mjs",1,"claim"]: referral\nRulings: []' },
      { body: 'Operator ruling\nHead: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nRulings: [{"key":"other","result":"not-real"}]' },
    ]);
    const text = render({ comments, pr: { ...fixture.pr, labels: [{ name: 'review:human' }] } });
    expect(text).toContain('(superseded)'); expect(text).toContain('Blocked on: referrals need a ruling');
  });

  it('only trusted evidence closes send-backs; fix-end without evidence stays blocked', () => {
    const change = trusted([fixture.comments[0]]);
    const evidence = { body: '<!-- addresses-operator-send-back: 101 -->', trusted: true };
    expect(render({ comments: [...change, evidence], pr: { ...fixture.pr, labels: [] } })).toContain('evidence: posted');
    expect(render({ comments: [...change, { body: 're-armed for re-review', trusted: false }] })).toContain('Blocked on: open send-back without evidence');
    expect(render({ comments: [...change, { body: 'fix-end', trusted: true }], pr: { ...fixture.pr, labels: [] } })).toContain('Blocked on: open send-back without evidence');
    expect(render({ comments: [], pr: { ...fixture.pr, labels: ['review:changes'] } })).toContain('Blocked on: open send-back without evidence');
  });

  it.each([
    ['review:human', 'human review required'],
    ['red', 'red-team confirmed break'],
    ['conflict', 'merge conflict'],
    ['failed', 'failing fix-loop outcome'],
    ['clear', 'nothing detected'],
    ['pushed', 'nothing detected'],
  ])('derives the %s blocker', (kind, result) => {
    const text = render({ pr: { ...fixture.pr, labels: kind === 'review:human' ? ['review:human'] : [] },
      comments: kind === 'red' ? trusted([fixture.comments[3]]) : kind === 'conflict' ? [{ body: 'CONFLICTING', trusted: true }] : [],
      ledger: ['failed', 'pushed'].includes(kind) ? [{ at: 'now', head: 'a'.repeat(40), outcome: kind }] : [] });
    expect(text).toContain(`Blocked on: ${result}`);
  });

  it('bounds six findings, truncates every line and strips terminal controls', () => {
    const comments = [{ trusted: true, body: `## review — accepted\n${Array.from({ length: 20 }, (_, i) => `- (edge-case, broken) \`src/${'x'.repeat(250)}:${i}\``).join('\n')}` }];
    const text = render({ comments, pr: { ...fixture.pr, title: '\u001b[31munsafe\u0000\n' + 'x'.repeat(500), labels: [] } });
    bounded(text); expect(text).not.toContain('\u001b');
    expect(text.split('\n').filter(l => l.startsWith('src/'))).toHaveLength(6);
  });

  it('reads encoded operator rulings and ignores old-head red-team blockers', () => {
    const original = { file: 'src/code.mjs', line: 4, summary: 'claim', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const key = referralFindingKey('judge', original);
    const record = { version: 1, repo: 'web-everything/web-everything', pr: 42, head: fixture.pr.headRefOid,
      runId: 'review', reviewer: mandatoryReferralReviewer('review'), authorBody: '', attempted: true,
      referrals: [{ key, seat: 'judge', original, finding: normalizeFinding(original) }], rulings: [] };
    const operator = { version: 1, repo: record.repo, pr: record.pr, head: record.head, actor: 'chalbert',
      channel: 'test', reason: 'verified', at: '2026-10-23T10:00:00Z', clearerId: '', rulings: [{ runId: record.runId, key, result: 'not-real' }] };
    const comments = trusted([
      { body: `Mandatory review owner: judge\n<!-- mandatory-referrals-v1: ${encodeURIComponent(JSON.stringify(record))} -->` },
      { body: buildOperatorRulingComment(operator) },
      { body: fixture.comments[3].body.replaceAll('a'.repeat(40), 'b'.repeat(40)) },
    ]);
    const text = render({ comments, pr: { ...fixture.pr, labels: [] } });
    expect(text).toContain('not-real=1'); expect(text).toContain('Blocked on: nothing detected');
  });

  it('reports malformed ruling evidence as incomplete and requiring a ruling', () => {
    const text = render({ pr: { ...fixture.pr, labels: [] }, comments: trusted([
      { body: 'Operator ruling\nRulings: [broken' },
    ]) });
    expect(text).toContain('incomplete; inspect GitHub thread');
    expect(text).toContain('Blocked on: referrals need a ruling');
  });
});


describe('digest IO regressions', () => {
  it('uses the shared schema validator on decoded operator records before clearing referrals', () => {
    const h = harness(); h.state.pr.labels = [];
    const key = '["judge","x",1,"claim"]';
    const record = { version: 1, repo: 'web-everything/web-everything', pr: 42, head: h.state.pr.headRefOid,
      rulings: [{ key, result: 'not-real' }] }; // Actor/run identity and required provenance are absent.
    h.state.comments = [
      { id: 1, author: { login: 'chalbert' }, body: `Mandatory review owner: judge\nHead: ${record.head}\n- ${key}: referral` },
      { id: 2, author: { login: 'chalbert' }, body: `Operator ruling\n<!-- mandatory-referral-operator-ruling-v1: ${Buffer.from(JSON.stringify(record)).toString('base64')} -->` },
    ];
    h.read(h.input);
    expect(readFileSync(h.path, 'utf8')).toContain('Blocked on: referrals need a ruling');
    expect(readFileSync(h.path, 'utf8')).toContain('incomplete; inspect GitHub thread');
  });
  it('leaves the previous complete digest and an invalid sidecar when a digest write fails partway', () => {
    let fail = false;
    const h = harness({ write: (path, text) => {
      writeFileSync(path, fail ? 'partial' : text);
      if (fail) throw new Error('interrupted digest write');
    } });
    h.read(h.input);
    const before = readFileSync(h.path, 'utf8');
    h.state.pr.title = 'Changed'; fail = true;
    expect(() => h.read(h.input)).toThrow('interrupted digest write');
    expect(readFileSync(h.path, 'utf8')).toBe(before);
    expect(readFileSync(`${h.path}.cache`, 'utf8')).toBe('');
    fail = false;
    expect(h.read(h.input).results[0].status).toBe('written');
  });
  it('filters ledger outcomes by repository before taking newest five', () => {
    const path = join(temp(), 'ledger');
    const row = { v: 1, session: 'fix-42', infra: false, head: 'a'.repeat(40), kind: 'outcome', repo: 'web-everything/web-everything', pr: 42, at: '2026-10-23T10:00:00Z', outcome: 'failed' };
    writeFileSync(path, [row, ...Array.from({ length: 6 }, () => ({ ...row, repo: 'other/repo', at: '2026-10-23T11:00:00Z', outcome: 'pushed' }))].map(JSON.stringify).join('\n'));
    expect(readDigestLedger(path, 42)).toEqual([row]);
  });
  it.each(['ledger', 'daemon'])('refuses an oversized %s line synchronously with a repair fallback', kind => {
    const path = join(temp(), kind);
    writeFileSync(path, 'x'.repeat(1024 * 1024 + 1));
    expect(() => kind === 'ledger' ? readDigestLedger(path, 42) : readDigestDaemon(path, 42, Date.now())).toThrow(/history line exceeds.*repair.*regenerating/);
  });
  it('accepts a history line at the byte ceiling and rejects a multibyte line over it', () => {
    const path = join(temp(), 'daemon');
    const prefix = '2026-10-23T10:00:00Z #42 ';
    const line = prefix + 'x'.repeat(HISTORY_LINE_MAX_BYTES - Buffer.byteLength(prefix));
    writeFileSync(path, `${line}\n`);
    expect(readDigestDaemon(path, 42, Date.parse('2026-10-23T11:00:00Z'))).toEqual([line]);
    writeFileSync(path, `${line.slice(0, -1)}🙂\n`);
    expect(() => readDigestDaemon(path, 42, Date.parse('2026-10-23T11:00:00Z'))).toThrow('history line exceeds');
  });
  it('atomically replaces digest and sidecar using distinct temporary files, sidecar last', () => {
    const writes = [];
    const h = harness({ write: (path, ...args) => { writes.push(path); writeFileSync(path, ...args); },
      writeCache: (path, ...args) => { writes.push(path); writeFileSync(path, ...args); } });
    h.read(h.input);
    expect(writes).toHaveLength(3);
    expect(writes.every(path => path !== h.path && path !== `${h.path}.cache`)).toBe(true);
    expect(new Set(writes).size).toBe(3);
    expect(readFileSync(`${h.path}.cache`, 'utf8')).toMatch(/^[a-f0-9]{64} [a-f0-9]{64}\n$/);
  });
  it('regenerates a mismatched pair after interleaved writers finish the sidecar out of order', () => {
    let interleave = false, calls = 0, h;
    const writeCache = (path, text, options) => {
      writeFileSync(path, text, options);
      if (interleave && ++calls === 2) {
        h.state.pr.title = 'Writer B';
        h.read(h.input);
        h.state.pr.title = 'Writer A';
      }
    };
    h = harness({ writeCache });
    h.state.comments = []; h.state.pr.labels = [];
    h.read(h.input);
    h.state.pr.title = 'Writer A'; interleave = true;
    h.read(h.input); interleave = false;
    expect(readFileSync(h.path, 'utf8')).toContain('Writer B');
    expect(h.read(h.input).results[0].status).toBe('written');
    expect(readFileSync(h.path, 'utf8')).toContain('Writer A');
    expect(h.read(h.input).results[0].status).toBe('cached');
  });
});

describe('second audit IO regressions', () => {
  it.each([1000, 1001])('refuses saturated --all coverage of %s with an operator fallback before writing', count => {
    const gh = vi.fn(() => JSON.stringify(Array.from({ length: count }, (_, i) => ({ number: i + 1 }))));
    const write = vi.fn(), makeDir = vi.fn();
    const read = createPrDigestReader({ gh, write, makeDir });
    expect(() => read({ all: true })).toThrow(/incomplete.*1000.*--pr/);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled(); expect(makeDir).not.toHaveBeenCalled();
  });
  it('refuses a structured card ruling without a card reference', () => {
    const h = harness(); h.state.pr.labels = [];
    const record = { version: 1, repo: 'web-everything/web-everything', pr: 42, head: h.state.pr.headRefOid,
      actor: 'chalbert', channel: 'test', reason: 'verified', at: '2026-10-23T10:00:00Z', clearerId: '',
      rulings: [{ runId: 'review', key: 'finding', result: 'card' }] };
    h.state.comments = [{ author: { login: 'chalbert' }, body: `<!-- mandatory-referral-operator-ruling-v1: ${Buffer.from(JSON.stringify(record)).toString('base64')} -->` }];
    h.read(h.input);
    expect(readFileSync(h.path, 'utf8')).toContain('incomplete; inspect GitHub thread');
    expect(readFileSync(h.path, 'utf8')).toContain('Blocked on: referrals need a ruling');
  });
});

it.each([undefined, 'pending', 'failed'])('does not print a complete-looking count for an unapplied digest effect (%s)', status => {
  const result = finishPrDigest({ run: { effects: status ? [{ type: PR_DIGEST_EFFECT, status }] : [] }, code: 0, lines: [] });
  expect(result.code).toBe(1);
  expect(result.lines.join(' ')).toContain('incomplete');
});
it('wires digest generation through the production sink factory', () => {
  expect(Object.keys(createPrDigestSinks())).toEqual([PR_DIGEST_EFFECT]);
});

it('returns non-zero and incomplete coverage through the writing effect when --all saturates', async () => {
  const gh = vi.fn(() => JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ number: i + 1 }))));
  const write = vi.fn(), makeDir = vi.fn();
  const declaration = prDigestOperation(), registry = createRegistry();
  registry.register(declaration);
  const outcome = await runOperationCli({ declaration, argv: ['--all'], registry, store: createMemoryRunStore(),
    sinks: createPrDigestSinks({ gh, write, makeDir }), newRunId: () => 'digest-incomplete' });
  expect(outcome.code).not.toBe(0);
  expect(outcome.run.effects[0].status).toBe('failed');
  expect(outcome.run.effects[0].error).toMatch(/incomplete coverage.*--pr/);
  expect(finishPrDigest(outcome).code).not.toBe(0);
  expect(write).not.toHaveBeenCalled(); expect(makeDir).not.toHaveBeenCalled();
});

it.each([undefined, 2, 3, 4, 5])('regenerates persisted legacy cache evidence after ruling semantics change (schema %s)', schema => {
  const h = harness({ readComments: () => structuredClone(fixture.comments) });
  const hash = text => createHash('sha256').update(text).digest('hex');
  const stale = `${cacheHeader(fixture.pr.headRefOid, 104)}\nBlocked on: nothing detected\n`;
  const oldFingerprint = hash(JSON.stringify({ ...(schema === undefined ? {} : { schema }), pr: fixture.pr, lastComment: '104', ledger: [], daemon: [],
    comments: trusted(fixture.comments) }));
  writeFileSync(h.path, stale);
  writeFileSync(`${h.path}.cache`, `${oldFingerprint} ${hash(stale)}\n`);
  expect(h.read(h.input).results[0].status).toBe('written');
  expect(readFileSync(h.path, 'utf8')).toContain('Blocked on: open send-back without evidence');
});


const completeOutcome = { v: 1, kind: 'outcome', repo: 'web-everything/web-everything', pr: 42,
  at: '2026-10-23T10:00:00Z', outcome: 'failed', head: 'a'.repeat(40), session: 'fix-42', infra: false };
describe('third audit reader regressions', () => {
  it.each(['', 'success', 'unknown', undefined, null])('rejects unsupported ledger outcome %j as incomplete evidence', outcome => {
    const path = join(temp(), 'ledger');
    writeFileSync(path, JSON.stringify({ ...completeOutcome, outcome }));
    expect(() => readDigestLedger(path, 42)).toThrow(/incomplete.*repair.*ledger/);
  });
  it.each(['v', 'session', 'head', 'infra', 'at'])('rejects incomplete ledger rows missing %s', field => {
    const path = join(temp(), 'ledger'), row = { ...completeOutcome };
    delete row[field]; writeFileSync(path, JSON.stringify(row));
    expect(() => readDigestLedger(path, 42)).toThrow(/incomplete.*repair.*ledger/);
  });
  it.each(['pushed', 'no-change', 'failed'])('accepts supported complete ledger outcome %s', outcome => {
    const path = join(temp(), 'ledger'), row = { ...completeOutcome, outcome };
    writeFileSync(path, JSON.stringify(row)); expect(readDigestLedger(path, 42)).toEqual([row]);
  });
  it('stops --all at 100 full-thread reads and reports the remaining count with non-zero CLI status', async () => {
    const readComments = vi.fn(() => []), readLatest = vi.fn(() => '0');
    const h = harness({ readComments, readLatest });
    const gh = vi.fn((args, opts) => args[1] === 'list'
      ? JSON.stringify(Array.from({ length: 102 }, (_, i) => ({ number: i + 1 }))) : h.gh(args, opts));
    const declaration = prDigestOperation(), registry = createRegistry(); registry.register(declaration);
    const outcome = await runOperationCli({ declaration, argv: ['--all', `--out-dir=${h.out}`], registry,
      store: createMemoryRunStore(), sinks: createPrDigestSinks({ gh, readComments, readLatest,
        readLedger: () => [], readDaemon: () => [] }), newRunId: () => 'digest-budget' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.run.effects[0].status).toBe('failed');
    expect(outcome.run.effects[0].error).toMatch(/incomplete.*budget exhausted, 2 PRs not processed.*--pr/);
    expect(finishPrDigest(outcome).code).not.toBe(0);
    expect(finishPrDigest(outcome).lines.join(' ')).toContain('budget exhausted, 2 PRs not processed');
    expect(readComments).toHaveBeenCalledTimes(100);
    expect(readLatest).toHaveBeenCalledTimes(100);
    expect(gh.mock.calls.filter(([args]) => args[1] === 'view')).toHaveLength(100);
  });
});

it.each([{}, null, [], '', { kind: 'outcome' }, { ...completeOutcome, pr: '42' }])('fails closed on empty or unidentifiable ledger evidence %j', row => {
  const path = join(temp(), 'ledger'); writeFileSync(path, JSON.stringify(row));
  expect(() => readDigestLedger(path, 42)).toThrow(/incomplete.*repair.*ledger/);
});
it('fails the writing effect without writing a digest for an unknown ledger outcome', async () => {
  const h = harness({ readLedger: readDigestLedger });
  const ledger = join(h.out, 'ledger'); writeFileSync(ledger, JSON.stringify({ ...completeOutcome, outcome: 'unknown' }));
  const declaration = prDigestOperation(), registry = createRegistry(); registry.register(declaration);
  const outcome = await runOperationCli({ declaration, argv: ['--pr=42', `--ledger=${ledger}`], registry,
    store: createMemoryRunStore(), sinks: { [PR_DIGEST_EFFECT]: h.read }, newRunId: () => 'digest-invalid-ledger' });
  expect(outcome.code).not.toBe(0);
  expect(outcome.run.effects[0].error).toContain('incomplete outcome');
  expect(h.write).not.toHaveBeenCalled();
});
it.each(['quoted', 'edited', 'trailer moved'])('production reader refuses %s clearance', kind => {
  const h = harness(); h.state.pr.labels = [];
  const key = '["judge","x",1,"claim"]';
  const record = { version: 1, repo: 'web-everything/web-everything', pr: 42, head: h.state.pr.headRefOid,
    actor: 'chalbert', channel: 'test', reason: 'verified', at: '2026-10-23T10:00:00Z', clearerId: '',
    rulings: [{ runId: 'review', key, result: 'block' }] };
  const clear = buildOperatorRulingComment({ ...record, rulings: [{ runId: 'review', key, result: 'not-real' }] });
  const body = kind === 'quoted' ? `> ${clear.replaceAll('\n', '\n> ')}`
    : kind === 'edited' ? clear.replace('verified', 'unverified') : `${clear}\nAdded note`;
  h.state.comments = [buildOperatorRulingComment(record), body].map((body, i) => ({ id: i + 1, author: { login: 'chalbert' }, body }));
  h.read(h.input); expect(readFileSync(h.path, 'utf8')).toContain('Blocked on: blocking ruling');
});

it('completes exactly 100 PRs and resets the full-thread budget for the next invocation, including cached reads', () => {
  const h = harness(), readComments = vi.fn(() => []);
  const gh = vi.fn((args, opts) => args[1] === 'list'
    ? JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }))) : h.gh(args, opts));
  const read = createPrDigestReader({ gh, readComments, readLatest: () => '0', readLedger: () => [], readDaemon: () => [] });
  const input = { all: true, 'out-dir': h.out };
  expect(read(input).results).toHaveLength(100);
  const result = read(input);
  expect(result.results).toHaveLength(100);
  expect(result.results.every(r => r.status === 'cached')).toBe(true);
  expect(readComments).toHaveBeenCalledTimes(200);
  expect(finishPrDigest({ run: { effects: [{ type: PR_DIGEST_EFFECT, status: 'applied', result }] }, code: 0, lines: [] }).code).toBe(0);
});
