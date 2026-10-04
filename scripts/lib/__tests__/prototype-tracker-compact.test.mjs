/**
 * @file prototype-tracker-compact.test.mjs — pure proof of the compact tracker page builder
 * (`prototype-tracker-compact.mjs`): the top-N cut, the band and size columns, the title taken from the card's H1,
 * the claimed marking, the collapsed remainder, the sections and their order, and the stamp the hash ignores.
 * The real command line over a real git repo is `scripts/__tests__/prototype-tracker-render-real.test.mjs`.
 */
import { describe, expect, it } from 'vitest';
import {
  TITLE_MAX, UP_NEXT_COUNT, buildUpNext, cardRef, cardTitleFromText, countsFor, cutText, parsePriorityRows,
  renderCompactHtml, renderRowsTable, rowTitle, shortGoal, stripStamp,
} from '../prototype-tracker-compact.mjs';
import { parseTracker } from '../prototype-tracker-data.mjs';
import { CLAIMED, FIXTURE_TITLE, NOTES, ORDERED, TITLES, trackerCardText } from '../../__tests__/fixtures/tracker-compact-fixture.mjs';

const text = trackerCardText();
const priority = parsePriorityRows(text);
const titles = new Map(Object.entries(TITLES));
const claimedIds = new Set(['3906', '3930', '3931']);
const data = parseTracker(text);
const page = (over = {}) => renderCompactHtml(data, { priority, titles, claimedIds, needsYou: [], tip: 'abc1234', generatedAt: '2026-09-21 09:00 EDT', ...over });
const rowsOf = (html) => [...html.matchAll(/<tr><td class="rank">(.*?)<\/td><td class="card">(.*?)<\/td><td class="band">(.*?)<\/td><td class="size">(.*?)<\/td><\/tr>/g)]
  .map(([, rank, card, band, size]) => ({ rank, card, band, size }));

describe('cutText', () => {
  it('leaves a short text alone and cuts a long one to about the limit with an ellipsis', () => {
    expect(cutText('short title')).toBe('short title');
    const cut = cutText('Allow GitHub Actions CI to be enabled for the prototype branch again');
    expect(cut.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).toBe('Allow GitHub Actions CI to be enabled…');
  });
});

describe('cardTitleFromText', () => {
  it('reads the first H1 after the frontmatter, not a `#` line inside it', () => {
    expect(cardTitleFromText('---\nkind: story\n# not a title: yaml comment\n---\n\n# The real title\n\n# second\n')).toBe('The real title');
    expect(cardTitleFromText('no heading here')).toBeNull();
  });
});

describe('parsePriorityRows', () => {
  it('reads every ordered line with rank, size, band and why, in list order', () => {
    expect(priority.found).toBe(true);
    expect(priority.ordered).toHaveLength(ORDERED.length);
    expect(priority.ordered[0]).toMatchObject({ rank: 1, id: '3901', size: '5', band: 'B' });
    expect(priority.ordered[4]).toMatchObject({ rank: 5, id: '3905', size: '3', band: 'A' });
    expect(priority.ordered.at(-1)).toMatchObject({ rank: ORDERED.length, id: '3920', band: 'C' });
    expect(priority.ordered.map((r) => r.rank)).toEqual(ORDERED.map((_, i) => i + 1));
  });

  it('reads the claimed and off-path lists, and flags the lines that still carry "why: (unwritten)"', () => {
    expect(priority.claimed.map((r) => r.id)).toEqual(CLAIMED.map((r) => r[0]));
    expect(priority.offpath).toEqual([{ id: '3940', size: 'decision', why: 'parent #3054: whether an approval carries across a merge-only push.' }]);
    expect(priority.ordered.filter((r) => r.unwritten).map((r) => r.id)).toEqual(['3907', '3915']);
  });

  it('does not count a #card named inside prose as a line', () => {
    expect(priority.ordered.some((r) => r.id === '3999')).toBe(false);
  });

  it('reports a card with no priority section as not found', () => {
    expect(parsePriorityRows('# no section\n')).toMatchObject({ found: false, ordered: [], claimed: [], offpath: [] });
  });
});

