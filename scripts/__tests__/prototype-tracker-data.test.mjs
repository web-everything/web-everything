/**
 * @file scripts/__tests__/prototype-tracker-data.test.mjs
 * @description Proof of the pure parser (prototype-tracker-data.mjs) that the `prototype-tracker` skill and
 *   `guard-prototype-tracker.mjs` both build on. Fixtures are small hand-built strings mirroring the live
 *   card's real shape (frontmatter block, standing-goal blockquote, "Done when" list, `## Session update`
 *   entries) — never the real 3000+ line file, so this stays fast and independent of its content.
 */
import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter, parseSessionUpdates, parseDoneWhen, parseHeaderBlock, parseTracker,
  formatSessionUpdateHeading, appendSessionUpdate, findTrackerPath, readTracker, TRACKER_PREFIX,
  splitDateQualifier,
} from '../lib/prototype-tracker-data.mjs';

const FIXTURE = `---
bornAs: xyv0vbz
kind: epic
parent: "3029"
status: active
dateOpened: "2026-08-28"
dateStarted: "2026-08-31"
tags: []
---

# A background mechanical dispatcher replaces the interactive session as delivery supervisor

> **STANDING GOAL FOR THIS EPIC (operator, 2026-08-29): improve the prototype and the machinery it
> depends on.** Discard work freely.

## The problem, stated plainly

Some prose here that is not the standing goal.

## Done when

1. A background process can run at least one real PR through a full cycle.
2. A blocked case reaches a person via explicit notification.
   Still part of item 2, wrapped onto a second line.
3. converge.py's mechanisms are subsumed.

## Session update (2026-08-28) — first pass

Some early digest body.

Second paragraph.

## Session update (2026-09-13, continued) — second pass, corrected

- a bullet
- another bullet

## Session update (2026-09-14) — third pass

Final body text with \`inline code\` and **bold**.
`;

describe('parseFrontmatter', () => {
  it('reads known scalar keys, stripping quotes', () => {
    const fm = parseFrontmatter(FIXTURE);
    expect(fm.status).toBe('active');
    expect(fm.dateOpened).toBe('2026-08-28');
    expect(fm.dateStarted).toBe('2026-08-31');
    expect(fm.parent).toBe('3029');
  });
  it('returns {} for text with no frontmatter block', () => {
    expect(parseFrontmatter('# just a heading\n')).toEqual({});
  });
});

describe('parseHeaderBlock', () => {
  it('extracts the H1 title and the standing-goal blockquote', () => {
    const { title, standingGoal } = parseHeaderBlock(FIXTURE);
    expect(title).toMatch(/background mechanical dispatcher/);
    expect(standingGoal).toMatch(/STANDING GOAL FOR THIS EPIC/);
    expect(standingGoal).toMatch(/Discard work freely/);
  });
  it('returns null standingGoal when the H1 is followed by plain prose, not a blockquote', () => {
    const { standingGoal } = parseHeaderBlock('# Title\n\nJust prose, no quote.\n');
    expect(standingGoal).toBeNull();
  });
});

describe('parseDoneWhen', () => {
  it('extracts the numbered list, joining a wrapped continuation line', () => {
    const items = parseDoneWhen(FIXTURE);
    expect(items).toHaveLength(3);
    expect(items[1]).toBe('A blocked case reaches a person via explicit notification. Still part of item 2, wrapped onto a second line.');
  });
  it('reads `## Acceptance` `[A#]` items exactly as `## Done when` numbered items (#5399 S7)', () => {
    const canonical = FIXTURE.replace('## Done when', '## Acceptance').replace(/^(\d+)\. /gm, '- [A$1] ');
    expect(canonical).not.toContain('## Done when');
    expect(parseDoneWhen(canonical)).toEqual(parseDoneWhen(FIXTURE));
  });
  it('returns [] when there is no acceptance section', () => {
    expect(parseDoneWhen('# Title\n\nno such section\n')).toEqual([]);
  });
});

describe('parseSessionUpdates', () => {
  it('extracts every entry in file order, with date/qualifier/digest split out', () => {
    const entries = parseSessionUpdates(FIXTURE);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ date: '2026-08-28', qualifier: null, digest: 'first pass' });
    expect(entries[1]).toMatchObject({ date: '2026-09-13', qualifier: 'continued', digest: 'second pass, corrected' });
    expect(entries[2].digest).toBe('third pass');
  });
  it('captures the full body up to the next ## heading', () => {
    const entries = parseSessionUpdates(FIXTURE);
    expect(entries[0].body).toMatch(/Some early digest body/);
    expect(entries[0].body).toMatch(/Second paragraph/);
    expect(entries[0].body).not.toMatch(/second pass/); // does not bleed into the next entry
  });
  it('returns [] for text with no session-update headings', () => {
    expect(parseSessionUpdates('# Title\n\nnothing here\n')).toEqual([]);
  });
});

