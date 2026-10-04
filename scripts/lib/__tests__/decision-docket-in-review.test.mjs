/**
 * @file decision-docket-in-review.test.mjs — the Decision Docket LISTS a decision that has an open pull request
 * (a ratification or preparation awaiting review) in its own "In review: a PR is open" section, instead of the old
 * behaviour of leaving it off the docket without a word.
 *
 * Three layers, each proving something the others cannot:
 *   1. the PURE data helpers (PR kind from the title prefix, which PR a row is listed under, the counts);
 *   2. the pure renderer over hand-built rows (section order, counts strip, filter, no raw markdown, and a page
 *      with NO open PRs is byte-identical to the page before this change);
 *   3. the REAL mechanism — `scripts/gen-decision-docket.mjs` spawned as a subprocess, which itself spawns the
 *      real `check-readiness.mjs` + loader, over a throwaway backlog corpus and an offline open-PR list
 *      (`WE_BACKLOG_DIR` / `WE_OPEN_PRS_FILE` / `--no-fetch`: no network, no `gh`, no origin fetch).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildDecisionRecord, classifyPrKind, computeCounts, pickPr } from '../decision-docket-data.mjs';
import { renderDocketHtml } from '../decision-docket-render.mjs';
import { findRawMarkers } from './fixtures/docket-raw-markers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const TEMPLATE = readFileSync(join(ROOT, 'skills-src/decision-docket/template.html'), 'utf8');
const NOW = new Date('2026-09-21T12:00:00Z');
const PR_URL = (n) => `https://github.com/web-everything/web-everything/pull/${n}`;

describe('classifyPrKind / pickPr', () => {
  it('reads the kind off the title prefix, for THIS item only', () => {
    expect(classifyPrKind('ratify #3375: creator-owed proof', '3375')).toBe('ratification');
    expect(classifyPrKind('Ratify #3375 — x', 3375)).toBe('ratification');
    expect(classifyPrKind('prepare #3658: author the forks', '3658')).toBe('preparation');
    expect(classifyPrKind('decision-docket: rewrite #3699 as a merit fork', '3699')).toBe('other');
    expect(classifyPrKind('ratify #3375: x', '3376')).toBe('other'); // names a different item
    expect(classifyPrKind('', '1')).toBe('other');
    expect(classifyPrKind(undefined, '1')).toBe('other');
  });

  it('lists a row under its ratification over a preparation over any other PR, then the newest number', () => {
    const prs = [
      { number: 5, title: 'tidy #10', url: PR_URL(5) },
      { number: 3, title: 'prepare #10: forks', url: PR_URL(3) },
      { number: 4, title: 'ratify #10: ruling', url: PR_URL(4) },
      { number: 9, title: 'ratify #10: ruling, second try', url: PR_URL(9) },
    ];
    expect(pickPr('10', prs)).toEqual({ number: 9, state: 'open', kind: 'ratification', title: 'ratify #10: ruling, second try', url: PR_URL(9), repo: null });
    expect(pickPr('10', prs.slice(0, 2)).kind).toBe('preparation');
    expect(pickPr('10', prs.slice(0, 1)).kind).toBe('other');
    expect(pickPr('10', [])).toBeNull();
    expect(pickPr('10', undefined)).toBeNull();
  });

  it('computeCounts: open and prepared include the in-review rows; inReview counts the ones with a PR', () => {
    const items = [{ prepared: true, pr: null }, { prepared: true, pr: { number: 1 } }, { prepared: false, pr: { number: 2 } }, { prepared: false, pr: null }];
    expect(computeCounts(items)).toEqual({ open: 4, prepared: 2, inReview: 2 });
    expect(computeCounts([])).toEqual({ open: 0, prepared: 0, inReview: 0 });
  });

  it('buildDecisionRecord carries the PR and its blockers; a plain row has pr: null and no blockers', () => {
    const entry = { num: '9106', title: 'T', prepared: false, prs: [{ number: 7, title: 'prepare #9106: forks', url: PR_URL(7), repo: 'web-everything/web-everything' }], blockedBy: ['9105'] };
    const rec = buildDecisionRecord(entry, null, NOW);
    expect(rec.pr).toEqual({ number: 7, state: 'open', kind: 'preparation', title: 'prepare #9106: forks', url: PR_URL(7), repo: 'web-everything/web-everything' });
    expect(rec.blockedBy).toEqual(['9105']);
    const plain = buildDecisionRecord({ num: '1', title: 'T' }, null, NOW);
    expect(plain.pr).toBeNull();
    expect(plain.blockedBy).toEqual([]);
  });
});

function row(num, over = {}) {
  return {
    num: String(num), title: `Decision ${num}`, prepared: false, preparedDate: null, leverageScore: 10, directUnblocks: 1,
    transitiveUnblocks: 1, unblocksToReady: 1, ageInDays: 5, digest: [], forks: [], doneWhen: [], parseOk: true, warnings: [],
    pr: null, blockedBy: [], ...over,
  };
}
const prOf = (number, kind, extra = {}) => ({ number, state: 'open', kind, title: `${kind} #x: t`, url: PR_URL(number), repo: 'web-everything/web-everything', ...extra });

describe('renderDocketHtml — the In review section', () => {
  const data = {
    generatedFromRef: 'origin/main',
    items: [
      row(1, { title: 'Plain `ranked` decision', leverageScore: 50 }),
      row(2, { title: 'Ratify me **now**', prepared: true, preparedDate: '2026-09-01', leverageScore: 5, pr: prOf(2376, 'ratification') }),
      row(3, { title: 'Prepare me', leverageScore: 90, pr: prOf(2375, 'preparation') }),
      row(4, { title: 'Blocked and in review', leverageScore: 1, pr: prOf(2399, 'other', { repo: 'frontier-ui/frontierui' }), blockedBy: ['1770', '1979'] }),
    ],
  };
  const html = renderDocketHtml(data, TEMPLATE, { now: NOW });

  it('puts the section first: before the ranked table, the prepared cards and the upstream table', () => {
    const at = (needle) => html.indexOf(needle);
    expect(at('In review: a PR is open')).toBeGreaterThan(-1);
    expect(at('In review: a PR is open')).toBeLessThan(at('The docket — ranked by leverage'));
    expect(at('The docket — ranked by leverage')).toBeLessThan(at('Not yet prepared'));
  });

  it('lists each in-review decision once, only in that section, ratifications first', () => {
    const start = html.indexOf('<section id="in-review">');
    const end = html.indexOf('</section>', start);
    const review = html.slice(start, end);
    const rest = html.slice(end);
    for (const n of [2, 3, 4]) {
      expect(review).toContain(`#${n}</td>`);
      expect(rest).not.toContain(`>#${n}</td>`);
    }
    expect(rest).toContain('>#1</td>');
    expect(review).not.toContain('>#1</td>');
    expect(review.indexOf('#2</td>')).toBeLessThan(review.indexOf('#3</td>'));
    expect(review.indexOf('#3</td>')).toBeLessThan(review.indexOf('#4</td>'));
  });

  it('shows the PR number as a link, its kind and a one-line state; a sibling-repo PR names its repo; blockers are named', () => {
    expect(html).toContain(`<a href="${PR_URL(2376)}" title="ratification #x: t">PR #2376</a>`);
    expect(html).toContain('<span class="pill batchp">ratification</span> Ratification proposed; merging the PR rules this decision.');
    expect(html).toContain('<span class="pill batchp">preparation</span> Preparation in review; its forks land when the PR merges.');
    expect(html).toContain('frontierui PR #2399</a>');
    expect(html).toContain('An open PR touches this decision. Blocked by #1770, #1979.');
  });

  it('counts strip and lede: an In review tile, and the lede says how the open decisions split', () => {
    expect(html).toContain('<div class="stat r"><div class="v">3</div><div class="k">In review &mdash; PR open</div></div>');
    expect(html).toContain('<b>4 are open: 3 have a pull request open, 0 more are prepared and awaiting ratification, and 1 needs preparation.</b>');
    expect(html).toContain('<div class="stat a"><div class="v">0</div><div class="k">Ready to ratify</div></div>');
    expect(html).toContain('data-group="status" data-value="review">In review</button>');
  });

  it('a PREPARED in-review decision keeps its full card (the hard rule), tagged with its PR, and its row links to it; an un-prepared one gets no card or link', () => {
    expect(html).toContain('<div class="dcard" id="item-2" data-status="review"');
    expect(html).toContain('· PR #2376 in review</span>');
    expect(html).toContain('<a href="#item-2">');
    expect(html).not.toContain('id="item-3"');
    expect(html).not.toContain('href="#item-3"');
  });

  it('never leaves a raw markdown marker in the page', () => {
    expect(findRawMarkers(html)).toEqual([]);
    expect(html).toContain('Ratify me <strong>now</strong>');
  });

  it('refuses a non-https PR url as a link (the data file is plain JSON on disk)', () => {
    const bad = { items: [row(5, { pr: prOf(1, 'other', { url: 'javascript:alert(1)' }) })] };
    const out = renderDocketHtml(bad, TEMPLATE, { now: NOW });
    expect(out).not.toContain('javascript:');
    expect(out).toContain('>PR #1<');
  });

  it('a docket with no open PRs renders byte-identical to before: no section, no tile, no filter button', () => {
    const plain = { generatedFromRef: 'origin/main', items: data.items.filter((i) => !i.pr) };
    const legacy = { generatedFromRef: 'origin/main', items: plain.items.map(({ pr, blockedBy, ...rest }) => rest) }; // a data file from before this change
    const out = renderDocketHtml(plain, TEMPLATE, { now: NOW });
    expect(out).toBe(renderDocketHtml(legacy, TEMPLATE, { now: NOW }));
    expect(out).not.toContain('in-review');
    expect(out).not.toContain('In review');
    expect(out).toContain('<b>0 are prepared and awaiting ratification.</b>');
  });
});

// ── the real mechanism ────────────────────────────────────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'docket-in-review-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PREPARED_BODY = (title) => `# ${title}

The digest paragraph.

## Fork 1 — which way?

Because the two ways differ.

- **(a)** Way A. **Rejected**: it is worse.
- **(b)** **Way B** ← **RECOMMENDED**.

**Skeptic:** SURVIVES.
**Screen:** clear.

## Done when

1. It ships.
`;
function card(name, fm, body) {
  const lines = Object.entries({ kind: 'decision', status: 'open', dateOpened: '"2026-08-01"', ...fm }).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(tmp, 'backlog', `${name}.md`), `---\n${lines.join('\n')}\n---\n\n${body}`);
}

function runRealGenerator() {
  mkdirSync(join(tmp, 'backlog'), { recursive: true });
  card('9101-ratified-by-pr', { preparedDate: '"2026-09-01"' }, PREPARED_BODY('Ratify this: a `code` title'));
  card('9102-prepared-by-pr', {}, '# Prepare this one\n\nNot yet prepared.\n');
  card('9103-blocked-only', { blockedBy: '["9105"]' }, '# Blocked, no PR\n\nWaiting on 9105.\n');
  card('9104-plain', { preparedDate: '"2026-09-02"' }, PREPARED_BODY('The plain prepared decision'));
  card('9105-the-blocker', { kind: 'task' }, '# The open blocker\n\nA task.\n');
  card('9106-blocked-and-pr', { blockedBy: '["9105"]' }, '# Blocked and has a PR\n\nWaiting on 9105, PR open.\n');
  const prs = [
    { number: 9901, title: 'ratify #9101: rule it', headRefName: 'lane/ratify-9101', url: PR_URL(9901) },
    { number: 9902, title: 'prepare #9102: author the forks', headRefName: 'lane/prepare-9102', url: PR_URL(9902) },
    { number: 9906, title: 'prepare #9106: author the forks', headRefName: 'lane/prepare-9106', url: PR_URL(9906) },
    { number: 9999, title: 'unrelated change', headRefName: 'lane/unrelated', url: PR_URL(9999) },
  ];
  writeFileSync(join(tmp, 'prs.json'), JSON.stringify(prs));
  const env = { ...process.env, WE_BACKLOG_DIR: join(tmp, 'backlog'), WE_OPEN_PRS_FILE: join(tmp, 'prs.json') };
  const dataPath = join(tmp, 'data.json');
  const pagePath = join(tmp, 'page.html');
  const run = (...args) => execFileSync('node', ['scripts/gen-decision-docket.mjs', ...args], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = run('data', '--no-fetch', '--allow-stale', `--out=${dataPath}`);
  run('render', `--data=${dataPath}`, `--out=${pagePath}`);
  return { stdout, data: JSON.parse(readFileSync(dataPath, 'utf8')), html: readFileSync(pagePath, 'utf8') };
}

describe('the real generator CLI over a fixture corpus (offline)', () => {
  const { stdout, data, html } = runRealGenerator();
  const byNum = Object.fromEntries(data.items.map((i) => [i.num, i]));

  it('lists the open-PR decisions (ready or blocked) with a pr field; leaves the blocked-only one off', () => {
    expect(Object.keys(byNum).sort()).toEqual(['9101', '9102', '9104', '9106']);
    expect(byNum['9101'].pr).toEqual({ number: 9901, state: 'open', kind: 'ratification', title: 'ratify #9101: rule it', url: PR_URL(9901), repo: 'web-everything/web-everything' });
    expect(byNum['9102'].pr).toMatchObject({ number: 9902, kind: 'preparation', url: PR_URL(9902) });
    expect(byNum['9106'].pr).toMatchObject({ number: 9906, kind: 'preparation' });
    expect(byNum['9106'].blockedBy).toEqual(['9105']); // blocked AND in review: listed, and says what blocks it
    expect(byNum['9104'].pr).toBeNull();
    expect(byNum['9101'].prepared).toBe(true);
    expect(byNum['9102'].prepared).toBe(false);
  });

  it('counts: open and prepared now include the in-review rows, and inReview is new', () => {
    expect(data.counts).toEqual({ open: 4, prepared: 2, inReview: 3 });
    expect(stdout).toContain('wrote 4 decision record(s) (2 prepared, 3 in review');
  });

  it('renders the In review section first, with the linked PRs; the plain decision stays in the ranked docket', () => {
    const review = html.slice(html.indexOf('<section id="in-review">'), html.indexOf('</section>', html.indexOf('<section id="in-review">')));
    expect(html.indexOf('In review: a PR is open')).toBeLessThan(html.indexOf('The docket — ranked by leverage'));
    for (const n of ['9101', '9102', '9106']) expect(review).toContain(`#${n}</td>`);
    expect(review).not.toContain('#9104</td>');
    expect(review).not.toContain('#9103</td>');
    expect(html).not.toContain('#9103'); // blocked with no PR: still excluded, and not mentioned
    expect(review).toContain(`<a href="${PR_URL(9901)}"`);
    expect(review).toContain('Blocked by #9105.');
    expect(html.slice(html.indexOf('</section>', html.indexOf('<section id="in-review">')))).toContain('#9104</td>');
    expect(html).toContain('<b>4 are open: 3 have a pull request open, 1 more is prepared and awaiting ratification, and 0 need preparation.</b>');
    expect(findRawMarkers(html)).toEqual([]);
  });
});
