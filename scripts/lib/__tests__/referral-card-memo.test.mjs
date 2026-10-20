/**
 * @file referral-card-memo.test.mjs — the per-process read memo in referral-card-readable: same verdicts as the
 *   uncached path, far fewer reads, errors never cached, head lookups expire, the backlog index follows main.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutHeadSha, createCardReadCache, readCardAtPrHead, referralCardReadable, _resetBornIndexCache } from '../referral-card-readable.mjs';

const CARD = '---\nstatus: open\n---\n# card\n';
const SHA = 'c'.repeat(40);
const SHA2 = 'd'.repeat(40);
const quiet = () => {};

function fakeGh(state = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args[0]);
    if (state.fail) throw new Error('gh down');
    if (args[0] === 'pr') return JSON.stringify({ state: 'OPEN', headRefOid: state.sha ?? SHA, baseRefName: 'main' });
    return state.text ?? CARD;
  };
  return { run, calls };
}
const mkRoot = () => { const r = mkdtempSync(join(tmpdir(), 'card-memo-')); mkdirSync(join(r, 'backlog')); return r; };

describe('readCardAtPrHead memo', () => {
  it('N lookups of one ref cost one pr view and one contents read, with identical results to no cache', () => {
    const cached = fakeGh(); const plain = fakeGh();
    const cache = createCardReadCache();
    const a = Array.from({ length: 10 }, () => readCardAtPrHead('x1.md', '7', { run: cached.run, cache, log: quiet }));
    const b = Array.from({ length: 10 }, () => readCardAtPrHead('x1.md', '7', { run: plain.run, cache: null, log: quiet }));
    expect(a).toEqual(b);
    expect(cached.calls).toEqual(['pr', 'api']);
    expect(plain.calls).toHaveLength(20);
  });
  it('a different head sha is a different content key (immutable-input keying)', () => {
    const g = fakeGh(); const cache = createCardReadCache();
    readCardAtPrHead('x1.md', '7', { run: g.run, cache, log: quiet });
    cache.now = () => Date.now() + 120_000; // head entry expired
    const g2 = fakeGh({ sha: SHA2, text: '---\nv: 2\n---\n' });
    expect(readCardAtPrHead('x1.md', '7', { run: g2.run, cache, log: quiet })).toBe('---\nv: 2\n---\n');
    expect(g2.calls).toEqual(['pr', 'api']);
  });
  it('the pr-view answer expires after the TTL, so a changed PR is re-read', () => {
    let t = 1000; const cache = createCardReadCache({ now: () => t, headTtlMs: 60_000 });
    const g = fakeGh();
    readCardAtPrHead('x1.md', '7', { run: g.run, cache, log: quiet });
    t += 59_000; readCardAtPrHead('x1.md', '7', { run: g.run, cache, log: quiet });
    expect(g.calls).toEqual(['pr', 'api']);
    t += 2_000; readCardAtPrHead('x1.md', '7', { run: g.run, cache, log: quiet });
    expect(g.calls).toEqual(['pr', 'api', 'pr']); // content at the same sha is still memoised
  });
  it('errors are not cached: a failing read throws every time, and a later success works', () => {
    const cache = createCardReadCache(); const bad = fakeGh({ fail: true });
    for (let i = 0; i < 3; i++) expect(() => readCardAtPrHead('x1.md', '7', { run: bad.run, cache, log: quiet })).toThrow();
    expect(bad.calls).toHaveLength(3);
    const ok = fakeGh();
    expect(readCardAtPrHead('x1.md', '7', { run: ok.run, cache, log: quiet })).toBe(CARD);
    const ref = f => referralCardReadable(`we:backlog/${f}@pr7`, '/nonexistent', { readOnPr: (file, pr) => readCardAtPrHead(file, pr, { run: bad.run, cache: createCardReadCache(), log: quiet }) });
    expect(ref('x1.md')).toBe(false); // fail-closed, as before
  });
  it('content memo is bounded', () => {
    const cache = createCardReadCache({ contentMax: 3 }); const g = fakeGh();
    for (let i = 0; i < 10; i++) readCardAtPrHead(`x${i}.md`, '7', { run: g.run, cache, log: quiet });
    expect(cache.content.size).toBe(3);
  });
  it('emits enrich-timing lines for the gh stages', () => {
    const lines = []; const g = fakeGh();
    readCardAtPrHead('x1.md', '7', { run: g.run, cache: createCardReadCache(), log: l => lines.push(l) });
    expect(lines.map(l => l.replace(/ \d+$/, ''))).toEqual(['enrich-timing: referral-card-gh-pr-view', 'enrich-timing: referral-card-gh-contents']);
    expect(lines[0]).toMatch(/^enrich-timing: \S+ \d+$/);
  });
});

describe('backlog bornAs index', () => {
  it('gives the old verdicts, builds once per main sha, and rebuilds when main moves', () => {
    _resetBornIndexCache();
    const root = mkRoot();
    mkdirSync(join(root, '.git'));
    const setSha = sha => writeFileSync(join(root, '.git', 'HEAD'), `${sha}\n`);
    setSha(SHA);
    writeFileSync(join(root, 'backlog', '5100-landed.md'), '---\nbornAs: xvm9vbu\n---\n# c\n');
    writeFileSync(join(root, 'backlog', '5101-nofm.md'), 'bornAs: xaaaaaa\n');
    expect(checkoutHeadSha(root)).toBe(SHA);
    const lines = []; const log = l => lines.push(l);
    const q = ref => referralCardReadable(ref, root, { log });
    for (let i = 0; i < 5; i++) {
      expect(q('we:backlog/xvm9vbu-whatever.md')).toBe(true);
      expect(q('we:backlog/xaaaaaa-nofm.md')).toBe(false); // no frontmatter -> not a card
      expect(q('we:backlog/xzzzzzz-ghost.md')).toBe(false);
    }
    expect(lines.filter(l => l.includes('backlog-index'))).toHaveLength(1);
    // main moves (new landed card + new sha) -> rebuilt
    writeFileSync(join(root, 'backlog', '5102-new.md'), '---\nbornAs: "xnew001"\n---\n');
    setSha(SHA2);
    expect(q('we:backlog/xnew001-n.md')).toBe(true);
    expect(lines.filter(l => l.includes('backlog-index'))).toHaveLength(2);
    rmSync(root, { recursive: true, force: true });
  });
  it('without a resolvable sha nothing is cached (every lookup sees the current disk)', () => {
    _resetBornIndexCache();
    const root = mkRoot();
    const q = () => referralCardReadable('we:backlog/xnew001-n.md', root, { log: quiet });
    expect(q()).toBe(false);
    writeFileSync(join(root, 'backlog', '5102-new.md'), '---\nbornAs: xnew001\n---\n');
    expect(q()).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
  it('an unreadable card falls back to the original scan verdict', () => {
    _resetBornIndexCache();
    const root = mkRoot();
    mkdirSync(join(root, 'backlog', '5000-dir.md')); // readFileSync on a directory throws
    expect(referralCardReadable('we:backlog/xnew001-n.md', root, { log: quiet })).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