describe('splitDateQualifier (real-file edge cases — regression for a 25→22 under-count)', () => {
  // Both shapes below are REAL headings from the live tracker file (verified by direct grep before this
  // fix): a strict `date[, qualifier]` grammar silently dropped both, under-counting 25 real entries to 22.
  it('handles a date-RANGE shorthand with no comma ("2026-08-30/31")', () => {
    expect(splitDateQualifier('2026-08-30/31')).toEqual({ date: '2026-08-30', qualifier: '/31' });
  });
  it('handles a qualifier with NO leading comma ("2026-09-12 night, close-out")', () => {
    expect(splitDateQualifier('2026-09-12 night, close-out')).toEqual({ date: '2026-09-12', qualifier: 'night, close-out' });
  });
  it('handles the plain, strict shape', () => {
    expect(splitDateQualifier('2026-09-14, continued')).toEqual({ date: '2026-09-14', qualifier: 'continued' });
    expect(splitDateQualifier('2026-09-14')).toEqual({ date: '2026-09-14', qualifier: null });
  });
  it('returns a null date for text with no leading YYYY-MM-DD', () => {
    expect(splitDateQualifier('not a date')).toEqual({ date: null, qualifier: 'not a date' });
  });
});

describe('parseSessionUpdates on the real edge-case headings', () => {
  const text = [
    '# Title',
    '',
    '## Session update (2026-08-30/31) — the branch is rebased',
    '',
    'body one',
    '',
    '## Session update (2026-09-12 night, close-out) — five threads checked',
    '',
    'body two',
    '',
  ].join('\n');
  it('parses both entries instead of silently dropping them', () => {
    const entries = parseSessionUpdates(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ date: '2026-08-30', qualifier: '/31', digest: 'the branch is rebased' });
    expect(entries[1]).toMatchObject({ date: '2026-09-12', qualifier: 'night, close-out', digest: 'five threads checked' });
  });
});

describe('parseTracker', () => {
  it('combines every piece and reports the LAST entry as latest (append-at-end convention)', () => {
    const data = parseTracker(FIXTURE);
    expect(data.frontmatter.status).toBe('active');
    expect(data.doneWhen).toHaveLength(3);
    expect(data.sessionUpdates).toHaveLength(3);
    expect(data.latestUpdate.digest).toBe('third pass');
    expect(data.latestDate).toBe('2026-09-14');
  });
  it('latestUpdate/latestDate are null when there are no session updates', () => {
    const data = parseTracker('# Title\n\n## Done when\n\n1. x\n');
    expect(data.latestUpdate).toBeNull();
    expect(data.latestDate).toBeNull();
  });
});

describe('formatSessionUpdateHeading', () => {
  it('formats without a qualifier', () => {
    expect(formatSessionUpdateHeading({ date: '2026-09-14', summary: 'did a thing' }))
      .toBe('## Session update (2026-09-14) — did a thing');
  });
  it('formats WITH a qualifier', () => {
    expect(formatSessionUpdateHeading({ date: '2026-09-14', qualifier: 'continued', summary: 'did more' }))
      .toBe('## Session update (2026-09-14, continued) — did more');
  });
  it('throws on a malformed date', () => {
    expect(() => formatSessionUpdateHeading({ date: '9/14/2026', summary: 'x' })).toThrow(/YYYY-MM-DD/);
  });
  it('throws on a missing summary', () => {
    expect(() => formatSessionUpdateHeading({ date: '2026-09-14', summary: '  ' })).toThrow(/summary/);
  });
});

describe('appendSessionUpdate', () => {
  it('appends a new section, ending in exactly one trailing newline', () => {
    const before = '# Title\n\n## Session update (2026-09-14) — third pass\n\nFinal body text.\n\n\n';
    const after = appendSessionUpdate(before, { date: '2026-09-15', summary: 'fourth pass', body: 'New body.\n' });
    expect(after).toBe('# Title\n\n## Session update (2026-09-14) — third pass\n\nFinal body text.\n\n## Session update (2026-09-15) — fourth pass\n\nNew body.\n');
    expect(after.endsWith('\n\n')).toBe(false);
  });
  it('round-trips through parseSessionUpdates', () => {
    const after = appendSessionUpdate(FIXTURE, { date: '2026-09-15', qualifier: 'handoff', summary: 'wrap-up', body: 'Body here.' });
    const entries = parseSessionUpdates(after);
    expect(entries).toHaveLength(4);
    expect(entries[3]).toMatchObject({ date: '2026-09-15', qualifier: 'handoff', digest: 'wrap-up' });
    expect(entries[3].body).toBe('Body here.');
  });
});

describe('findTrackerPath / readTracker (IO shell)', () => {
  const readdir = () => ['3383-a-background-mechanical-dispatcher-replaces-the-interactive.md', '3029-other-epic.md'];
  it('finds the tracker by its TRACKER_PREFIX among other backlog files', () => {
    const p = findTrackerPath({ backlogDir: '/repo/backlog', readdir });
    expect(p).toBe(`/repo/backlog/${TRACKER_PREFIX}a-background-mechanical-dispatcher-replaces-the-interactive.md`);
  });
  it('returns null when no file starts with the prefix', () => {
    expect(findTrackerPath({ backlogDir: '/repo/backlog', readdir: () => ['3029-other-epic.md'] })).toBeNull();
  });
  it('returns null when the backlog dir cannot be read', () => {
    expect(findTrackerPath({ backlogDir: '/nope', readdir: () => { throw new Error('ENOENT'); } })).toBeNull();
  });
  it('readTracker reads + parses in one call, null on a read failure', () => {
    const found = readTracker({ backlogDir: '/repo/backlog', readdir, read: () => FIXTURE });
    expect(found.data.latestDate).toBe('2026-09-14');
    expect(readTracker({ backlogDir: '/repo/backlog', readdir, read: () => { throw new Error('EACCES'); } })).toBeNull();
  });
});
