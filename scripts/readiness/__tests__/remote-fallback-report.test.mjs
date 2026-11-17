/**
 * @file scripts/readiness/__tests__/remote-fallback-report.test.mjs
 * @description Hermetic text, JSON, path-resolution and CLI checks for the fallback report.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../remote-fallback-report.mjs';
import { admissionLockRoot } from '../heavy-admission.mjs';
import { attributionLogPath, summarize } from '../../lib/remote-fallback-log.mjs';

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
  it.each(['explicit-container', 'admission-off', 'ci-bypass', 'no-pool', 'explicit-local', 'remote.enabled=true (platform); loadPerCore=2 <= 3'])('reports %s as advisory rather than a remote failure', reason => {
    const {file} = fixture(JSON.stringify({reason}) + '\n');
    const result = run(file, ['--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({total: 1, real: 0, advisory: 1,
      byReason: {}, advisoryByReason: {[reason]: 1}, topReal: null});
  });
  it('prints real per-reason counts before advisory counts and names the top real cause', () => {
    const { file } = fixture(rows.map(row => JSON.stringify(row)).join('\n'));
    expect(run(file)).toEqual({ code: 0, output: [
      'invalid lines: 0', 'partial lines: 0',
      'Real fallbacks by reason:', '  needs-git: 2', '  remote-disabled: 1',
      'Advisory rows by reason:', '  credential-warn: 2', 'real fallbacks = 3', 'top cause: needs-git (2)',
    ].join('\n') });
  });

  it('prints the summary and log integrity fields with --json', () => {
    const { file } = fixture(rows.map(row => JSON.stringify(row)).join('\n'));
    const result = run(file, ['--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ ...summarize(rows), missing: false, invalid: 0, partial: 0 });
  });

  it('reports the missing log explicitly and exits 3 while still printing the summary', () => {
    const { file } = fixture();
    expect(run(file).output).toContain('real fallbacks = 0\ntop cause: none (0)');
    expect(run(file).output).toContain(`log missing: ${file}`);
    expect(run(file).code).toBe(3);
    expect(run(file, ['--json']).code).toBe(3);
    expect(JSON.parse(run(file, ['--json']).output)).toEqual({ ...summarize([]), missing: true, invalid: 0, partial: 0 });
  });

  it('exits 3 for corrupt lines, counting the partial tail separately and retaining valid rows', () => {
    const { file } = fixture('{"reason":"needs-git"}\nnot-json\n{"reason":"credential-warn"}\n{"reason":');
    expect(run(file).code).toBe(3);
    expect(run(file).output).toContain('invalid lines: 1\npartial lines: 1');
    expect(run(file, ['--json']).code).toBe(3);
    expect(JSON.parse(run(file, ['--json']).output)).toEqual({ ...summarize([
      { reason: 'needs-git' }, { reason: 'credential-warn' },
    ]), missing: false, invalid: 1, partial: 1 });
  });

  it.each(['null', '42', 'true', '"text"', '[]', 'not-json\n'])('exits 3 for invalid evidence %s', content => {
    const { file } = fixture(content);
    expect(run(file).code).toBe(3);
    expect(run(file).output).toContain('invalid lines: 1');
    const result = run(file, ['--json']);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.output)).toEqual({ ...summarize([]), missing: false, invalid: 1, partial: 0 });
  });

  it('exits 3 for a readable log with a partial tail', () => {
    const { file } = fixture('{"reason":"needs-git"}\n{"reason":');
    expect(run(file).code).toBe(3);
    expect(run(file).output).toContain('invalid lines: 0\npartial lines: 1');
    const result = run(file, ['--json']);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.output)).toEqual({ ...summarize([{ reason: 'needs-git' }]), missing: false, invalid: 0, partial: 1 });
  });

  it('exits zero for an empty readable log', () => {
    const { file } = fixture('');
    expect(run(file).code).toBe(0);
    expect(JSON.parse(run(file, ['--json']).output)).toEqual({ ...summarize([]), missing: false, invalid: 0, partial: 0 });
  });

  it('uses the shared heavy-admission resolver by default, including its pool override', () => {
    const { root } = fixture();
    const env = { LANE_POOL_ROOT: root };
    let readFile;
    expect(main(['--json'], { cwd: root, env,
      readLog: file => { readFile = file; return { rows: [], missing: false, invalid: 0, partial: 0 }; }, log: () => {},
    })).toBe(0);
    expect(readFile).toBe(join(admissionLockRoot(root, env), 'remote-fallbacks.jsonl'));
  });

  it('does not resolve the default root when --file overrides it', () => {
    const { file } = fixture('');
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

  it.each([
    [undefined, 3, true, 0, 0],
    ['not-json\n', 3, false, 1, 0],
    ['{"reason":', 3, false, 0, 1],
  ])('runs the CLI for evidence %s with exit %s', (content, code, missing, invalid, partial) => {
    const { file } = fixture(content);
    const child = spawnSync(process.execPath, [join(process.cwd(), 'scripts/readiness/remote-fallback-report.mjs'),
      `--file=${file}`, '--json'], { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(code);
    expect(JSON.parse(child.stdout)).toEqual({ ...summarize([]), missing, invalid, partial });
  });

  it('surfaces unreadable evidence instead of producing a successful empty report', () => {
    expect(() => run('bad\0path')).toThrow();
  });
});

it('reports attribution-only no-pool decisions through the default resolver', () => {
  const {root} = fixture();
  const lockRoot = join(root, 'pool', '.admission', 'heavy');
  const foreign = attributionLogPath(join(root, 'other-pool', '.admission', 'heavy'));
  mkdirSync(join(foreign, '..'), {recursive:true});
  writeFileSync(foreign, JSON.stringify({reason:'foreign-pool-failure'})+'\n');
  const file = attributionLogPath(lockRoot);
  mkdirSync(join(file, '..'), {recursive:true});
  writeFileSync(file, JSON.stringify({reason:'no-pool'}) + '\n');
  const output = [];
  expect(main(['--json'], {resolveLockRoot:()=>lockRoot, log:line=>output.push(line)})).toBe(0);
  expect(JSON.parse(output[0])).toMatchObject({total:1, real:0, advisoryByReason:{'no-pool':1}});
});
