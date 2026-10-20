/**
 * @file referral-card-memo.test.mjs — the only cache in referral-card-readable is a bounded memo of card TEXT keyed by
 *   (repo, file, commit sha). Every verdict is compared against the PRE-CHANGE implementation, kept verbatim in
 *   referral-card-readable.old.fixture.mjs (a copy of 2d16b951c's file).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as next from '../referral-card-readable.mjs';
import * as old from './referral-card-readable.old.fixture.mjs';

const CARD = '---\nstatus: open\n---\n# card\n';
const SHA = 'c'.repeat(40);
const SHA2 = 'd'.repeat(40);
const quiet = () => {};

/** A scriptable fake gh. `meta` may be a function of the call number so a PR can change between calls. */
function fakeGh({ meta = { state: 'OPEN', headRefOid: SHA, baseRefName: 'main' }, text = CARD, fail = false, rawMeta } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args[0]);
    if (fail) throw new Error('gh down');
    if (args[0] === 'pr') return rawMeta ?? JSON.stringify(typeof meta === 'function' ? meta(calls.filter(c => c === 'pr').length) : meta);
    return typeof text === 'function' ? text(args) : text;
  };
  return { run, calls };
}
const outcome = fn => { try { return { value: fn() }; } catch (e) { return { threw: e.constructor.name }; } };

describe('readCardAtPrHead: memo vs the old code', () => {
  const scenarios = {
    'open with card': {},
    'closed': { meta: { state: 'CLOSED', headRefOid: SHA, baseRefName: 'main' } },
    'merged': { meta: { state: 'MERGED', headRefOid: SHA, baseRefName: 'main' } },
    'side-branch base': { meta: { state: 'OPEN', headRefOid: SHA, baseRefName: 'feature/x' } },
    'bad head sha': { meta: { state: 'OPEN', headRefOid: 'nope', baseRefName: 'main' } },
    'gh outage': { fail: true },
    'null response': { rawMeta: 'null' },
    'garbage response': { rawMeta: 'not json' },
    'contents is not a string': { text: () => null },
  };
  for (const [name, spec] of Object.entries(scenarios)) {
    it(`same outcome, cold and warm: ${name}`, () => {
      const want = outcome(() => old.readCardAtPrHead('x1.md', '7', { run: fakeGh(spec).run }));
      const memo = next.createCardTextMemo();
      for (let i = 0; i < 3; i++) {
        expect(outcome(() => next.readCardAtPrHead('x1.md', '7', { run: fakeGh(spec).run, memo, log: quiet }))).toEqual(want);
      }
    });
  }
  it('a warm memo does not hide a later outage, null response, close or base change (pr view is always asked fresh)', () => {
    const memo = next.createCardTextMemo();
    expect(next.readCardAtPrHead('x1.md', '7', { run: fakeGh().run, memo, log: quiet })).toBe(CARD);
    for (const spec of [{ fail: true }, { rawMeta: 'null' }, { meta: { state: 'CLOSED', headRefOid: SHA, baseRefName: 'main' } },
      { meta: { state: 'OPEN', headRefOid: SHA, baseRefName: 'other' } }, { meta: { state: 'OPEN', headRefOid: 'zz', baseRefName: 'main' } }]) {
      const want = outcome(() => old.readCardAtPrHead('x1.md', '7', { run: fakeGh(spec).run }));
      expect(outcome(() => next.readCardAtPrHead('x1.md', '7', { run: fakeGh(spec).run, memo, log: quiet }))).toEqual(want);
    }
  });
  it('N reads of one ref at one sha cost N pr views but one contents read', () => {
    const g = fakeGh(); const memo = next.createCardTextMemo();
    for (let i = 0; i < 10; i++) expect(next.readCardAtPrHead('x1.md', '7', { run: g.run, memo, log: quiet })).toBe(CARD);
    expect(g.calls.filter(c => c === 'pr')).toHaveLength(10);
    expect(g.calls.filter(c => c === 'api')).toHaveLength(1);
  });
  it('a new head sha is a new key: the new text is read, as in the old code', () => {
    const memo = next.createCardTextMemo();
    next.readCardAtPrHead('x1.md', '7', { run: fakeGh().run, memo, log: quiet });
    const spec = { meta: { state: 'OPEN', headRefOid: SHA2, baseRefName: 'main' }, text: '---\nv: 2\n---\n' };
    expect(next.readCardAtPrHead('x1.md', '7', { run: fakeGh(spec).run, memo, log: quiet }))
      .toBe(old.readCardAtPrHead('x1.md', '7', { run: fakeGh(spec).run }));
  });
  it('a failed contents read is not stored: it throws each time, then a good read works', () => {
    const memo = next.createCardTextMemo(); let n = 0;
    const flaky = fakeGh({ text: () => { if (n++ < 2) throw new Error('404'); return CARD; } });
    expect(() => next.readCardAtPrHead('x1.md', '7', { run: flaky.run, memo, log: quiet })).toThrow();
    expect(() => next.readCardAtPrHead('x1.md', '7', { run: flaky.run, memo, log: quiet })).toThrow();
    expect(next.readCardAtPrHead('x1.md', '7', { run: flaky.run, memo, log: quiet })).toBe(CARD);
    expect(memo.text.size).toBe(1);
  });
  it('the memo is bounded', () => {
    const memo = next.createCardTextMemo({ max: 3 }); const g = fakeGh();
    for (let i = 0; i < 10; i++) next.readCardAtPrHead(`x${i}.md`, '7', { run: g.run, memo, log: quiet });
    expect(memo.text.size).toBe(3);
  });
  it('without a memo (an injected runner, no memo passed) nothing is cached', () => {
    const g = fakeGh();
    next.readCardAtPrHead('x1.md', '7', { run: g.run, log: quiet });
    next.readCardAtPrHead('x1.md', '7', { run: g.run, log: quiet });
    expect(g.calls).toEqual(['pr', 'api', 'pr', 'api']);
  });
  it('emits enrich-timing lines for the gh stages', () => {
    const lines = [];
    next.readCardAtPrHead('x1.md', '7', { run: fakeGh().run, memo: next.createCardTextMemo(), log: l => lines.push(l) });
    expect(lines.map(l => l.replace(/ \d+$/, ''))).toEqual(['enrich-timing: referral-card-gh-pr-view', 'enrich-timing: referral-card-gh-contents']);
    expect(lines[0]).toMatch(/^enrich-timing: \S+ \d+$/);
  });
});

