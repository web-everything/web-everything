/**
 * @file scripts/test-cache/__tests__/tracer.test.mjs
 * @description prepare-124 S3 — the runtime tracer catches a NAMED-import `readFileSync` (the case the vitest.setup.ts
 * header said a setup-file patch missed), spawns, and a traced `node` child's own file reads + module loads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRecorder, installTracer } from '../tracer.mjs';
import { parseChildTrace } from '../../lib/test-cache-trace.mjs';

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'trc-')); dirs.push(d); return d; };
beforeEach(() => { vi.resetModules(); });
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('prepare-124 S3 — installTracer', () => {
  it('catches a named-import readFileSync / readdirSync / existsSync and restores them afterwards', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'x');
    const rec = createRecorder();
    const uninstall = installTracer({ record: rec.record });
    try {
      // imported AFTER install, as the setup file's tracer is before any test file: its `import { readFileSync }` is a named import
      const { touch } = await import('./fixtures/named-import-actions.mjs');
      touch(dir, join(dir, 'a.txt'));
    } finally { uninstall(); }
    const ev = rec.events();
    expect(ev).toContainEqual({ k: 'read', p: join(dir, 'a.txt') });
    expect(ev).toContainEqual({ k: 'list', p: dir });
    expect(ev).toContainEqual({ k: 'exists', p: join(dir, 'a.txt.missing') });
    const count = ev.length;
    readFileSync(join(dir, 'a.txt'), 'utf8');
    expect(rec.events()).toHaveLength(count); // uninstalled: plain fs records nothing more
  });

  it('records spawns without changing their result, and a node child reports its own named-import reads', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'data.txt'), 'hello');
    writeFileSync(join(dir, 'dep.mjs'), 'export const v = 1;\n');
    writeFileSync(join(dir, 'main.mjs'), `import { readFileSync } from 'node:fs';\nimport { v } from './dep.mjs';\nconsole.log(readFileSync(${JSON.stringify(join(dir, 'data.txt'))}, 'utf8') + v);\n`);
    const traceFile = join(dir, 'child.jsonl');
    const rec = createRecorder();
    const uninstall = installTracer({
      record: rec.record,
      childTrace: { traceFile, importUrl: pathToFileURL(join(process.cwd(), 'scripts', 'test-cache', 'child-tracer.mjs')).href },
    });
    let out;
    try {
      const { runNode } = await import('./fixtures/named-import-actions.mjs');
      out = runNode(join(dir, 'main.mjs'), dir);
    } finally { uninstall(); }
    expect(out.trim()).toBe('hello1');
    expect(rec.events().find((e) => e.k === 'spawn')).toMatchObject({ kind: 'execFileSync', cwd: dir });
    const child = parseChildTrace(readFileSync(traceFile, 'utf8'));
    const rd = realpathSync(dir); // the module loader reports real paths (/private/var on macOS)
    const paths = child.map((e) => e.p);
    expect(paths).toContain(join(rd, 'main.mjs')); // the entry script (ESM loads are not hooked: module.register changes child stdout behaviour)
    expect(child).toContainEqual({ k: 'read', p: join(dir, 'data.txt') });
  });
});