describe('the up-next table', () => {
  it('cuts the first table to the top 15 and puts the rest in a collapsed "N more"', () => {
    const { top, rest, html } = buildUpNext(priority.ordered, { titles, claimedIds });
    expect(UP_NEXT_COUNT).toBe(15);
    expect(top).toHaveLength(15);
    expect(rest).toHaveLength(ORDERED.length - 15);
    expect(top.map((r) => r.rank)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    const [first, second] = html.split('<details>');
    expect(rowsOf(first)).toHaveLength(15);
    expect(second).toMatch(/^<summary>5 more<\/summary>/);
    expect(rowsOf(second).map((r) => r.rank)).toEqual(['16', '17', '18', '19', '20']);
  });

  it('carries no "more" block when everything fits', () => {
    const { rest, html } = buildUpNext(priority.ordered, { titles, topN: 50 });
    expect(rest).toEqual([]);
    expect(html).not.toContain('<details>');
  });

  it('shows the band and the size of each row as their own columns, taken from the list line', () => {
    const rows = rowsOf(buildUpNext(priority.ordered, { titles }).html);
    expect(rows[0]).toMatchObject({ rank: '1', band: 'B', size: '5' });
    expect(rows[1]).toMatchObject({ rank: '2', band: 'A', size: '3' });
    expect(rows[3]).toMatchObject({ band: 'A', size: 'epic' });
  });

  it('takes the short title from the card H1 (cut), never the long why sentence', () => {
    const rows = rowsOf(buildUpNext(priority.ordered, { titles }).html);
    expect(rows[0].card).toContain('Fix the standards check on the…');
    expect(rows[0].card).not.toContain('Clears: the branch fails');
    // the long H1 of #3902 is cut to about 40 characters
    expect(rows[1].card).toContain('Switch CI on for the prototype branch…');
    expect(rowTitle(priority.ordered[1], titles).length).toBeLessThanOrEqual(TITLE_MAX);
  });

  it('falls back to the cut why text when no source has the card, so a row is never blank', () => {
    expect(rowTitle({ id: '4000', why: 'Clears: the branch fails the standards check on every push.' }, new Map())).toBe('the branch fails the standards check…');
  });

  it('marks a claimed card in the table', () => {
    const rows = rowsOf(buildUpNext(priority.ordered, { titles, claimedIds }).html);
    expect(rows.find((r) => r.card.includes('#3906')).card).toContain('<span class="tag">claimed</span>');
    expect(rows.find((r) => r.card.includes('#3905')).card).not.toContain('claimed');
  });

  it('keeps every table to four columns', () => {
    const html = renderRowsTable(priority.ordered.slice(0, 3), { titles });
    expect(html.match(/<th>/g)).toHaveLength(4);
    expect(html.match(/<td /g)).toHaveLength(12);
  });

  it('writes a card number as plain text without a base URL, and as a /backlog/<n>/ link with one', () => {
    expect(cardRef('3901')).toBe('#3901');
    expect(cardRef('3901', 'https://example.test/we/')).toBe('<a href="https://example.test/we/backlog/3901/">#3901</a>');
    expect(buildUpNext(priority.ordered, { titles }).html).not.toContain('<a ');
    expect(buildUpNext(priority.ordered, { titles, baseUrl: 'https://example.test' }).html).toContain('href="https://example.test/backlog/3901/"');
  });
});

describe('the counts', () => {
  it('counts ordered lines by band, claimed, off-path and the lines still unwritten', () => {
    expect(countsFor(priority)).toEqual({ ordered: 20, band: { A: 12, B: 5, C: 3 }, claimed: 2, offpath: 1, unwritten: 2 });
  });
});

describe('shortGoal', () => {
  it('keeps the lead sentence of the callout, without markdown, cut to two lines of text', () => {
    expect(shortGoal(data.standingGoal)).toBe('STANDING GOAL FOR THIS EPIC (operator, 2026-08-29): improve the prototype and the machinery it depends on — not deliver any particular backlog item.');
    expect(shortGoal('x'.repeat(500)).length).toBeLessThanOrEqual(200);
    expect(shortGoal(null)).toBe('');
  });
});

describe('the whole compact page', () => {
  const html = page();
  const at = (marker) => html.indexOf(marker);

  it('has its sections in order: header, needs you, up next, counts, notes', () => {
    const order = ['<header>', 'id="needs-you"', 'id="up-next"', 'id="counts"', 'id="notes"'].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('carries the title, the tip, the render time and the goal in the header', () => {
    expect(html).toContain(`<h1>${FIXTURE_TITLE}</h1>`);
    expect(html).toContain('<span class="stamp">tip abc1234 · rendered 2026-09-21 09:00 EDT</span>');
    expect(html).toContain('class="goal"');
  });

  it('says "none" for an empty NEEDS YOU, prints lines verbatim, and says so when the queue could not be read', () => {
    expect(html).toContain('<p class="none">none</p>');
    const lines = ['PR #2401 (web-everything/web-everything) — review:human, gates pass'];
    expect(page({ needsYou: lines })).toContain(`<pre class="needs">${lines[0]}</pre>`);
    const unread = page({ needsYou: null, needsYouError: 'operator-queue.mjs is not on any checkout found' });
    expect(unread).toContain('unavailable: operator-queue.mjs is not on any checkout found');
    expect(unread).not.toContain('<p class="none">none</p>');
  });

  it('collapses the claimed and off-path lists, and the remainder', () => {
    expect(html).toMatch(/<details><summary>5 more<\/summary>/);
    expect(html).toMatch(/<details><summary>Claimed \(2\)<\/summary>/);
    expect(html).toMatch(/<details><summary>Off-path \(1\)<\/summary>/);
  });

  it('shows the latest note as title and date only, its full text collapsed, older notes as titles only', () => {
    const notes = html.slice(at('id="notes"'));
    expect(notes).toMatch(/<p class="latest"><span class="when">2026-09-20<\/span> the latest fixture note, whose title is what the page shows<\/p>/);
    const full = notes.match(/<details><summary>Latest note, in full<\/summary>(.*?)<\/details>/s)[1];
    expect(full).toContain('LATEST-BODY-MARKER');
    expect(notes.slice(0, notes.indexOf('Latest note, in full'))).not.toContain('LATEST-BODY-MARKER');
    const older = notes.match(/<details><summary>Earlier notes \(2\)<\/summary>(.*?)<\/details>/s)[1];
    expect(older).toContain('second fixture note');
    expect(older).toContain('first fixture note');
    expect(older.indexOf('second fixture note')).toBeLessThan(older.indexOf('first fixture note'));
    for (const u of NOTES.slice(0, 2)) expect(older).not.toContain(u.body.split('\n')[0]);
  });

  it('collapses the Done-when block', () => {
    expect(html).toMatch(/<details><summary>Done when<\/summary><ol class="gate"><li>A background process can run a full cycle\.<\/li>/);
  });

  it('is a fragment with no script', () => {
    expect(html).not.toMatch(/<script|<!doctype|<html|<body/i);
    expect(html).toMatch(/^<title>Prototype Tracker — #3383<\/title>/);
  });

  it('says whether card numbers are links', () => {
    expect(html).toContain('card numbers are plain text (no base URL)');
    expect(page({ baseUrl: 'https://example.test' })).toContain('href="https://example.test/backlog/3901/"');
  });

  it('is far smaller than the full page for the same card (the size target)', () => {
    expect(Buffer.byteLength(html)).toBeLessThan(60 * 1024);
  });
});

describe('the stamp', () => {
  it('is the only thing that differs between two renders of the same content, and stripStamp removes it', () => {
    const a = page({ tip: 'aaaaaaa', generatedAt: '2026-09-21 09:00 EDT' });
    const b = page({ tip: 'bbbbbbb', generatedAt: '2026-09-21 09:31 EDT' });
    expect(a).not.toBe(b);
    expect(stripStamp(a)).toBe(stripStamp(b));
  });

  it('does not hide a real change in the content', () => {
    const changed = renderCompactHtml(data, { priority: parsePriorityRows(trackerCardText({ ordered: [...ORDERED.slice(1), ORDERED[0]] })), titles, claimedIds, needsYou: [], tip: 'abc1234', generatedAt: '2026-09-21 09:00 EDT' });
    expect(stripStamp(changed)).not.toBe(stripStamp(page()));
  });
});
