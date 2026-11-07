import { describe, it, expect } from 'vitest';
import { createFailureCollector, boundFailureDetails } from '../verify-failures.mjs';

describe('bounded failure diagnostics', () => {
  it('recognizes ANSI Vitest summaries, nested names, suite failures and duplicate records across split streams', () => {
    const c = createFailureCollector({ cwd: '/checkout' });
    c.push('\x1b[31m FA');
    c.push('IL  suite.test.ts > outer > inner\x1b[39m\n');
    c.push(' FAIL  suite.test.ts > outer > inner\n', 'stderr');
    c.push(' FAIL  /checkout/collection.test.mjs\n', 'stderr');
    expect(c.finish().tests).toEqual([
      { file: 'suite.test.ts', name: 'outer > inner' },
      { file: 'collection.test.mjs', name: null },
    ]);
  });
  it('keeps independent partial lines and decodes UTF-8 split between bytes', () => {
    const c = createFailureCollector();
    const bytes = Buffer.from(' FAIL  café.test.ts > 🦊\n');
    for (const byte of bytes) { c.push(Buffer.from([byte])); c.push('noise\n', 'stderr'); }
    expect(c.finish().tests).toEqual([{ file: 'café.test.ts', name: '🦊' }]);
  });
  it('never invents identities from unknown or malformed output', () => {
    const c = createFailureCollector();
    c.push('build broke\nFAIL no-file\nFAIL ../outside.test.ts > bad\n');
    expect(c.finish()).toMatchObject({ tests: [], summary: expect.stringContaining('build broke') });
  });
  it('soaks oversized lines and many failures with bounded retained evidence', () => {
    const c = createFailureCollector();
    for (let i = 0; i < 1000; i++) c.push('x'.repeat(10000));
    c.push('\n');
    for (let i = 0; i < 1000; i++) c.push(` FAIL  ${i}.test.ts > ${'🦊'.repeat(600)}\n`);
    const result = c.finish();
    expect(result.truncated).toBe(true);
    expect(result.tests.length).toBeLessThanOrEqual(20);
    expect(result.tests.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16384);
    expect(Buffer.byteLength(result.summary)).toBeLessThanOrEqual(2048);
    expect(result.tests.every(t => Array.from(t.name).length <= 512)).toBe(true);
  });
  it('bounds JSON escaping overhead and flags dropped entries', () => {
    const result = boundFailureDetails({ tests: Array.from({ length: 21 }, () => ({ file: '\u0000'.repeat(600), name: '\u0001'.repeat(600) })), summary: '🦊'.repeat(2000) });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16384);
  });
});

it('normal progress rolling out of the summary does not truncate the failure inventory', () => {
  const collector = createFailureCollector();
  collector.push('passed file\n'.repeat(148));
  collector.push(' FAIL  untouched.test.mjs > times out\nError: Test timed out in 5000ms.\n');
  expect(collector.finish()).toMatchObject({
    tests: [{ file: 'untouched.test.mjs', name: 'times out' }], truncated: false,
  });
});


it('records grouped per-test timeouts in the marker and keeps assertions distinct', async () => {
  const { verifyFinishBody } = await import('../lane-verify.mjs');
  const c = createFailureCollector();
  c.push('FAIL a.test.mjs > slow\nFAIL b.test.mjs > slow too\nError: Test timed out in 15000ms.\n⎯⎯[1/3]⎯\nFAIL c.test.mjs > real failure\nAssertionError: expected true\n', 'stderr');
  const m = verifyFinishBody({}, { exitCode: 1, failureDetails: c.finish() });
  expect(m.failureDetails.tests).toEqual([
    { file: 'a.test.mjs', name: 'slow', timeout: true },
    { file: 'b.test.mjs', name: 'slow too', timeout: true },
    { file: 'c.test.mjs', name: 'real failure' },
  ]);
});

it('an assertion error body prevents a later timeout from relabelling the same test', () => {
  const c = createFailureCollector();
  c.push('FAIL a.test.mjs > mixed\nAssertionError: expected true\nError: Test timed out in 15000ms.\n', 'stderr');
  expect(c.finish().tests[0].timeout).toBeUndefined();
});
it('keeps timeout association within its stream and refuses suite/unhandled evidence', () => {
  const c = createFailureCollector();
  c.push('FAIL a.test.mjs > unknown\n');
  c.push('Error: Test timed out in 15000ms.\nUnhandled Errors\n', 'stderr');
  expect(c.finish()).toMatchObject({ tests: [{ file: 'a.test.mjs', name: 'unknown' }], truncated: true });
});
