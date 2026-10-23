// @vitest-environment node
/** Hermetic PR digest fixtures: cache, bounded rendering, paginated reads and chunked local evidence. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrDigestReader, readDigestLedger, readDigestDaemon, readLatestCommentId, COMMENTS_MAX_BUFFER } from '../pr-digest-io.mjs';
import { cacheHeader, finishPrDigest, prDigestOperation, renderPrDigest } from '../pr-digest.mjs';
import { parseOperationArgv } from '../cli-adapter.mjs';
import { advance, startRun } from '../engine.mjs';
import { createRegistry } from '../registry.mjs';
import { hugeThread } from '../__fixtures__/pr-digest/huge-thread.mjs';

const fixture = JSON.parse(readFileSync(new URL('../__fixtures__/pr-digest/thread.json', import.meta.url), 'utf8'));
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
    if (args.includes('--include')) return `HTTP/2.0 200 OK\r\nLink: <https://api.github.com/comments?per_page=1&page=2>; rel="last"\r\n\r\n${JSON.stringify([state.comments[0]])}`;
    if (args.includes('--paginate')) return state.comments.map(c => [c.body, '2026-10-23T10:00:00Z', c.author.login, `IC_${c.id}`, ''].map(tsv).join('\t')).join('\n');
    if (args.includes('--jq')) return String(state.comments.at(-1)?.id ?? 0);
    throw new Error('unexpected gh invocation');
  });
  const write = vi.fn(writeFileSync);
  const writeCache = vi.fn(writeFileSync);
  const readLedger = vi.fn(() => []), readDaemon = vi.fn(() => []);
  const read = createPrDigestReader({ gh, write, writeCache, readLedger, readDaemon, ...options });
  return { state, gh, write, writeCache, readLedger, readDaemon, read, input: { pr: 42, 'out-dir': out }, path: join(out, 'pr-42.md'), out };
}
const render = (extra = {}) => renderPrDigest({ pr: fixture.pr, comments: trusted(fixture.comments), lastComment: 104, ...extra });

function bounded(text) {
  expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(60);
  expect(text.trimEnd().split('\n').every(l => l.length <= 200)).toBe(true);
}

describe('pr-digest', () => {
  it('synchronously writes and caches digests through compute, persisted findings and assess', () => {
    const h = harness();
    const out = join(h.out, 'nested', 'digests');
    const path = join(out, 'pr-42.md');
    const registry = createRegistry();
    const declaration = prDigestOperation({ readDigest: h.read });
    registry.register(declaration);
    expect(declaration.verdictFrom).toBe('assess');
    for (const status of ['written', 'cached']) {
      let run = startRun({ op: declaration.name, id: `digest-${status}`, input: { ...h.input, 'out-dir': out }, registry });
      run = advance(run, { registry });
      const expected = { results: [{ pr: 42, path, status }], all: false };
      expect(run.findings.read).toEqual(expected);
      expect(readFileSync(path, 'utf8').split('\n')[0]).toBe(cacheHeader(fixture.pr.headRefOid, 104));
      run = advance(JSON.parse(JSON.stringify(run)), { registry });
      expect(run.verdict).toEqual(expected);
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
    expect(h.gh.mock.calls.filter(([args]) => args.includes('--paginate'))).toHaveLength(1);
    expect(h.readLedger).toHaveBeenCalledTimes(1); expect(h.readDaemon).toHaveBeenCalledTimes(1);
  });

  it('regenerates a corrected ruling edited in place without changing any comment ID or HEAD', () => {
    const h = harness();
    h.state.pr.labels = [];
    h.state.comments = [structuredClone(fixture.comments[1]), { id: 104, body: 'Routine progress', author: { login: 'chalbert' } }];
    const ids = h.state.comments.map(c => c.id);
    h.read(h.input);
    const before = readFileSync(h.path, 'utf8');
    expect(before).toContain('not-real=0 card=1 block=0');
    expect(h.read(h.input).results[0].status).toBe('cached');
    h.state.comments[0].body = h.state.comments[0].body.replace('"result":"card"', '"result":"not-real"');
    expect(h.state.comments.map(c => c.id)).toEqual(ids);
    expect(h.read(h.input).results[0].status).toBe('written');
    const after = readFileSync(h.path, 'utf8');
    expect(after.split('\n')[0]).toBe(before.split('\n')[0]);
    expect(after).toContain('not-real=1 card=0 block=0');
    expect(after).not.toContain('not-real=0 card=1 block=0');
    expect(h.read(h.input).results[0].status).toBe('cached');
    expect(h.write).toHaveBeenCalledTimes(2);
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
    if (kind === 'ledger') writeFileSync(input.ledger, JSON.stringify({ kind: 'outcome', pr: 42, at: '2026-10-23T10:00:00Z', outcome: 'failed', reason: 'new local outcome' }));
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
    const call = h.gh.mock.calls.find(([args]) => args.includes('--paginate'));
    expect(call[1].maxBuffer).toBe(COMMENTS_MAX_BUFFER);
  });

  it('processes --all sequentially and formats per-PR statuses and the final count', () => {
    const h = harness();
    const verdict = h.read({ all: true, 'out-dir': h.out });
    expect(verdict.results.map(r => r.pr)).toEqual([42, 43]);
    const calls = h.gh.mock.calls.map(([args]) => args);
    expect(calls.findIndex(a => a.includes('--paginate'))).toBeLessThan(calls.findIndex(a => a[1] === 'view' && a[2] === '43'));
    expect(finishPrDigest({ run: { verdict }, code: 0, lines: [] }).lines).toEqual(['#42 written', '#43 written', '2 PRs: 2 written, 0 cached']);
    expect(finishPrDigest({ run: { verdict: { ...verdict, all: false } }, code: 0, lines: [] }).lines[0]).toBe(`${h.path} written`);
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

  it('rejects malformed latest metadata instead of assuming an empty thread', () => {
    expect(() => readLatestCommentId(42, () => 'not HTTP')).toThrow('invalid comments metadata');
    expect(() => readLatestCommentId(42, () => 'HTTP/2.0 200 OK\n\n{}')).toThrow('invalid latest comments page');
    expect(readLatestCommentId(42, () => 'HTTP/2.0 200 OK\n\n[]')).toBe('0');
  });

  it('keeps newest five ledger outcomes for this PR and filters daemon timestamps and PR boundaries', () => {
    const dir = temp(), ledger = join(dir, 'ledger.jsonl'), log = join(dir, 'daemon.log');
    const at = i => `2026-10-23T10:0${i}:00Z`;
    const records = Array.from({ length: 9 }, (_, i) => ({ kind: 'outcome', pr: 42, at: at(i), outcome: 'failed', head: 'a'.repeat(40), reason: 'x'.repeat(20_000) }));
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
    const prefix = '{"kind":"outcome","pr":42,"at":"2026-10-23T10:00:00Z","outcome":"failed","reason":"';
    const reason = `${'x'.repeat(64 * 1024 - 1 - Buffer.byteLength(prefix))}🙂${'y'.repeat(70_000)}`;
    const row = { kind: 'outcome', pr: 42, at: '2026-10-23T10:00:00Z', outcome: 'failed', reason };
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
    writeFileSync(ledger, JSON.stringify({ kind: 'outcome', pr: 42, at: 'invalid', outcome: 'failed' }));
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

  it('evidence and rearm close send-backs; untrusted markers cannot close them', () => {
    const change = trusted([fixture.comments[0]]);
    const evidence = { body: '## 🔧 fix-1 — evidence', trusted: true };
    expect(render({ comments: [...change, evidence], pr: { ...fixture.pr, labels: [] } })).toContain('evidence: posted');
    expect(render({ comments: [...change, { body: 're-armed for re-review', trusted: false }] })).toContain('Blocked on: open send-back without evidence');
    expect(render({ comments: [...change, { body: 'fix-end', trusted: true }], pr: { ...fixture.pr, labels: [] } })).toContain('Blocked on: nothing detected');
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

  it('rejects missing, conflicting and invalid PR selectors before reading GitHub', () => {
    const reader = vi.fn();
    const declaration = prDigestOperation({ readDigest: reader });
    for (const input of [{}, { pr: 42, all: true }, { pr: -1 }, { pr: 1.5 }]) {
      expect(() => declaration.steps[0].step.fn({ input })).toThrow('supply exactly one');
    }
    expect(reader).not.toHaveBeenCalled();
  });

  it('reads encoded operator rulings and ignores old-head red-team blockers', () => {
    const key = JSON.stringify(['judge', 'src/code.mjs', 4, 'claim']);
    const record = { head: fixture.pr.headRefOid, referrals: [{ key }], rulings: [] };
    const operator = { head: fixture.pr.headRefOid, rulings: [{ key, result: 'not-real' }] };
    const comments = trusted([
      { body: `Mandatory review owner: judge\n<!-- mandatory-referrals-v1: ${encodeURIComponent(JSON.stringify(record))} -->` },
      { body: `Operator ruling\n<!-- mandatory-referral-operator-ruling-v1: ${Buffer.from(JSON.stringify(operator)).toString('base64')} -->` },
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

  it('declares CLI flags for single PR, --all and path overrides', () => {
    const declaration = prDigestOperation({ readDigest: () => ({ results: [] }) });
    const parsed = parseOperationArgv(declaration, ['--pr=42', '--out-dir=digests', '--ledger=ledger', '--daemon-log=daemon']);
    expect(parsed.ok).toBe(true); expect(parsed.input.pr).toBe(42);
    expect(parseOperationArgv(declaration, ['--all']).input.all).toBe(true);
  });
});
