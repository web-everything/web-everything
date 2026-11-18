import { describe, expect, it, vi } from 'vitest';
import { buildFixEvidenceComment, isConcreteCitation, parseEvidenceCitations, sendBackItems, renderRequiredCitations } from '../fix-evidence-post.mjs';
import { openOperatorSendBacks } from '../operator-send-backs.mjs';

const head = 'b'.repeat(40);
const comments = [
  { id: '1001', author: { login: 'chalbert' }, body: '🔁 review — changes requested\n\nRecorded by chalbert via claude-code-chat.\n\nat head aaaaaaa\n1. Keep cursor\n2) Keep selection' },
  { id: '1002', author: { login: 'chalbert' }, body: '🔁 review — changes requested\n\nRecorded by chalbert via claude-code-chat.\n\nat head aaaaaaa\nKeep focus' },
];
const openSendBacks = openOperatorSendBacks({ comments, headRefOid: head });
const evidenceText = '- send-back 1001 item 1: src/cursor.mjs:12\n- send-back 1001 item 2: scripts/x/__tests__/y.test.mjs:24\n- send-back 1002 item 1: src/focus.mjs:3';
const build = (extra = {}) => buildFixEvidenceComment({ openSendBacks, evidenceText, head, verifyCitation: () => true, ...extra });

