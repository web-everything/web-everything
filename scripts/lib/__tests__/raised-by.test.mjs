import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { raisedByFile, readRaisedBy, validateRaisedBy } from '../raised-by.mjs';
import { readOpenCards } from '../card-dedupe.mjs';
import { isCardOnlyDiff } from '../../ci-card-only.mjs';
import { applyLedger } from '../../backlog/id.mjs';
const line = '- Also raised by o/r#77 (finding 1: `we:scripts/a.mjs:4` — Add a regression test) · key `approval-prevention-key:o/r#77@abc`';
const fixture = (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'raised-by-'));
  mkdirSync(join(root, 'backlog'));
  writeFileSync(join(root, 'backlog/5125-parent.md'), `---\nstatus: open\n---\n# Parent\n\n## Also raised by\n\n${line}\n`);
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const put = (root, f) => { mkdirSync(dirname(join(root, f.path)), { recursive: true }); writeFileSync(join(root, f.path), f.content); };
describe('derived raised-by records', () => {
  it('ignores unused duplicate birth aliases but rejects raised-by directories that use them', () => fixture(root => {
    for (const id of ['6500', '6501']) {
      writeFileSync(join(root, `backlog/${id}-parent.md`), '---\nbornAs: x1abcde\nstatus: open\n---\n# Parent\n');
    }
    // Historical duplicate bornAs stamps are unrelated to raises filed by current ID.
    expect(validateRaisedBy(root)).toEqual([]);
    put(root, raisedByFile('6500', line));
    put(root, raisedByFile('6501', line));
    expect(validateRaisedBy(root)).toEqual([]);
    expect(readRaisedBy('6500', root)).toHaveLength(1);
    expect(readRaisedBy('6501', root)).toHaveLength(1);
    // Once a raise uses the shared alias, its parent really is ambiguous.
    put(root, raisedByFile('x1abcde', line.replaceAll('#77', '#78')));
    expect(validateRaisedBy(root)).toContain('raised-by parent x1abcde is ambiguous');
  }));
  it('keeps provisional raises readable and valid after real JIT numbering', () => fixture(root => {
    const name = 'x1abcde-parent.md';
    const content = `---\nstatus: open\n---\n# Parent\n\n${line}\n`;
    writeFileSync(join(root, 'backlog', name), content);
    const provisional = raisedByFile('x1abcde', line.replaceAll('#77', '#78'));
    put(root, provisional);
    expect(validateRaisedBy(root)).toEqual([]);
    const { renames, rewrites } = applyLedger([{ name, content }], { x1abcde: '6500' });
    for (const rewrite of rewrites) writeFileSync(join(root, 'backlog', rewrite.name), rewrite.content);
    for (const rename of renames) renameSync(join(root, 'backlog', rename.from), join(root, 'backlog', rename.to));
    const body = readFileSync(join(root, 'backlog/6500-parent.md'), 'utf8');
    expect(readRaisedBy('6500', root)).toHaveLength(2);
    expect(readRaisedBy('6500', root, { body })).toHaveLength(2);
    expect(readRaisedBy('x1abcde', root)).toHaveLength(2);
    expect(readOpenCards(root).find(card => String(card.id) === '6500')?.items).toHaveLength(2);
    expect(validateRaisedBy(root)).toEqual([]);
    put(root, raisedByFile('6500', line.replaceAll('#77', '#79')));
    expect(readRaisedBy('6500', root)).toHaveLength(3);
    expect(validateRaisedBy(root)).toEqual([]);
    put(root, raisedByFile('6500', line.replaceAll('#77', '#78')));
    expect(readRaisedBy('6500', root)).toHaveLength(3);
    expect(validateRaisedBy(root).join('\n')).toMatch(/duplicate/);
  }));
  it('does not accept a body citation as a bornAs parent alias', () => fixture(root => {
    writeFileSync(join(root, 'backlog/6500-parent.md'), '---\nstatus: open\n---\nExample:\nbornAs: x1abcde\n');
    put(root, raisedByFile('x1abcde', line.replaceAll('#77', '#78')));
    expect(readRaisedBy('6500', root)).toEqual([]);
    expect(validateRaisedBy(root).join('\n')).toContain('raised-by parent x1abcde does not exist');
  }));
  it('A2 merges legacy and file records by key; readers see the derived finding', () => fixture(root => {
    put(root, raisedByFile('5125', line));
    put(root, raisedByFile('5125', line.replaceAll('#77', '#78')));
    expect(readRaisedBy('5125', root)).toHaveLength(2);
    expect(readOpenCards(root)).toHaveLength(1);
    expect(readOpenCards(root)[0].items).toHaveLength(2);
  }));
  it('A3 retries reuse one deterministic file; A5 different PRs use disjoint paths', () => fixture(root => {
    const a = raisedByFile('5125', line);
    expect(raisedByFile('5125', line)).toEqual(a);
    expect(raisedByFile('5125', line.replaceAll('#77', '#78')).path).not.toBe(a.path);
    put(root, a); put(root, raisedByFile('5125', line));
    expect(readdirSync(join(root, 'backlog/raised-by/5125'))).toHaveLength(1);
    expect(isCardOnlyDiff([a.path])).toBe(true);
    const guard = resolve('scripts/backlog-guard.mjs');
    expect(() => execFileSync(process.execPath, [guard, '--pre'], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(root, a.path), content: a.content } }),
    })).not.toThrow();
    expect(() => raisedByFile('../escape', line)).toThrow();
  }));
  it('A4 validates format, parent existence, canonical path and duplicate files; accepts legacy lines', () => fixture(root => {
    expect(validateRaisedBy(root)).toEqual([]);
    const a = raisedByFile('5125', line.replaceAll('#77', '#78'));
    put(root, a);
    expect(validateRaisedBy(root)).toEqual([]);
    put(root, { path: a.path.replace('.md', '-copy.md'), content: a.content });
    expect(validateRaisedBy(root).join(' ')).toMatch(/duplicate|canonical/);
    put(root, raisedByFile('9999', line));
    expect(validateRaisedBy(root).join(' ')).toMatch(/parent/);
    put(root, { path: 'backlog/raised-by/5125/bad.md', content: 'bad' });
    expect(validateRaisedBy(root).join(' ')).toMatch(/format/);
  }));
});

it('one filing key retains distinct findings while duplicate keys merge across changed prose', () => fixture(root => {
  const first = raisedByFile('5125', line);
  expect(raisedByFile('5125', line.replace('Add a regression test', 'Changed prose')).path).toBe(first.path);
  put(root, first);
  put(root, raisedByFile('5125', line.replace('finding 1:', 'finding 2:')));
  expect(readRaisedBy('5125', root)).toHaveLength(2);
}));
