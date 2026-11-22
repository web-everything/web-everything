// @vitest-environment node
/** CKLST-B: acceptance is pinned to merge-base, never supplied by the seat or head card. */
import { expect, it, vi } from 'vitest';
import { buildAcceptanceRubric, acceptanceItems } from '../seat-ac-rubric.mjs';
const head = 'a'.repeat(40), mergeBase = 'b'.repeat(40);
const card = '# Card\n## Acceptance\n- [A7] Keep `this` text verbatim.\n- [A12] Second line.\n## Notes\n- [A99] Not acceptance.\n';
it('card Acceptance retains its A-ids and verbatim text', () => {
  expect(acceptanceItems(card)).toEqual([{ id: 'A7', text: 'Keep `this` text verbatim.' }, { id: 'A12', text: 'Second line.' }]);
});
it('head-side card edit is ignored: reads only the merge-base', () => {
  const read = vi.fn((rev) => rev === mergeBase ? card : '## Acceptance\n- [A1] Easier criterion');
  const rubric = buildAcceptanceRubric({ head, mergeBase, cardPath: 'backlog/card.md', readFileAtRevision: read });
  expect(read).toHaveBeenCalledWith(mergeBase, 'backlog/card.md'); expect(read).toHaveBeenCalledTimes(1);
  expect(rubric.items).toEqual(acceptanceItems(card)); expect(rubric.appliesTo).toEqual({ gitCommit: head });
});
it('no card falls back to the merge-base DoR numbered Acceptance list', () => {
  const rubric = buildAcceptanceRubric({ head, mergeBase, prepPath: 'prep/card.md', readFileAtRevision: () => '## Acceptance\n1. First.\n2. Second.\n## Tests\n3. Not acceptance.' });
  expect(rubric.items).toEqual([{ id: 'A1', text: 'First.' }, { id: 'A2', text: 'Second.' }]);
});
it('a card with no Acceptance lines falls back to prep', () => {
  const rubric = buildAcceptanceRubric({ head, mergeBase, cardPath: 'card.md', prepPath: 'prep.md', readFileAtRevision: (_r,p) => p === 'card.md' ? '## Notes' : '## Acceptance\n1. Prep criterion' });
  expect(rubric.items).toEqual([{ id: 'A1', text: 'Prep criterion' }]);
});
it('no pinned lines gives no rubric', () => {
  expect(buildAcceptanceRubric({ head, mergeBase })).toBeNull();
  expect(buildAcceptanceRubric({ head, mergeBase, cardPath: 'card.md', readFileAtRevision: () => '# No AC' })).toBeNull();
});
it('unreadable pinned card refuses instead of falling back to easier prep', () => {
  expect(() => buildAcceptanceRubric({ head, mergeBase, cardPath: 'card.md', prepPath: 'prep.md', readFileAtRevision: () => { throw new Error('unreadable'); } })).toThrow('unreadable');
});
it('duplicate card ids and invalid head or merge-base refuse', () => {
  expect(() => acceptanceItems('## Acceptance\n- [A1] One\n- [A1] Two')).toThrow();
  expect(() => buildAcceptanceRubric({ head: 'HEAD', mergeBase })).toThrow();
  expect(() => buildAcceptanceRubric({ head, mergeBase: 'main' })).toThrow();
});