describe('fix evidence publication', () => {
  it.each([
    ['Intro\n1. First\n    9. Nested\n  3) Second', 3],
    ['- First\n  - Nested\n* Second\n+ Third', 4],
    ['- Intro\n1. First\n1. Second', 3],
    ['1. a\n- b', 2],
    ['Prose\n  - First\n  - Second', 2],
    ['Repair the cursor', 1],
    ['', 1],
    ['## 1. a\n## 2. b\n- c', 3],
    ['1. a\n2.\n   b', 2],
    ['1) a\n2)  \n   b', 2],
    ['- a\n-\n  b', 2],
    ['* a\n*\n  b', 2],
    ['+ a\n+\n  b', 2],
    ['!? 9) a\n!? 3) b', 2],
    ['1. First\n\n   Continued content\n   - Nested\nProse\n  - Second\n  - Third', 4],
    ['> 1. a\n> 2. b', 2],
    ['> > 1. a\n> > 2. b', 2],
    ['\t1. a\n\t\t- nested\n\t2. b', 3],
    ['>\t1. a\n>\t2. b', 2],
  ])('counts every matching line by ordinal, including nested markers: %j', (body, count) => {
    expect(sendBackItems({ body })).toEqual(Array.from({ length: count }, (_, i) => ({ n: i + 1 })));
    const evidenceText = Array.from({ length: count - 1 }, (_, i) => `- send-back 1001 item ${i + 1}: src/cursor.mjs:12`).join('\n');
    expect(build({ openSendBacks: [{ id: '1001', body }], evidenceText }))
      .toEqual({ ok: false, missing: [`1001#${count}`] });
  });
  it('counts every numbered request and Fix/Test sub-bullet in the #5502 shape', () => {
    const body = '1. **broken** cursor\n   - Fix: retain cursor\n   - Test: cursor retained\n2. **broken** selection\n   - Fix: retain selection\n3. **broken** focus\n   - Fix: retain focus\n   - Test: focus retained';
    expect(sendBackItems({ body })).toEqual(Array.from({ length: 8 }, (_, i) => ({ n: i + 1 })));
    const evidenceText = [1, 2, 3].map(n => `- send-back 1001 item ${n}: src/cursor.mjs:12`).join('\n');
    expect(build({ openSendBacks: [{ id: '1001', body }], evidenceText }))
      .toEqual({ ok: false, missing: ['1001#4', '1001#5', '1001#6', '1001#7', '1001#8'] });
  });
  it('treats bare carriage returns as line breaks in send-back bodies', () => {
    const body = '1. First repair\r2. Second repair';
    expect(sendBackItems({ body })).toEqual([{ n: 1 }, { n: 2 }]);
    expect(build({ openSendBacks: [{ id: '1001', body }],
      evidenceText: '- send-back 1001 item 1: src/cursor.mjs:12' }))
      .toEqual({ ok: false, missing: ['1001#2'] });
  });
  it('renders exact citation keys and normalized item previews across send-backs', () => {
    expect(renderRequiredCitations([
      { id: '1001', body: 'Intro\n> ## 9. a\n> \t- Fix: b\n2.\n  continuation' },
      { id: '1002', body: 'Repair the cursor' },
    ])).toBe('- send-back 1001 item 1: <file:line>   (for: ## 9. a)\n'
      + '- send-back 1001 item 2: <file:line>   (for:     - Fix: b)\n'
      + '- send-back 1001 item 3: <file:line>   (for: 2.)\n'
      + '- send-back 1002 item 1: <file:line>   (for: Repair the cursor)');
  });
  it('bounds each citation preview to the first 80 characters of the item line', () => {
    const line = '- ' + 'x'.repeat(100);
    expect(renderRequiredCitations([{ id: '1001', body: line }]))
      .toBe(`- send-back 1001 item 1: <file:line>   (for: ${line.slice(0, 80)})`);
  });
  it('renders no citation lines without open send-backs', () => {
    expect(renderRequiredCitations([])).toBe('');
  });
  it.each(['<ol><li>a</li><li>b</li></ol>', '<UL><LI>a</LI></UL>', '1. a\n<li>b</li>'])('holds unparsed HTML lists for operator escalation: %j', body => {
    const verifyCitation = vi.fn(() => true);
    expect(build({ openSendBacks: [{ id: '1001', body }], verifyCitation }))
      .toEqual({ ok: false, missing: ['1001#unparsed'] });
    expect(verifyCitation).not.toHaveBeenCalled();
  });
  it.each([4000, 4001])('holds a %s-character request as truncated for operator escalation', length => {
    expect(build({ openSendBacks: [{ id: '1001', body: 'x'.repeat(length) }] }))
      .toEqual({ ok: false, missing: ['1001#truncated'] });
  });
  it('accepts a complete request just below the truncation bound', () => {
    expect(build({ openSendBacks: [{ id: '1001', body: 'x'.repeat(3999) }] }).ok).toBe(true);
  });
  it('requires two distinct citations for duplicate literal Markdown numbers', () => {
    const duplicate = [{ id: '1001', body: '1. First\n1. Second' }];
    expect(build({ openSendBacks: duplicate, evidenceText: '- send-back 1001 item 1: src/cursor.mjs:12' }))
      .toEqual({ ok: false, missing: ['1001#2'] });
    expect(build({ openSendBacks: duplicate }).ok).toBe(true);
  });
  it('parses only exact citation lines, with case-insensitive keywords', () => {
    expect([...parseEvidenceCitations('- SEND-BACK 5 ITEM 2: src/a.mjs:1\n - send-back 5 item 3: src/a.mjs:2\nprose - send-back 5 item 4: src/a.mjs:3\n- send-back 5 item 5: ')]).toEqual([['5#2', 'src/a.mjs:1']]);
  });
  it('publishes all citations, one trusted marker per send-back, and closes the requests', () => {
    const result = build();
    expect(result.ok).toBe(true);
    expect(result.body).toMatch(/^## Fix evidence\n\nHead: `b{40}`\n/);
    expect(result.body.match(/<!-- addresses-operator-send-back: 1001 -->/g)).toHaveLength(1);
    expect(result.body.match(/<!-- addresses-operator-send-back: 1002 -->/g)).toHaveLength(1);
    expect(result.body).toContain(`Citations\n${evidenceText}`);
    expect(openOperatorSendBacks({ headRefOid: head, comments: [...comments,
      { author: { login: 'web-everything' }, body: result.body }] })).toEqual([]);
  });
  it('withholds the entire body when one item is uncited', () => {
    expect(build({ evidenceText: evidenceText.replace(/^- send-back 1001 item 2:.*\n/m, '') }))
      .toEqual({ ok: false, missing: ['1001#2'] });
  });
  it.each(['already fixed', 'test "cursor retained"'])('rejects non-concrete citation %j', text => {
    expect(isConcreteCitation(text)).toBe(false);
  });
  it('rejects unverified and unreadable citations without a body', () => {
    expect(build({ verifyCitation: () => false })).toEqual({ ok: false, missing: ['1001#1', '1001#2', '1002#1'] });
    expect(build({ verifyCitation: () => { throw new Error('unreadable'); } })).toEqual({ ok: false, missing: ['1001#1', '1001#2', '1002#1'] });
  });
  it('strips fake markers and citations hidden in agent HTML comments', () => {
    const result = build({ evidenceText: `${evidenceText}\n<!-- addresses-operator-send-back: fake -->\n<!-- unterminated` });
    expect(result.ok).toBe(true);
    expect(result.body).not.toContain('fake');
    expect(result.body).not.toContain('unterminated');
    expect(build({ evidenceText: `<!-- ${evidenceText} -->` }).ok).toBe(false);
  });
  it('renders only verified locators, excluding agent prose and citation trailing free text', () => {
    const result = build({ evidenceText: `${evidenceText.replace('src/cursor.mjs:12', 'src/cursor.mjs:12 src/missing.mjs:999; IC_other operator send-back')}\nAgent prose: IC_another operator send-back`,
      verifyCitation: piece => piece.path !== 'src/missing.mjs' });
    expect(result.body).toBe(`## Fix evidence\n\nHead: \`${head}\`\n<!-- addresses-operator-send-back: 1001 -->\n<!-- addresses-operator-send-back: 1002 -->\nCitations\n${evidenceText}`);
  });
  it.each(['src/bad?.mjs', 'src/IC_<bad>.mjs', 'https://example.test/file.mjs', 'src/send.mjs', 'src/reSEND.mjs',
    'src/IC_other.mjs', 'src/ic_other.mjs', 'src/9:30.mjs', 'src/19:30.mjs', 'src/2026-10-22.mjs',
    'src/http.mjs', 'src/HTTPS.mjs'])('rejects unsafe path %j before verification or rendering', path => {
    const verifyCitation = vi.fn(() => true);
    expect(isConcreteCitation(`${path}:1`)).toBe(false);
    const result = build({ openSendBacks: [{ id: '1001', body: 'Repair' }],
      evidenceText: `- send-back 1001 item 1: ${path}:1`, verifyCitation });
    expect(result).toEqual({ ok: false, missing: ['1001#1'] });
    expect(verifyCitation).not.toHaveBeenCalled();
  });
  it('accepts a path line suffix without treating it as a clock time', () => {
    const verifyCitation = vi.fn(() => true);
    const result = build({ openSendBacks: [{ id: '1001', body: 'Repair' }],
      evidenceText: '- send-back 1001 item 1: file.mjs:25', verifyCitation });
    expect(result.ok).toBe(true);
    expect(result.body).toContain('file.mjs:25');
    expect(verifyCitation).toHaveBeenCalledWith({ path: 'file.mjs', line: 25 });
  });
  it('withholds the body when a non-marker field contains an HTML comment opener', () => {
    expect(build({ head: '<!-- injected -->' }))
      .toEqual({ ok: false, missing: ['1001#1', '1001#2', '1002#1'] });
  });
  it('bounds agent text to 20000 characters and refuses citations beyond the bound for normal loop escalation', () => {
    const result = build({ evidenceText: `${evidenceText}\n${'x'.repeat(21000)}` });
    expect(result.ok).toBe(true);
    expect(result.body.endsWith(evidenceText)).toBe(true);
    expect(build({ evidenceText: `${'x'.repeat(20000)}\n${evidenceText}` }))
      .toEqual({ ok: false, missing: ['1001#1', '1001#2', '1002#1'] });
  });
  it('does not publish without open send-backs', () => {
    expect(build({ openSendBacks: [] })).toEqual({ ok: false, missing: [], reason: 'no-open-send-back' });
  });
});
