import { describe, it, expect } from 'vitest';
import { duplicateBornAsWarnings, checkDuplicateBornAs } from '../duplicate-bornas-added.mjs';
import { createPrLandRunner } from '../../operations/open-pr-io.mjs';

describe('duplicateBornAsWarnings', () => {
  it('warns when main already holds the bornAs as a numbered card', () => {
    const w = duplicateBornAsWarnings({ added: [{ path: 'backlog/xsjn0uf-a.md', bornAs: 'xsjn0uf' }], mainBornAs: new Map([['xsjn0uf', 'backlog/5319-a.md']]), openPrFiles: [] });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('5319');
  });
  it('warns when another open PR adds the same hash-named card', () => {
    const w = duplicateBornAsWarnings({ added: [{ path: 'backlog/xsjn0uf-a.md', bornAs: 'xsjn0uf' }], mainBornAs: new Map(), openPrFiles: [{ pr: 4366, path: 'backlog/xsjn0uf-a.md' }, { pr: 4300, path: 'src/x.js' }] });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('#4366');
  });
  it('is silent for a fresh hash', () => {
    expect(duplicateBornAsWarnings({ added: [{ path: 'backlog/xnew0001-a.md', bornAs: 'xnew0001' }], mainBornAs: new Map(), openPrFiles: [] })).toEqual([]);
  });
});

describe('checkDuplicateBornAs (fact gathering)', () => {
  const exec = (cmd, args) => {
    if (args[0] === 'diff') return 'backlog/xsjn0uf-a.md\nsrc/other.js\n';
    if (args[0] === 'show') return '---\nbornAs: xsjn0uf\n---\nbody\n';
    if (args[0] === 'grep') return 'origin/main:backlog/5319-a.md:bornAs: xsjn0uf\n';
    if (cmd === 'gh') return JSON.stringify([{ number: 9, headRefName: 'lane/mine', files: [{ path: 'backlog/xsjn0uf-a.md' }] }]);
    throw new Error(args.join(' '));
  };
  it('reports main and open-PR conflicts, excluding the PR\'s own branch', () => {
    expect(checkDuplicateBornAs({ exec, branch: 'lane/mine' })).toHaveLength(1); // main only
    expect(checkDuplicateBornAs({ exec, branch: 'lane/other' })).toHaveLength(2);
  });
  it('fails soft', () => {
    expect(checkDuplicateBornAs({ exec: () => { throw new Error('boom'); } })).toEqual([]);
  });
});

describe('open-pr runner surfaces the warning', () => {
  it('writes a stderr WARNING and still submits', () => {
    const chunks = [];
    const orig = process.stderr.write;
    process.stderr.write = (c) => { chunks.push(String(c)); return true; };
    let spawned = false;
    try {
      createPrLandRunner({
        prePrReview: () => ({ action: 'pass' }),
        dupBornAs: () => ['backlog/xa.md adds bornAs xa, dup'],
        spawn: () => { spawned = true; return { status: 0, stdout: '{"pr":1}' }; },
      })({ argv: ['--ref=lane/x'] });
    } finally { process.stderr.write = orig; }
    expect(chunks.join('')).toContain('duplicate card');
    expect(spawned).toBe(true);
  });
});
