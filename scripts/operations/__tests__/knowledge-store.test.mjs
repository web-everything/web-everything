import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main as check, projectKey } from '../knowledge-store-check.mjs';
import { entryName, main as sync, planMerge } from '../knowledge-store-sync.mjs';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'ks-'));
  const store = (dir, files) => {
    const m = join(home, '.claude', 'projects', projectKey(dir), 'memory');
    mkdirSync(m, { recursive: true });
    for (const [f, t] of Object.entries(files)) writeFileSync(join(m, f), t);
    return m;
  };
  return { home, store, big: join(home, 'workspace', 'webeverything'), small: home };
}
const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`e${i}.md`, `---\nname: e${i}\n---\nx`]));
const run = (fn, args) => {
  const out = [];
  return { code: fn(args, (s) => out.push(s)), text: out.join('\n') };
};

describe('knowledge-store-check', () => {
  it('passes when cwd is the canonical dir', () => {
    const f = fixture();
    f.store(f.big, many(60));
    const r = run(check, [`--home=${f.home}`, `--cwd=${f.big}`]);
    expect(r.code).toBe(0);
    expect(r.text).toContain('OK');
  });
  it('fails with both fixes when started in a small-store dir', () => {
    const f = fixture();
    f.store(f.big, many(60));
    f.store(f.small, many(5));
    const r = run(check, [`--home=${f.home}`, `--cwd=${f.small}`]);
    expect(r.code).toBe(1);
    expect(r.text).toContain('start in');
    expect(r.text).toContain('link ');
    expect(r.text).toContain('5 entries');
  });
  it('passes when the loaded store is a symlink to the canonical one', () => {
    const f = fixture();
    const big = f.store(f.big, many(60));
    const link = join(f.home, '.claude', 'projects', projectKey(f.small));
    mkdirSync(link, { recursive: true });
    symlinkSync(big, join(link, 'memory'));
    expect(run(check, [`--home=${f.home}`, `--cwd=${f.small}`]).code).toBe(0);
  });
  it('fails when no store exists for cwd and a larger one does', () => {
    const f = fixture();
    f.store(f.big, many(60));
    expect(run(check, [`--home=${f.home}`, `--cwd=${join(f.home, 'elsewhere')}`]).code).toBe(1);
  });
  it('fails when the canonical store does not exist', () => {
    const f = fixture();
    expect(run(check, [`--home=${f.home}`, `--cwd=${f.big}`]).code).toBe(1);
  });
  it('rejects bad flags', () => {
    expect(run(check, ['--nope']).code).toBe(2);
  });
});

describe('knowledge-store-sync', () => {
  const entry = (n, body) => ({ file: `${n}.md`, slug: n, name: n, text: body });
  it('classifies add, same and conflict, matching by name too', () => {
    const plan = planMerge(
      [entry('a', '1'), entry('b', '2'), entry('c', '3'), { file: 'z.md', slug: 'z', name: 'c', text: '9' }],
      [entry('b', '2'), entry('c', 'other')],
    );
    expect(plan.add).toEqual(['a.md']);
    expect(plan.same).toEqual(['b.md']);
    expect(plan.conflict.map((c) => c.file)).toEqual(['c.md', 'z.md']);
  });
  it('reads CRLF names and catches duplicate names among incoming entries', () => {
    const crlf = (n, body) => ({ file: `${n}.md`, slug: n, name: entryName(`---\r\nname: shared\r\n---\r\n${body}`), text: body });
    expect(crlf('a', '1').name).toBe('shared');
    const plan = planMerge([crlf('a', '1'), crlf('b', '2')], [entry('t', 'x')]);
    expect(plan.add).toEqual(['a.md']);
    expect(plan.conflict.map((c) => c.file)).toEqual(['b.md']);
  });
  it('writes nothing by default; --apply copies only adds', () => {
    const f = fixture();
    const to = f.store(f.big, { 'MEMORY.md': '- [K](k.md) - kept\n', 'k.md': '---\nname: k\n---\nold' });
    f.store(f.small, { 'MEMORY.md': '- [N](n.md) - new\n- [K](k.md) - dup\n', 'n.md': '---\nname: n\n---\nnew', 'k.md': '---\nname: k\n---\nDIFFERENT' });
    const base = [`--home=${f.home}`, `--cwd=${f.small}`];
    const dry = run(sync, base);
    expect(dry.code).toBe(0);
    expect(dry.text).toContain('proposal only');
    expect(dry.text).toContain('! k.md');
    expect(existsSync(join(to, 'n.md'))).toBe(false);
    run(sync, [...base, '--apply']);
    expect(existsSync(join(to, 'n.md'))).toBe(true);
    expect(readFileSync(join(to, 'k.md'), 'utf8')).toContain('old');
    expect(readFileSync(join(to, 'MEMORY.md'), 'utf8')).not.toContain('(n.md)');
  });
});
