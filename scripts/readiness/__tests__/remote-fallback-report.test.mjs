/**
 * @file scripts/readiness/__tests__/remote-fallback-report.test.mjs
 * @description Hermetic text, JSON, path-resolution and CLI checks for the fallback report.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../remote-fallback-report.mjs';
import { admissionLockRoot } from '../heavy-admission.mjs';
import { summarize } from '../../lib/remote-fallback-log.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(content) {
  const root = mkdtempSync(join(tmpdir(), 'fallback-report-'));
  roots.push(root);
  const file = join(root, 'remote-fallbacks.jsonl');
  if (content !== undefined) writeFileSync(file, content);
  return { root, file };
}
function run(file, args = []) {
  const output = [];
  const code = main([`--file=${file}`, ...args], { log: line => output.push(line) });
  return { code, output: output.join('\n') };
}
const rows = [{ reason: 'credential-warn' }, { reason: 'needs-git' },
  { reason: 'remote-disabled' }, { reason: 'needs-git' }, { reason: 'credential-warn' }];

describe('remote-fallback-report', () => {
  it('prints real per-reason counts before advisory counts and names the top real cause', () => {
    const { file } = fixture(rows.map(row => JSON.stringify(row)).join('\n'));
    expect(run(file)).toEqual({ code: 0, output: [
      'Real fallbacks by reason:', '  needs-git: 2', '  remote-disabled: 1',
      'Advisory rows by reason:', '  credential-warn: 2', 'real fallbacks = 3', 'top cause: needs-git (2)',
    ].join('\n') });
  });

  it('prints exactly the summarize output with --json', () => {
    const { file } = fixture(rows.map(row => JSON.stringify(row)).join('\n'));
    const result = run(file, ['--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual(summarize(rows));
  });

  it('reports zero rows and exits successfully for a missing file', () => {
    const { file } = fixture();
    expect(run(file).output).toContain('real fallbacks = 0\ntop cause: none (0)');
    expect(run(file).code).toBe(0);
    expect(JSON.parse(run(file, ['--json']).output)).toEqual(summarize([]));
  });

  it('skips an interrupted final append and malformed lines while retaining valid rows', () => {
    const { file } = fixture('{"reason":"needs-git"}\nnot-json\n{"reason":"credential-warn"}\n{"reason":');
    expect(JSON.parse(run(file, ['--json']).output)).toEqual(summarize([
      { reason: 'needs-git' }, { reason: 'credential-warn' },
    ]));
  });

  it('uses the shared heavy-admission resolver by default, including its pool override', () => {
    const { root } = fixture();
    const env = { LANE_POOL_ROOT: root };
    let readFile;
    expect(main(['--json'], { cwd: root, env,
      readRows: file => { readFile = file; return []; }, log: () => {},
    })).toBe(0);
    expect(readFile).toBe(join(admissionLockRoot(root, env), 'remote-fallbacks.jsonl'));
  });

  it('does not resolve the default root when --file overrides it', () => {
    const { file } = fixture();
    expect(main([`--file=${file}`], {
      resolveLockRoot: () => { throw new Error('unexpected resolution'); }, log: () => {},
    })).toBe(0);
  });

  it('sanitizes terminal controls in text while preserving reason keys in JSON', () => {
    const reason = 'bad\u001b[31m\nreason';
    const { file } = fixture(JSON.stringify({ reason }));
    expect(run(file).output).toContain('top cause: bad?[31m?reason (1)');
    expect(JSON.parse(run(file, ['--json']).output).topReal.reason).toBe(reason);
  });

  it('runs the CLI with --file and --json and exits zero for missing evidence', () => {
    const { file } = fixture();
    const child = spawnSync(process.execPath, [join(process.cwd(), 'scripts/readiness/remote-fallback-report.mjs'),
      `--file=${file}`, '--json'], { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(summarize([]));
  });

  it('surfaces unreadable evidence instead of producing a successful empty report', () => {
    expect(() => run('bad\0path')).toThrow();
  });
});
