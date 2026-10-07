import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractRefs, prMentionsItem, mergedSlices, assessItem, wordStems, stripHtmlComments } from '../held-cards-check.mjs';
import { main } from '../held-cards-io.mjs';

const none = { paths: [], symbols: [], prs: [], mentions: [], slicesDone: new Map(), commits: [] };

describe('held-cards staleness check (pure)', () => {
  it('extracts paths, symbols, PRs and slices from free text', () => {
    const refs = extractRefs('(#4017 follow-up) we:scripts/held-cards-io.mjs:102 and worker-brief.mjs; `sweepAdvisoryLabels()` plus `x y`; Build S1..S10 #4222');
    expect(refs.paths).toEqual(['scripts/held-cards-io.mjs']);
    expect(refs.bareFiles).toEqual(['worker-brief.mjs']);
    expect(refs.symbols).toEqual(['sweepAdvisoryLabels']);
    expect(refs.prs).toEqual([4017, 4222]);
    expect(refs.slices).toEqual(['S1', 'S10']);
  });
  it('recognises a merged PR that names the item, not other numbers', () => {
    expect(prMentionsItem(76, { title: '76a: one finding identity' })).toMatch(/^title/);
    expect(prMentionsItem(89, { title: 'Card 89 S5: versioned tick' })).toMatch(/^title/);
    expect(prMentionsItem(90, { title: 'hardening (items 90-93)' })).toMatch(/^title/);
    expect(prMentionsItem(92, { title: 'hardening', body: 'held items 90-93' })).toMatch(/^body/);
    expect(prMentionsItem(7, { title: 'Card 76: x', body: 'item 17, 270' })).toBeNull();
    expect(mergedSlices(89, [{ number: 4222, title: 'Card 89 S5: tick' }, { number: 1, title: 'Card 8 S1' }]).get('S5')).toBe(4222);
  });
  it('maps evidence to likely-done, partly-done and not-started', () => {
    const item = { num: 76, title: 't' };
    const refs = { slices: [] };
    const mention = { number: 4069, title: '76a: x', why: 'title "76a: x"' };
    expect(assessItem(item, refs, { ...none, mentions: [mention] }).verdict).toBe('likely-done');
    expect(assessItem(item, refs, { ...none, mentions: [{ ...mention, why: 'body "item 76"' }] }).verdict).toBe('partly-done');
    expect(assessItem(item, refs, { ...none, symbols: [{ name: 'a', found: true }, { name: 'b', found: false }] }).verdict).toBe('partly-done');
    expect(assessItem(item, refs, { ...none, prs: [{ number: 5, state: 'MERGED' }] }).verdict).toBe('not-started');
    const slices = new Map([['S5', 1]]);
    expect(assessItem(item, { slices: ['S5', 'S6'] }, { ...none, slicesDone: slices }).verdict).toBe('partly-done');
    expect(assessItem(item, { slices: ['S5'] }, { ...none, slicesDone: slices }).verdict).toBe('likely-done');
    expect(assessItem(item, refs, { ...none, commits: [{ subject: 's', shared: ['a'], strong: true }] }).verdict).toBe('likely-done');
    expect(wordStems('filing filers file')).toEqual(new Set(['fil']));
  });
});

describe('held-cards-io check', () => {
  it('flags a done item, leaves the list untouched, runs only read commands', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-check-'));
    const list = path.join(dir, 'cards.md');
    const md = '1. **Rulings.** scripts/lib/jury-core.mjs `findingId`\n2. **Other.** nothing here\n';
    fs.writeFileSync(list, md);
    const calls = [], out = [];
    const exec = (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === 'gh') return JSON.stringify([{ number: 9, title: '1a: rulings stick', body: '' }]);
      if (args.includes('ls-tree')) return 'scripts/lib/jury-core.mjs\n';
      if (args.includes('grep')) throw new Error('not found');
      return '';
    };
    const code = await main(['check', '--no-fetch'], { env: { WE_HELD_CARDS_PATH: list }, exec,
      stdout: { write: s => out.push(s) }, stderr: { write: s => out.push(s) } });
    const text = out.join('');
    expect(code).toBe(0);
    expect(text).toMatch(/HEURISTIC/);
    expect(text).toMatch(/1\. LIKELY-DONE/);
    expect(text).toMatch(/2\. NOT-STARTED/);
    expect(fs.readFileSync(list, 'utf8')).toBe(md);
    expect(calls.every(([bin, ...a]) => bin === 'gh' ? a[0] === 'pr' && ['list', 'view'].includes(a[1]) : !a.some(x => ['add', 'commit', 'push', 'checkout'].includes(x)))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('stripHtmlComments (CodeQL incomplete multi-character sanitization)', () => {
  it.each(['<!-<!---->-', '<!<!---->--> x', '<!-<!-<!---->-->-', '<!--<!-- a -->', 'a <!-- b --> c'])('leaves no comment delimiter in %s', input => {
    const out = stripHtmlComments(input);
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('-->');
  });
  it('hides refs inside nested comments from extractRefs', () => {
    expect(extractRefs('<!-<!---->- scripts/secret.mjs -->').paths).not.toContain('scripts/secret.mjs');
  });
});
