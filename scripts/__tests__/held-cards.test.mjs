import { describe, it, expect } from 'vitest';
import { parseHeldCards, appendHeldCard, quietVerdict, planFiling, markFiled, heldTitle } from '../held-cards.mjs';

const fixture = `# Held cards
FILED 2026-10-05 in PR #3980: items 1–20 → backlog
1. **Old.** text
21. **The review round cap is configurable.** scripts/lib/jury-core.mjs
    Make it a setting.
    (held 2026-10-05 14:40 ET)
    <!-- held-card: {"kind":"story","size":5,"scope":["we:x.mjs"],"parent":"3383"} -->

item 32 was implemented: BUILT
32. **Already built.** text
33. **Inline.** BUILT today
## Card: another section
46. **RATIFIED (operator 2026-10-05 ~14:40 ET): design principles + plugin registries.** The doc is ...
47. **Epic umbrella.** body
48. **Umbrella (epic) test.** body
49. **Another (epic).** body
50. Unbolded title
`;

describe('held cards', () => {
  it('parses boundaries, titles, metadata and completion notes', () => {
    const { items, nextNum } = parseHeldCards(fixture);
    expect(nextNum).toBe(51);
    expect(items.filter(i => i.done).map(i => [i.num, i.doneReason])).toEqual([[1, 'FILED'], [32, 'BUILT'], [33, 'BUILT']]);
    expect(items[1].title).toBe('The review round cap is configurable');
    expect(items[1].text).toContain('    Make it a setting.');
    expect(items[1].text).not.toContain('item 32');
    expect(fixture.split('\n').slice(items[1].startLine, items[1].endLine).join('\n')).toBe(items[1].text);
    expect(items[1].meta.parent).toBe('3383');
    expect(items.at(-1).title).toBe('Unbolded title');
    expect(parseHeldCards('FILED items 3, 5, 7\n3. a\n4. b\n5. c\n7. d').items.map(i => i.done)).toEqual([true, false, true, true]);
    expect(parseHeldCards('7. a\n <!-- held-card: oops -->').items[0].meta).toBeNull();
    expect(parseHeldCards('').nextNum).toBe(1);
  });
  it('reads FILED/BUILT as done only from a marker, never from an ordinary mention', () => {
    const md = [
      "1. **Fix FILED marker handling.** body",
      '2. **Alpha.** not yet BUILT',
      '3. **Gamma.** first line',
      '    this was never BUILT or FILED before',
      "4. (follow-up, held) FILED/BUILT counted as done anywhere (+ fixture '9. **Inline.** BUILT today').",
      '5. Fix the BUILT label',
      '6. **Marked.** body — **FILED 2026-10-05 as x1, PR #7**',
      '7. **Built.** BUILT today',
      '8. **Filed.** FILED 2026-10-05 as x2',
      '9. **FILED marker handling.** Fix the parser',
      '10. **BUILT-in cards.** Handle them',
      '11. **FILED** and **BUILT** are words in a title'].join('\n');
    const { items } = parseHeldCards(md);
    expect(items.map(i => [i.num, i.doneReason])).toEqual(
      [[1, null], [2, null], [3, null], [4, null], [5, null], [6, 'FILED'], [7, 'BUILT'], [8, 'FILED'],
        [9, null], [10, null], [11, null]]);
    expect(planFiling(items).map(f => f.num)).toEqual([1, 2, 3, 4, 5, 9, 10, 11]);
    const marked = markFiled(md, [{ num: 1, id: 'x9' }, { num: 3, id: 'x10' }, { num: 6, id: 'x11' }], { dateEt: '2026-10-06', pr: 1 });
    expect(marked).toContain('1. **Fix FILED marker handling.** body — **FILED 2026-10-06 as x9, PR #1**');
    expect(marked).toContain('3. **Gamma.** first line — **FILED 2026-10-06 as x10, PR #1**');
    expect(marked.match(/x11/g)).toBeNull();
  });
  it('appends with numbering, spacing, indentation and metadata', () => {
    const result = appendHeldCard(fixture + '\n\n', { title: 'New.', body: 'first\nsecond', nowEt: '2026-10-05 14:40', meta: { size: 3 } });
    expect(result.num).toBe(51);
    expect(result.md).toContain('50. Unbolded title\n\n51. **New.** first\n    second\n    (held 2026-10-05 14:40 ET)\n    <!-- held-card: {"size":3} -->');
    expect(() => appendHeldCard('', { title: ' ' })).toThrow(TypeError);
  });
  it('judges load and growth independently of the unknown-growth note', () => {
    expect(quietVerdict({ load1: 1, openPrs: 4 })).toMatchObject({ quiet: true, reasons: ['no previous PR snapshot; growth unknown'] });
    expect(quietVerdict({ load1: 24.9, openPrs: 7, previous: { openPrs: 4 } })).toMatchObject({ quiet: false, reasons: ['load 24.9 ≥ 15', 'PR queue grew 4 → 7'] });
    expect(quietVerdict({ load1: 15, openPrs: 0 }).quiet).toBe(false);
    expect(quietVerdict({ load1: 15, openPrs: 7, previous: { openPrs: 4 }, maxLoad: 16, maxPrGrowth: 3 }).quiet).toBe(true);
  });
  it('plans remaining items with epic inference, overrides and qualified paths', () => {
    const plan = planFiling(parseHeldCards(fixture).items);
    expect(plan.map(i => i.num)).toEqual([21, 46, 47, 48, 49, 50]);
    expect(plan[0]).toMatchObject({ kind: 'story', size: 5, scope: ['we:x.mjs'], parent: '3383' });
    expect(plan[0].digest).toContain('we:scripts/lib/jury-core.mjs');
    expect(plan[0].digest).not.toMatch(/held-card:|\(held /);
    expect(plan[0].digest).toMatch(/\(Held-card #21 from the operator handoff list\.\)$/);
    expect(plan.slice(2, 5).map(i => i.kind)).toEqual(['epic', 'epic', 'epic']);
    expect(plan.at(-1)).toMatchObject({ kind: 'story', size: 3, scope: [], parent: null });
    expect(planFiling([{ num: 1, title: 'Epic', text: '1. Epic', meta: { kind: 'task' } }])[0].kind).toBe('task');
  });
  it('marks only the first line and is idempotent', () => {
    const options = { dateEt: '2026-10-05', pr: 4242 };
    const marked = markFiled(fixture, [{ num: 21, id: 4000 }], options);
    expect(marked).toBe(fixture.replace('scripts/lib/jury-core.mjs\n', 'scripts/lib/jury-core.mjs — **FILED 2026-10-05 as 4000, PR #4242**\n'));
    expect(markFiled(marked, [{ num: 21, id: 4000 }], options)).toBe(marked);
  });
});

describe('heldTitle and the kind heuristic', () => {
  it('uses the first closed bold span, strips an unclosed ** and a trailing . : ,', () => {
    expect(heldTitle('**Daemon interval knobs.**')).toBe('Daemon interval knobs');
    expect(heldTitle('**Follow-up from #3981 (approved):**')).toBe('Follow-up from #3981 (approved)');
    expect(heldTitle('**`x.mjs` crashes at import (circular')).toBe('`x.mjs` crashes at import (circular');
  });

  it('a RATIFIED lead plans as a decision, an Umbrella (epic) as an epic', () => {
    const { items } = parseHeldCards('1. **RATIFIED (operator): plugin registries.** text\n2. **Umbrella (epic): harness steps.** text\n');
    expect(planFiling(items).map((p) => p.kind)).toEqual(['decision', 'epic']);
  });
});
