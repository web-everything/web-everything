import { describe, it, expect } from 'vitest';
import { buildRulingCardInput } from '../record-referral-ruling.mjs';

const read = { head: 'e9b03e68e26e79dc1a2e2ece551a7918342cfb0c' };
const input = { repo: 'web-everything/web-everything', pr: 6745, notWorseThanMain: 'coverage-only gap' };
const selected = [{ file: 'scripts/readiness/forge-exec-run.mjs', line: 789, summary: 'COVERAGE: The guarantee that all four credential IDs must match lacks a mixed-ID test.' }];

describe('buildRulingCardInput — dedupe-friendly specificity', () => {
  it('title names the finding (file:line + summary), not generic boilerplate', () => {
    const { title } = buildRulingCardInput(read, input, selected);
    expect(title).toContain('we:forge-exec-run.mjs:789'); // locus-prefixed: a bare code-path ref is refused at file time (#883)
    expect(title).toContain('mixed-ID test');
    expect(title).toContain('#6745');
    expect(title).not.toMatch(/^Follow-up from/);
  });
  it('the digest lead paragraph (the dedupe query) starts with the findings, boilerplate after', () => {
    const { digest } = buildRulingCardInput(read, input, selected);
    const lead = digest.split(/\r?\n[\t ]*\r?\n/, 1)[0];
    expect(lead).toContain('forge-exec-run.mjs:789');
    expect(lead).not.toMatch(/Operator card follow-up/);
    expect(digest).toMatch(/Operator card follow-up for web-everything\/web-everything#6745/);
    expect(digest).toContain('Not worse than main (R903)');
  });
});

import { parseFilingItems, reduceFilingInput, remainingAfter, filingSource } from '../../lib/card-dedupe.mjs';
describe('buildRulingCardInput — the real digest survives a partial dedupe (reduceFilingInput / remainingAfter)', () => {
  const two = [
    { file: 'scripts/readiness/forge-exec-run.mjs', line: 789, summary: 'COVERAGE: mixed-ID test is missing.' },
    { file: 'scripts/lib/other-thing.mjs', line: 12, summary: 'A second, unrelated finding.' },
  ];
  const built = buildRulingCardInput(read, input, two);
  const items = parseFilingItems(built.digest);
  const matched = [{ item: items[0], card: { id: 'x1y2z3' } }];

  it('keeps the PR/head provenance and the R903 evidence after the unmatched findings', () => {
    for (const reduced of [reduceFilingInput(built, [items[1]], matched), remainingAfter(built, matched)]) {
      expect(reduced.digest).toContain('1. `we:scripts/lib/other-thing.mjs:12`');
      expect(reduced.digest).not.toContain('forge-exec-run.mjs:789');
      expect(reduced.digest).toContain(`Operator card follow-up for web-everything/web-everything#6745 (head ${read.head}).`);
      expect(reduced.digest).toContain('Not worse than main (R903): coverage-only gap');
      expect(reduced.digest).toContain('Already tracked on open cards');
      expect(filingSource({ digest: reduced.digest })).toEqual({ repo: 'web-everything/web-everything', pr: 6745 });
    }
  });
  it('keeps the trailer ahead of the idempotency-key tail and does not duplicate it', () => {
    const keyed = { ...built, digest: `${built.digest}\n\nIdempotency key (do not edit): approval-prevention-key:o/r#9` };
    const reduced = reduceFilingInput(keyed, [items[1]], matched);
    expect(reduced.digest.indexOf('Operator card follow-up')).toBeLessThan(reduced.digest.indexOf('Idempotency key'));
    expect(reduced.digest.match(/Operator card follow-up/g)).toHaveLength(1);
    expect(reduced.digest.endsWith('approval-prevention-key:o/r#9')).toBe(true);
  });
  it('a continuation line glued to the last finding is not copied into the refile as a trailer', () => {
    const glued = { ...built, digest: built.digest.replace('\n\nOperator card', '\n   continuation of finding 2\n\nOperator card') };
    const reduced = reduceFilingInput(glued, [parseFilingItems(glued.digest)[0]], [{ item: parseFilingItems(glued.digest)[1], card: { id: 'x1y2z3' } }]);
    expect(reduced.digest).not.toContain('continuation of finding 2');
    expect(reduced.digest).toContain('Operator card follow-up for web-everything/web-everything#6745');
  });
  it('a digest with no trailer reduces exactly as before (no stray blank paragraph)', () => {
    const bare = { ...built, digest: built.digest.split(/\n\n/, 1)[0] };
    const reduced = reduceFilingInput(bare, [parseFilingItems(bare.digest)[1]], matched);
    expect(reduced.digest.endsWith('.')).toBe(true);
    expect(reduced.digest).not.toMatch(/\n\n\n/);
  });
});

import { scanRepoLocusPrefixes } from '../../check-standards-rules.mjs';
describe('buildRulingCardInput — title passes the locus-prefix check for quoted paths', () => {
  it('prefixes every ref the real gate flags: css/tsx/html/yaml, brackets, quotes, colons, and already-marked refs are left alone', () => {
    const summaries = [
      'Add a test for src/css/style.css before changing its layout.',
      'The component src/ui/Button.tsx and [theme.css] and "index.html" and (config.yaml) are untested; fui:src/keep.ts stays.',
      'See src/a/b.yml:12, then x.njk; also we:scripts/already.mjs.',
    ];
    for (const summary of summaries) {
      const { title, digest } = buildRulingCardInput({ head: 'abcdef012345' }, { repo: 'web-everything/web-everything', pr: 6732 }, [{ file: 'scripts/lib/prepare.mjs', line: 12, summary }]);
      expect(scanRepoLocusPrefixes([{ file: 'backlog/x.md', content: `# ${title}\n\n${digest}\n` }])).toEqual([]);
      expect(digest).not.toMatch(/we:we:|we:fui:|fui:we:/); // never double-prefixed
    }
    const { digest } = buildRulingCardInput({ head: 'abcdef012345' }, input, [{ file: 'scripts/lib/prepare.mjs', line: 12, summary: summaries[0] }]);
    expect(digest).toContain('we:src/css/style.css');
  });
  it('prefixes only the occurrences the gate flags: link targets, @scope, globs, URLs and fences stay as written', () => {
    const summary = 'Cover x.md: see [x.md](x.md), @org/pkg.js, *glob.ts, https://h.io/a/page.html and ```inline fence.json``` but bare x.md and fence.json fail; also a.mdX and b.ts2.';
    const { digest } = buildRulingCardInput({ head: 'abcdef012345' }, input, [{ file: 'scripts/lib/prepare.mjs', line: 12, summary }]);
    expect(digest).toContain('[we:x.md](x.md)'); // link text carries the locus, target untouched
    expect(digest).toContain('@org/pkg.js');
    expect(digest).not.toContain('@we:');
    expect(digest).toContain('*glob.ts');
    expect(digest).toContain('https://h.io/a/page.html');
    expect(digest).toContain('```inline fence.json```');
    expect(digest).toContain('but bare we:x.md and we:fence.json fail');
    expect(digest).not.toMatch(/we:we:/);
  });
  it('a fenced summary cut at 90 chars never leaves an unmatched fence in the title that pairs with the digest fences', () => {
    const fence = '`'.repeat(3);
    const summaries = [
      `Inspect ${fence}${'code '.repeat(19)}scripts/a.mjs${fence} before adding a regression test.`,
      `Inspect ~~~${'code '.repeat(19)}scripts/a.mjs~~~ before adding a regression test.`,
      `Inspect \`${'code '.repeat(19)}scripts/a.mjs\` before adding a regression test.`,
      `${fence}${'x'.repeat(88)}${fence} scripts/a.mjs`,
    ];
    for (const summary of summaries) {
      const { title, digest } = buildRulingCardInput({ head: 'abcdef012345' }, input, [{ file: 'scripts/test.mjs', line: 10, summary }]);
      expect(title).not.toMatch(/[`~]/);
      expect(scanRepoLocusPrefixes([{ file: 'backlog/x.md', content: `# ${title}\n\n${digest}\n` }])).toEqual([]);
    }
  });
  it('prefixes bare file refs inside the finding summary', () => {
    const sel = [{ file: 'scripts/lib/daemon-rebuild/prepare.mjs', line: 373, summary: 'The `auditedTip: makeAuditedTipGate(env)` wiring in prepare.mjs, preview.mjs (3 sites) and smoke.mjs (2 fallback plans) has no test.' }];
    const { title, digest } = buildRulingCardInput({ head: 'abcdef012345' }, { repo: 'web-everything/web-everything', pr: 6732 }, sel);
    expect(scanRepoLocusPrefixes([{ file: 'backlog/x.md', content: `# ${title}\n\n${digest}\n` }])).toEqual([]);
  });
});

import { retitle } from '../land-prevention-card.mjs';
describe('buildRulingCardInput — partial dedupe retitles the remaining card (finding 1)', () => {
  const two = [
    { file: 'scripts/readiness/forge-exec-run.mjs', line: 789, summary: 'COVERAGE: The guarantee that all four credential IDs must match lacks a mixed-ID test.' },
    { file: 'scripts/lib/other-thing.mjs', line: 12, summary: 'A second, unrelated finding about `fenced` handling in x.md.' },
    { file: 'scripts/lib/third.mjs', line: 3, summary: 'A third finding.' },
  ];
  const built = buildRulingCardInput(read, input, two);
  const items = parseFilingItems(built.digest);
  it('names the first RETAINED finding, drops the removed one, and recounts "(+N more)"', () => {
    const one = reduceFilingInput(built, [items[1]], [{ item: items[0], card: { id: 'x1y2z3' } }]);
    const t = retitle(one, built);
    expect(t).toContain('we:other-thing.mjs:12');
    expect(t).not.toContain('forge-exec-run');
    expect(t).not.toContain('mixed-ID');
    expect(t).not.toContain('more)');
    expect(t).toContain('(web-everything#6745)');
    const two2 = reduceFilingInput(built, [items[1], items[2]], [{ item: items[0], card: { id: 'x1y2z3' } }]);
    expect(retitle(two2, built)).toContain('(+1 more)');
    expect(retitle(two2, built)).toContain('we:other-thing.mjs:12');
  });
  it('an unreduced filing keeps its title untouched', () => {
    expect(retitle(built, built)).toBe(built.title);
  });
  it('the retitled title is plain text and gate-clean (fenced/bare refs from the digest claim cannot leak into it)', () => {
    const one = reduceFilingInput(built, [items[1]], [{ item: items[0], card: { id: 'x1y2z3' } }]);
    const t = retitle(one, built);
    expect(t).not.toMatch(/[`~]/);
    expect(scanRepoLocusPrefixes([{ file: 'backlog/x.md', content: `# ${t}\n\n${one.digest}\n` }])).toEqual([]);
  });
  it('is idempotent with the original builder: the first finding kept → same title as a fresh build of that finding', () => {
    const solo = buildRulingCardInput(read, input, [two[1]]);
    const one = reduceFilingInput(built, [items[1]], [{ item: items[0], card: { id: 'x1y2z3' } }]);
    expect(retitle(one, built)).toBe(solo.title);
  });
  it('the retitled card no longer carries the removed finding\'s wording (the words the duplicate check scores)', () => {
    const one = reduceFilingInput(built, [items[1]], [{ item: items[0], card: { id: 'x1y2z3' } }]);
    expect(retitle(one, built)).not.toMatch(/credential|mixed/);
  });
});

import { overlapScore, EXACT_THRESHOLD } from '../../capability-search.mjs';
import { tokens } from '../../conveyor/learnings-dedup.mjs';
describe('buildRulingCardInput — the retitled card is admitted by the duplicate check that blocked it (finding 1)', () => {
  const fence = '`'.repeat(3);
  const first = { file: 'scripts/readiness/forge-exec-run.mjs', line: 789, summary: 'COVERAGE: The guarantee that all four credential IDs must match lacks a mixed-ID test.' };
  const second = { file: 'scripts/lib/other-thing.mjs', line: 12, summary: 'A second, unrelated finding.' };
  it('file-item admission queries the title; the open card for the FIRST finding scores >= the threshold on the old title, below it on the retitle', () => {
    const openCard = buildRulingCardInput(read, { ...input, pr: 6700 }, [first]); // the card already tracking the first finding
    const cardText = `${openCard.title} ${openCard.digest.split(/\n\n/, 1)[0]}`;
    const built = buildRulingCardInput(read, input, [first, second]);
    const items = parseFilingItems(built.digest);
    const reduced = reduceFilingInput(built, [items[1]], [{ item: items[0], card: { id: 'x1y2z3' } }]);
    const score = (t) => overlapScore(tokens(t), tokens(cardText)).score;
    expect(score(built.title)).toBeGreaterThanOrEqual(EXACT_THRESHOLD); // what threw 'possible duplicate backlog cards'
    expect(score(retitle(reduced, built))).toBeLessThan(EXACT_THRESHOLD);
  });
  it('fences that do not pair inside one summary cannot pair with the next finding, whole or after a partial dedupe', () => {
    const odd = { file: 'scripts/lib/a.mjs', line: 1, summary: `use ${fence} here` };
    const fenced = { file: 'scripts/lib/b.mjs', line: 2, summary: `${fence}scripts/x.mjs${fence} is untested` };
    const b = buildRulingCardInput(read, input, [odd, fenced]);
    const its = parseFilingItems(b.digest);
    const gateClean = (t, d) => scanRepoLocusPrefixes([{ file: 'backlog/x.md', content: `# ${t}\n\n${d}\n` }]);
    expect(gateClean(b.title, b.digest)).toEqual([]);
    const dropOdd = reduceFilingInput(b, [its[1]], [{ item: its[0], card: { id: 'x1y2z3' } }]);
    expect(gateClean(retitle(dropOdd, b), dropOdd.digest)).toEqual([]);
    const dropFenced = reduceFilingInput(b, [its[0]], [{ item: its[1], card: { id: 'x1y2z3' } }]);
    expect(gateClean(retitle(dropFenced, b), dropFenced.digest)).toEqual([]);
  });
});

describe('buildRulingCardInput — a metadata-like summary is prefixed in its FINAL context (finding 2)', () => {
  const metaSummaries = [
    'relatedReport: reports/coverage.md is missing a regression test.',
    'graduatedTo: docs/a.md and crossRef: docs/b.md',
    '  codifiedIn: scripts/x.mjs lacks a test',
  ];
  it.each(metaSummaries)('%s passes the real gate (title + digest)', (summary) => {
    const { title, digest } = buildRulingCardInput(read, input, [{ file: 'scripts/lib/prepare.mjs', line: 12, summary }]);
    expect(scanRepoLocusPrefixes([{ file: 'backlog/x.md', content: `# ${title}\n\n${digest}\n` }])).toEqual([]);
    expect(digest).toContain('we:');
    expect(digest).not.toMatch(/we:we:/);
  });
  it('a metadata-like first finding is also gate-clean after a partial dedupe retitle', () => {
    const b = buildRulingCardInput(read, input, [two0(), { file: 'scripts/lib/p.mjs', line: 1, summary: 'relatedReport: reports/coverage.md is missing a test.' }]);
    const its = parseFilingItems(b.digest);
    const one = reduceFilingInput(b, [its[1]], [{ item: its[0], card: { id: 'x1y2z3' } }]);
    expect(scanRepoLocusPrefixes([{ file: 'backlog/x.md', content: `# ${retitle(one, b)}\n\n${one.digest}\n` }])).toEqual([]);
  });
  it('a bare path in the R903 evidence trailer is prefixed (the gate refuses it otherwise)', () => {
    const { title, digest } = buildRulingCardInput(read, { ...input, notWorseThanMain: 'relatedReport: reports/coverage.md is unchanged on main' }, [two0()]);
    expect(digest).toContain('we:reports/coverage.md');
    expect(scanRepoLocusPrefixes([{ file: 'backlog/x.md', content: `# ${title}\n\n${digest}\n` }])).toEqual([]);
  });
  function two0() { return { file: 'scripts/lib/a.mjs', line: 2, summary: 'Another finding.' }; }
});
