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
  it('prefixes bare file refs inside the finding summary', () => {
    const sel = [{ file: 'scripts/lib/daemon-rebuild/prepare.mjs', line: 373, summary: 'The `auditedTip: makeAuditedTipGate(env)` wiring in prepare.mjs, preview.mjs (3 sites) and smoke.mjs (2 fallback plans) has no test.' }];
    const { title, digest } = buildRulingCardInput({ head: 'abcdef012345' }, { repo: 'web-everything/web-everything', pr: 6732 }, sel);
    expect(scanRepoLocusPrefixes([{ file: 'backlog/x.md', content: `# ${title}\n\n${digest}\n` }])).toEqual([]);
  });
});
