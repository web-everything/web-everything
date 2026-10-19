import { it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { raisedByFile } from '../raised-by.mjs';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
it.each([['5125', '5125'], ['6500', 'x1abcde']])('A2 site loader renders merged raises for %s and refreshes when only a raise file changes', (id, raiseId) => {
  const root = mkdtempSync(join(tmpdir(), 'raised-render-'));
  vi.stubEnv('WE_BACKLOG_DIR', join(root, 'backlog'));
  vi.stubEnv('WE_BACKLOG_INDEX', '1');
  vi.stubEnv('WE_BACKLOG_INDEX_DIR', join(root, 'index'));
  mkdirSync(join(root, 'backlog'));
  const line = '- Also raised by o/r#77 (finding 1: `we:a.mjs:4` — Add a regression test) · key `key77`';
  writeFileSync(join(root, `backlog/${id}-parent.md`), `---\n${id !== raiseId ? `bornAs: ${raiseId}\n` : ''}kind: story\nstatus: open\ndateOpened: '2026-10-01'\n---\n# Parent\n\nA parent card.\n\n## Also raised by\n\n${line}\n`);
  const name = require.resolve('../../../src/_data/backlog.js');
  delete require.cache[name];
  try {
    const read = vi.spyOn(fs, 'readFileSync');
    const load = require(name);
    const first = load();
    expect(first).toHaveLength(1);
    read.mockClear();
    const f = raisedByFile(raiseId, line.replaceAll('77', '78'));
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), f.content);
    const items = load();
    expect(items).toHaveLength(1);
    expect(items[0].raisedBy).toHaveLength(2);
    expect(items[0].details).toContain('o/r#78');
    expect(items[0].details.match(/o\/r#77/g)).toHaveLength(1);
    expect(read.mock.calls.filter(([path]) => dirname(String(path)) === join(root, 'backlog'))).toEqual([]);
    unlinkSync(join(root, f.path));
    expect(load()).toStrictEqual(first);
    expect(read.mock.calls.filter(([path]) => dirname(String(path)) === join(root, 'backlog'))).toEqual([]);
  } finally {
    delete require.cache[name];
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
