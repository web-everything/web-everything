/**
 * Card xet6iu0 — replay fixtures for the class-sweep rule (protocol card 5468's shape: facts + setting in, verdict out).
 * Three fixtures are REAL fixer evidence comments from 2026-10-08 (PRs 4441, 4481, 4478): none carries a structured
 * sweep, so each is `missing` — including 4478, whose fixer swept the class in prose (a sentence is not a record).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classSweepVerdict, extractSweepBlocks, checkSweep, formatClassSweep, MAX_EVIDENCE_BYTES, SWEEP_PATHS } from '../class-sweep-rule.mjs';

const FIXTURES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/class-sweep-replay.json'), 'utf8'));
const pick = (v) => ({ status: v.status, reason: v.reason, blocking: v.blocking });

describe('class-sweep rule — replay fixtures', () => {
  it.each(FIXTURES.map((f) => [f.name, f]))('%s', (_name, fixture) => {
    expect(pick(classSweepVerdict(fixture.facts))).toEqual(fixture.expect);
  });

  it('the fixtures discriminate: a rule that accepts any fenced block, or prose, fails them', () => {
    const lenient = (facts) => {
      const v = classSweepVerdict(facts);
      return ['missing', 'incomplete', 'malformed'].includes(v.status) && facts.mode !== 'off' && /class|sibling/i.test(facts.evidence ?? '')
        ? { ...v, status: 'complete', reason: 'every-finding-has-class-and-four-sibling-paths', blocking: false } : v;
    };
    const failing = FIXTURES.filter((f) => JSON.stringify(pick(lenient(f.facts))) !== JSON.stringify(f.expect)).map((f) => f.name);
    expect(failing).toEqual(expect.arrayContaining(['recovery-path-not-swept', 'n-a-needs-a-reason']));
  });

  it('warn never blocks; only enforce does', () => {
    for (const f of FIXTURES) if (f.facts.mode !== 'enforce') expect(classSweepVerdict(f.facts).blocking, f.name).toBe(false);
  });

  it('a block past the size bound is not read (bounded before parsing)', () => {
    const block = '\n```class-sweep\n{"v":1,"findings":[]}\n```\n';
    const v = classSweepVerdict({ mode: 'warn', changeKind: 'fix', evidence: 'x'.repeat(MAX_EVIDENCE_BYTES + 10) + block });
    expect(pick(v)).toEqual({ status: 'missing', reason: 'evidence-truncated-before-block', blocking: false });
  });
});

describe('class-sweep rule — parts', () => {
  it('finds a fenced block with backticks or tildes, and only with the class-sweep info string', () => {
    expect(extractSweepBlocks('a\n~~~class-sweep\n{}\n~~~\nb').blocks).toEqual(['{}']);
    expect(extractSweepBlocks('```json\n{}\n```').blocks).toEqual([]);
  });

  it('records the cleaned sweep and lists every missing path', () => {
    const r = checkSweep(JSON.stringify({ v: 1, findings: [{ finding: 'F2', class: 'shared state', siblings: [{ path: 'family', status: 'fixed', site: 'a.mjs#f' }] }] }));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(SWEEP_PATHS.filter((p) => p !== 'family').map((p) => `F2: missing-${p}`));
    expect(r.sweep.findings[0]).toMatchObject({ finding: 'F2', class: 'shared state' });
  });

  it('the printed line carries codes and counts, never the evidence text', () => {
    const v = classSweepVerdict({ mode: 'warn', changeKind: 'fix', evidence: '```class-sweep\n{"v":1,"findings":[{"finding":"F1\\n@someone <!--","class":"","siblings":[]}]}\n```' });
    const line = formatClassSweep(v);
    expect(line).not.toMatch(/\n|@someone|<!--/);
    expect(line).toContain('incomplete');
  });
});
