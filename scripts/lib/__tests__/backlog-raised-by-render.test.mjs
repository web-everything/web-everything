import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { raisedByFile } from '../raised-by.mjs';
const require = createRequire(import.meta.url);
it('A2 site loader renders merged raises and refreshes when only a raise file changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'raised-render-'));
  const old = process.env.WE_BACKLOG_DIR;
  process.env.WE_BACKLOG_DIR = join(root, 'backlog');
  mkdirSync(join(root, 'backlog'));
  const line = '- Also raised by o/r#77 (finding 1: `we:a.mjs:4` — Add a regression test) · key `key77`';
  writeFileSync(join(root, 'backlog/5125-parent.md'), `---\nkind: story\nstatus: open\ndateOpened: '2026-10-01'\n---\n# Parent\n\nA parent card.\n\n## Also raised by\n\n${line}\n`);
  const name = require.resolve('../../../src/_data/backlog.js');
  delete require.cache[name];
  try {
    const load = require(name);
    expect(load()).toHaveLength(1);
    const f = raisedByFile('5125', line.replaceAll('77', '78'));
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), f.content);
    const items = load();
    expect(items).toHaveLength(1);
    expect(items[0].raisedBy).toHaveLength(2);
    expect(items[0].details).toContain('o/r#78');
    expect(items[0].details.match(/o\/r#77/g)).toHaveLength(1);
  } finally {
    delete require.cache[name];
    if (old === undefined) delete process.env.WE_BACKLOG_DIR; else process.env.WE_BACKLOG_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});
