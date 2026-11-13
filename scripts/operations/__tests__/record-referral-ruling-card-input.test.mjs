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
