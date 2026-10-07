/**
 * @file scripts/backlog/__tests__/edge-case-classes.test.mjs
 * @description Card 3 (opus perf sweep 2026-10-07): the seven edge-case classes live in ONE list, and the card
 *   skeleton, the prepare brief, the delivery brief, the file-item skill and the coroner all agree with it. Fails on
 *   a brief or template that carries only the original four classes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDGE_CASE_CLASSES, EDGE_CASES_HEADING, renderEdgeCasesSkeleton, countEdgeCaseClasses } from '../edge-case-classes.mjs';
import { renderItem } from '../scaffold.mjs';
import { parseCard, prAttributes, ATTRIBUTES } from '../../operations/coroner-rounds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');

describe('the class list', () => {
  it('names exactly the seven classes, the original four plus identity, time and writer trust', () => {
    expect(EDGE_CASE_CLASSES.map((c) => c.label)).toEqual([
      'Untrusted text', 'Truncated reads', 'Shared state files', 'Fail closed', 'Identity scoping', 'State over time', 'Who wrote it',
    ]);
    expect(new Set(EDGE_CASE_CLASSES.map((c) => c.id)).size).toBe(7);
  });
});

describe('every surface carries all seven classes', () => {
  const surfaces = {
    'prepare brief': 'skills-src/conveyor/prepare-item-agent-brief.md',
    'delivery brief': 'skills-src/conveyor/delivery-agent-brief.md',
  };
  for (const [name, rel] of Object.entries(surfaces)) {
    it(`${name} names the section and every class`, () => {
      const text = flat(read(rel));
      expect(text).toContain(EDGE_CASES_HEADING);
      for (const c of EDGE_CASE_CLASSES) expect(text, `${name} lacks "${c.label}"`).toContain(`**${c.label}**`);
      expect(text).toContain('n/a: <why>');
    });
  }
  it('the card skeleton emits the section with one unfilled line per class', () => {
    const card = renderItem({ kind: 'story', size: 2, slug: 'x', title: 'X', num: '900', digest: 'd', today: '2026-10-07' });
    expect(card).toContain(EDGE_CASES_HEADING);
    for (const c of EDGE_CASE_CLASSES) expect(card).toContain(`**${c.label}** — TODO`);
    expect(card.indexOf('## Done when')).toBeLessThan(card.indexOf(EDGE_CASES_HEADING));
  });
  it('the file-item skill tells the filer to fill the section', () => {
    const text = flat(read('skills-src/file-item/SKILL.md'));
    expect(text).toContain(EDGE_CASES_HEADING);
    expect(text).toContain('edge-case-classes.mjs');
  });
});

describe('coroner prep.checklistClasses', () => {
  const filled = `${EDGE_CASES_HEADING}\n\n${EDGE_CASE_CLASSES.map((c, i) => `${i + 1}. **${c.label}** — ${i % 2 ? 'n/a: no I/O' : 'refuse with reason x'}.`).join('\n')}\n\n## Design\n\ntext\n`;
  it('counts only classes with a non-TODO line, and 0 without the section', () => {
    expect(countEdgeCaseClasses(filled)).toBe(7);
    expect(countEdgeCaseClasses(renderEdgeCasesSkeleton())).toBe(0);
    expect(countEdgeCaseClasses('## Design\n\nno section\n')).toBe(0);
    expect(countEdgeCaseClasses(filled.replace('1. **Untrusted text** — refuse with reason x.', '1. **Untrusted text** — TODO: the handling, or n/a: <why>.'))).toBe(6);
  });
  it('flows from the card into the PR attributes and the correlation table', () => {
    const card = parseCard(`---\nkind: story\nsize: 2\n---\n# T\n\n${filled}`);
    expect(card.checklistClasses).toBe(7);
    const a = prAttributes({ pr: { createdAt: '2026-10-07T00:00:00Z' }, files: [], card: { ...card, id: '1' } });
    expect(a.prep.checklistClasses).toBe(7);
    expect(ATTRIBUTES.checklistClasses(a)).toBe(7);
  });
});
