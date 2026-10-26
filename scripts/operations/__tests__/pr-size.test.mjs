import { describe, expect, it, vi } from 'vitest';
import { prSizeOperation, finishPrSize } from '../pr-size.mjs';
import { createPrSizeReader } from '../pr-size-io.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const limit = 300;

function assess(readDiff) {
  const declaration = prSizeOperation({ readDiff });
  const run = declaration.steps.find(s => s.name === 'run').step;
  return run.fn({ input: { checkout: 'lane-fixture' } });
}

describe('pr-size', () => {
  it('reads a real committed diff with local main fallback and excludes working-tree edits', async () => {
    await withRealRepo(async ({ root, git, commit }) => {
      commit({ 'example.mjs': 'base\n' }, 'base');
      git(['checkout', '-b', 'size-fixture']);
      commit({ 'example.mjs': 'base\ncommitted\n' }, 'change');
      writeFileSync(join(root, 'example.mjs'), 'base\ncommitted\nuncommitted\n');
      const reader = createPrSizeReader();
      const verdict = assess(() => reader({ checkout: root }));
      expect(verdict).toMatchObject({ ok: true, lines: 1 });
    });
  });

  it('requires an explicit checkout and declares only read-only compute steps', () => {
    const declaration = prSizeOperation({ readDiff: () => '' });
    expect(declaration.name).toBe('pr-size');
    expect(declaration.input.checkout).toEqual({ type: 'string', required: true,
      default: undefined, enum: null, atConfirm: false });
    expect(declaration.steps.every(s => s.step.kind === 'compute')).toBe(true);
    expect(() => prSizeOperation()).toThrow(/readDiff/);
  });

  it('reports under-limit non-test lines using the injected checkout reader', () => {
    const readDiff = vi.fn(() => ({ text: '12\t3\tscripts/example.mjs\0' + '900\t0\tscripts/__tests__/example.test.mjs\0' }));
    const verdict = assess(readDiff);
    expect(readDiff).toHaveBeenCalledWith({ checkout: 'lane-fixture' });
    expect(verdict).toMatchObject({ ok: true, status: 'ok', lines: 15, limit });
    const output = finishPrSize({ run: { verdict }, code: 0, lines: [] });
    expect(output.code).toBe(0);
    expect(output.lines.join('\n')).toContain(`15/${limit} non-test lines`);
    expect(output.lines.join('\n')).toMatch(/committed.*origin\/main.*local main.*working-tree changes excluded/i);
  });

  it('accepts the exact shared limit', () => {
    expect(assess(() => `${limit}\t0\tscripts/example.mjs\n`).ok).toBe(true);
  });

  it('reports over-limit input and stops with an operator-visible split plan fallback', () => {
    const verdict = assess(() => `${limit + 1}\t0\tscripts/example.mjs\n`);
    expect(verdict).toMatchObject({ ok: false, status: 'over', lines: limit + 1 });
    const output = finishPrSize({ run: { verdict }, code: 0, lines: [] });
    expect(output.code).toBe(1);
    expect(output.lines.join('\n')).toMatch(/over.*stop.*propose a split plan/i);
  });

  it('honors the shared backlog-only exemption above the limit', () => {
    const verdict = assess(() => `${limit + 1}\t0\tbacklog/example.md\n`);
    expect(verdict).toMatchObject({ ok: true, status: 'ok', exempt: true });
    expect(finishPrSize({ run: { verdict }, code: 0, lines: [] }).lines.join('\n')).toContain('exempt');
  });

  it.each([undefined, {}, 'garbage', '1\t0\tsrc/a.mjs\0incomplete', '-\t-\tsrc/a.bin\n'])('fails closed on unreadable evidence %j', evidence => {
    const verdict = assess(() => evidence);
    expect(verdict).toMatchObject({ ok: false, status: 'unreadable', lines: null });
    const output = finishPrSize({ run: { verdict }, code: 0, lines: [] });
    expect(output.code).toBe(1);
    expect(output.lines.join('\n')).toMatch(/stop.*restore.*retry/i);
  });

  it('fails closed on a reader failure without echoing untrusted error text', () => {
    const verdict = assess(() => { throw new Error('hostile\u001b[31mtext'); });
    expect(verdict.status).toBe('unreadable');
    expect(JSON.stringify(verdict)).not.toContain('hostile');
  });

  it('preserves JSON output while returning nonzero for a failed verdict', () => {
    const verdict = assess(() => `${limit + 1}\t0\tsrc/a.mjs\n`);
    expect(finishPrSize({ run: { verdict }, code: 0, lines: ['json'], json: true })).toEqual({ code: 1, lines: ['json'] });
    expect(finishPrSize({ run: {}, code: 1, lines: ['error'] })).toEqual({ code: 1, lines: ['error'] });
  });

  it('reuses the shared git reader with checkout cwd, main base and HEAD sha', () => {
    const diffStat = vi.fn(() => ({ text: '1\t0\tsrc/a.mjs\0', sha: 'fixture-sha' }));
    const createDiffStatReader = vi.fn(() => diffStat);
    const reader = createPrSizeReader({ createDiffStatReader });
    expect(reader({ checkout: 'lane-fixture' })).toEqual({ text: '1\t0\tsrc/a.mjs\0', sha: 'fixture-sha' });
    expect(createDiffStatReader).toHaveBeenCalledWith({ cwd: 'lane-fixture' });
    expect(diffStat).toHaveBeenCalledWith({ base: 'main', sha: 'HEAD' });
  });
});