describe('referralCardReadable: same verdicts as the old code', () => {
  const root = mkdtempSync(join(tmpdir(), 'card-memo-'));
  mkdirSync(join(root, 'backlog'));
  writeFileSync(join(root, 'backlog', '5100-landed.md'), '---\nbornAs: xvm9vbu\n---\n# c\n');
  writeFileSync(join(root, 'backlog', '5101-nofm.md'), 'bornAs: xaaaaaa\n');
  writeFileSync(join(root, 'backlog', 'xhere01-main.md'), CARD);
  const refs = ['we:backlog/5100-landed.md', 'we:backlog/xvm9vbu-whatever.md', 'we:backlog/xaaaaaa-nofm.md', 'we:backlog/xzzzzzz-ghost.md',
    'we:backlog/xhere01-main.md', 'we:backlog/xsjn0uf-gate.md@pr7', 'we:backlog/xsjn0uf-gate.md@pr8', 'we:backlog/a.md@pr0', 'bad', '', undefined];
  it('agrees on every ref, with a good gh, a failing gh and a null response', () => {
    for (const spec of [{}, { fail: true }, { rawMeta: 'null' }, { meta: { state: 'CLOSED', headRefOid: SHA, baseRefName: 'main' } }]) {
      const memo = next.createCardTextMemo();
      for (let pass = 0; pass < 2; pass++) {
        for (const ref of refs) {
          const want = old.referralCardReadable(ref, root, { readOnPr: (f, p) => old.readCardAtPrHead(f, p, { run: fakeGh(spec).run }) });
          const got = next.referralCardReadable(ref, root, { readOnPr: (f, p) => next.readCardAtPrHead(f, p, { run: fakeGh(spec).run, memo, log: quiet }) });
          expect(got, `${ref} ${JSON.stringify(spec)} pass ${pass}`).toBe(want);
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
});
