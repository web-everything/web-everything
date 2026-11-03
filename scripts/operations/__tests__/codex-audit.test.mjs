/** @file Hermetic standalone audit contract and real-adapter boundary tests. */
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { CANONICAL_QUESTION, QUESTION_HASH, main, findAudit } from '../codex-audit.mjs';
import { createAuditDeps } from '../codex-audit-io.mjs';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const ARGS = ['--base=origin/main', `--head=${HEAD}`];
const AT = '2026-11-01T12:00:00.000Z';
function fixture(answer = 'NOT WEAKENED') {
  const records = [], output = [], errors = [];
  const deps = {
    resolveSha: vi.fn(ref => ref === 'origin/main' ? BASE : HEAD),
    runCodex: vi.fn(async () => answer),
    appendRecord: vi.fn(record => { records.push(record); }),
    now: () => AT,
    stdout: text => output.push(text), stderr: text => errors.push(text),
  };
  return { deps, records, output, errors };
}

describe('canonical audit', () => {
  it('retires the historical question and binds the revised schema to its sha256 hash', () => {
    expect(CANONICAL_QUESTION).not.toBe('You are a read-only auditor. Judge the WHOLE diff `git diff <base>...<head>`, including pre-existing behaviour the diff now relies on, not only the changed lines. Does the change WEAKEN anything: a guard, gate, test, assertion or fail-closed path; a loosened check or threshold; removed validation; a new bypass, override or silent fallback; a test that no longer fails when the behaviour breaks? Pre-existing limitations the diff relies on count. Answer with the FIRST line exactly `NOT WEAKENED` or `WEAKENED`, then findings, one per line, each with file:line and why. Do not edit files.');
    expect(QUESTION_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(QUESTION_HASH).toBe(createHash('sha256').update(CANONICAL_QUESTION).digest('hex'));
  });

  it.each(['--note=x', '--question=x', '--prompt=x', '--help', '--json=true', 'extra', '--', '--base=other'])('rejects extra argument %s before any work', async arg => {
    const f = fixture();
    expect(await main([...ARGS, arg], f.deps)).toBe(2);
    expect(f.errors.join('')).toMatch(/usage:/);
    expect(f.output).toEqual([]);
    expect(f.deps.resolveSha).not.toHaveBeenCalled();
    expect(f.deps.runCodex).not.toHaveBeenCalled();
    expect(f.records).toEqual([]);
  });

  it.each([[], ['--base=main'], ['--head=' + HEAD], ['--base=../main', '--head=' + HEAD],
    ['--base=-main', '--head=' + HEAD], ['--base=main\n', '--head=' + HEAD],
    ['--base=main', '--head=abc'], ['--base=main', '--head=' + HEAD + '\n']].map(args => [args]))('rejects invalid or missing refs %j', async args => {
    const f = fixture();
    expect(await main(args, f.deps)).toBe(2);
    expect(f.deps.resolveSha).not.toHaveBeenCalled();
    expect(f.deps.runCodex).not.toHaveBeenCalled();
    expect(f.records).toEqual([]);
  });

  it.each([null, 'short', new Error('missing ref')])('rejects unresolved commits %s without auditing', async value => {
    const f = fixture();
    f.deps.resolveSha.mockImplementation(() => { if (value instanceof Error) throw value; return value; });
    expect(await main(ARGS, f.deps)).toBe(2);
    expect(f.errors.join('')).toMatch(/usage:/);
    expect(f.deps.runCodex).not.toHaveBeenCalled();
    expect(f.records).toEqual([]);
  });

  it.each(['NOT WEAKENED', 'WEAKENED'])('refuses legacy unclassified findings after opening %s', async verdict => {
    const f = fixture(`${verdict}\nscripts/example.mjs:12 why`);
    expect(await main(ARGS, f.deps)).not.toBe(0);
    expect(f.records.some(record => record.verdict === 'NOT WEAKENED')).toBe(false);
    expect(f.output.join('')).not.toMatch(/^(?:NOT WEAKENED|\{"verdict":"NOT WEAKENED")/);
    expect(f.deps.runCodex.mock.calls[0][0]).toContain(CANONICAL_QUESTION);
    expect(f.deps.runCodex.mock.calls[0][0]).toContain(`git diff ${BASE}...${HEAD}`);
  });

  it.each(['', '\n  \n', 'Looks good\nNOT WEAKENED', 'NOT WEAKENED extra', ' WEAKENED', 'WEAKENED ',
    '\x1b[32mNOT WEAKENED\x1b[0m', null])('fails closed on non-exact first verdict %j', async answer => {
    const f = fixture(answer);
    expect(await main(ARGS, f.deps)).toBe(3);
    expect(f.errors.join('')).toMatch(/UNPARSEABLE/);
    expect(f.output).toEqual([]);
    expect(f.records).toEqual([]);
  });

  it('fails closed on Codex failure without recording', async () => {
    const f = fixture();
    f.deps.runCodex.mockRejectedValue(new Error('failed'));
    expect(await main(ARGS, f.deps)).toBe(3);
    expect(f.errors.join('')).toMatch(/UNPARSEABLE/);
    expect(f.records).toEqual([]);
  });

  const conflictingAnswers = [
    'NOT WEAKENED\nWEAKENED\nscripts/gate.mjs:12 the fail-closed guard was removed',
    'WEAKENED\nNOT WEAKENED',
    'NOT WEAKENED\nscripts/gate.mjs:12 guard removed\n\nWEAKENED\n',
    'NOT WEAKENED\r\nWEAKENED',
    'NOT WEAKENED\rWEAKENED',
    'NOT WEAKENED\u2028WEAKENED',
    'NOT WEAKENED\u2029WEAKENED',
    'NOT WEAKENED\n \tWEAKENED\t ',
    'NOT WEAKENED\n\x1b[31mWEAKENED\x1b[0m\x07',
    'NOT WEAKENED\nＷＥＡＫＥＮＥＤ',
    'NOT WEAKENED\nWEAK\u200bENED',
    'NOT WEAKENED\nWEAK\rENED',
    'NOT WEAKENED\nscripts/gate.mjs:12 guard removed\nWEAK\rENED',
    'WEAKENED\nNOT WEAK\rENED',
    'WEAKENED\nＮＯＴ ＷＥＡＫＥＮＥＤ',
  ];

  it.each(conflictingAnswers)('rejects contradictory verdicts without publishing or recording: %j', async answer => {
    for (const args of [ARGS, [...ARGS, '--json']]) {
      const f = fixture(answer);
      expect(await main(args, f.deps)).toBe(3);
      expect(f.errors.join('')).toMatch(/UNPARSEABLE/);
      expect(f.output).toEqual([]);
      expect(f.deps.appendRecord).not.toHaveBeenCalled();
      expect(findAudit(f.records, { base: BASE, head: HEAD, questionHash: QUESTION_HASH })).toBeNull();
    }
  });

  it.each(['NOT WEAKENED', 'WEAKENED'])('repeated agreeing verdicts do not rescue unclassified findings: %s', async verdict => {
    const f = fixture(`${verdict}\n${verdict}\nscripts/gate.mjs:12 unclassified claim`);
    expect(await main(ARGS, f.deps)).not.toBe(0);
    expect(f.records.some(record => record.verdict === 'NOT WEAKENED')).toBe(false);
  });

  it.each(conflictingAnswers)('findAudit ignores historical contradictory records: %j', async answer => {
    const verdict = answer.startsWith('WEAKENED') ? 'WEAKENED' : 'NOT WEAKENED';
    const evidence = { id: 'guard', class: 'B3', file: 'scripts/gate.mjs', line: 12,
      invariant: 'Unknown state refuses admission', trigger: 'Metadata unreadable',
      consequence: 'Admission proceeds', relation: 'introduced' };
    const f = fixture(verdict === 'WEAKENED' ? `${verdict}\n${JSON.stringify(evidence)}` : verdict);
    expect(await main(ARGS, f.deps)).toBe(verdict === 'WEAKENED' ? 1 : 0);
    expect(f.records[0]).toMatchObject({ verdict });
    const valid = { ...f.records[0], at: '2026-01-01T00:00:00.000Z' };
    const query = { base: BASE, head: HEAD, questionHash: QUESTION_HASH };
    for (const findings of [answer.slice(verdict.length).split(/\r?\n/), [answer]]) {
      const invalid = { ...valid, at: AT, findings };
      expect(findAudit([invalid], query)).toBeNull();
      expect(findAudit([valid, invalid], query)).toBe(valid);
    }
  });

  it('prints no verdict if the record cannot be appended', async () => {
    const f = fixture();
    f.deps.appendRecord.mockRejectedValue(new Error('permission denied'));
    expect(await main(ARGS, f.deps)).toBe(3);
    expect(f.output).toEqual([]);
    expect(f.errors.join('')).toMatch(/record/i);
  });

  it('records before printing the verdict', async () => {
    const f = fixture();
    f.deps.stdout = vi.fn(() => expect(f.records).toHaveLength(1));
    await main(ARGS, f.deps);
    expect(f.deps.stdout).toHaveBeenCalledOnce();
  });

  it('strips terminal controls from findings before terminal output', async () => {
    const evidence = { id: 'control', class: 'B1', file: 'x', line: 1, invariant: 'No bypass',
      trigger: 'Untrusted input', consequence: '\x1b[31mbypass\x1b[0m\x07', relation: 'introduced' };
    const f = fixture(`WEAKENED\n${JSON.stringify(evidence)}`);
    await main(ARGS, f.deps);
    const printed = JSON.parse(f.output.join('').split('\n')[1]);
    expect(printed.consequence).toBe('bypass');
    expect(f.records[0].findings[0].consequence).toBe(evidence.consequence);
  });

  it('findAudit selects the later appended record when timestamps are equal', () => {
    const first = { base: BASE, head: HEAD, questionHash: QUESTION_HASH, findings: [], at: AT, verdict: 'NOT WEAKENED' };
    const later = { ...first, verdict: 'WEAKENED' };
    expect(findAudit([first, later], { base: BASE, head: HEAD, questionHash: QUESTION_HASH })).toBe(later);
  });

  it('findAudit selects latest exact base, head and canonical hash, rejecting other hashes and heads', () => {
    const first = { base: BASE, head: HEAD, questionHash: QUESTION_HASH, findings: [], verdict: 'NOT WEAKENED', at: '2026-01-01T00:00:00.000Z' };
    const latest = { ...first, at: AT };
    const records = [latest, { ...latest, head: BASE }, { ...latest, questionHash: 'other' }, first];
    expect(findAudit(records, { base: BASE, head: HEAD, questionHash: QUESTION_HASH })).toBe(latest);
    expect(findAudit(records, { base: BASE, head: BASE, questionHash: 'other' })).toBeNull();
    expect(findAudit([first], { base: BASE, head: BASE, questionHash: QUESTION_HASH })).toBeNull();
    expect(findAudit([{ ...first, questionHash: 'other' }], { base: BASE, head: HEAD, questionHash: 'other' })).toBeNull();
    expect(findAudit([], { base: BASE, head: HEAD, questionHash: QUESTION_HASH })).toBeNull();
  });

  it('findAudit rejects a different base for the same head and canonical hash', () => {
    const record = { base: HEAD, head: HEAD, questionHash: QUESTION_HASH, findings: [], verdict: 'NOT WEAKENED', at: AT };
    expect(findAudit([record], { base: BASE, head: HEAD, questionHash: QUESTION_HASH })).toBeNull();
  });

  it.each([undefined, null, '', 'origin/main', 'a'.repeat(39), 'g'.repeat(40), BASE + '\n'])('findAudit rejects missing or non-full base %j', base => {
    const record = { base, head: HEAD, questionHash: QUESTION_HASH, findings: [], verdict: 'NOT WEAKENED', at: AT };
    expect(findAudit([record], { base, head: HEAD, questionHash: QUESTION_HASH })).toBeNull();
  });

  it.each([undefined, null, '', 'main', 'b'.repeat(39), 'b'.repeat(41), 'g'.repeat(40), HEAD + '\n'])('findAudit rejects missing or non-full head %j even when the record matches', head => {
    const record = { base: BASE, head, questionHash: QUESTION_HASH, findings: [], verdict: 'NOT WEAKENED', at: AT };
    expect(findAudit([record], { base: BASE, head, questionHash: QUESTION_HASH })).toBeNull();
  });

  it.each([undefined, null, '', 'garbage', 'not weakened', 'NOT WEAKENED ', ' WEAKENED', 'WEAKENED\n'])('findAudit ignores newer invalid verdict %j without displacing valid evidence', verdict => {
    const valid = { base: BASE, head: HEAD, questionHash: QUESTION_HASH, findings: [], verdict: 'WEAKENED', at: '2026-01-01T00:00:00.000Z' };
    const invalid = { ...valid, verdict, at: AT };
    const query = { base: BASE, head: HEAD, questionHash: QUESTION_HASH };
    expect(findAudit([valid, invalid], query)).toBe(valid);
    expect(findAudit([invalid], query)).toBeNull();
  });

  it('findAudit rejects a missing query base and legacy records without a base', () => {
    const record = { base: BASE, head: HEAD, questionHash: QUESTION_HASH, findings: [], verdict: 'NOT WEAKENED', at: AT };
    expect(findAudit([record], { head: HEAD, questionHash: QUESTION_HASH })).toBeNull();
    const legacy = { head: HEAD, questionHash: QUESTION_HASH, findings: [], verdict: 'NOT WEAKENED', at: AT };
    expect(findAudit([legacy], { base: BASE, head: HEAD, questionHash: QUESTION_HASH })).toBeNull();
  });
});

function adapter(report = { exitCode: 0, timedOut: false, lastMessage: 'NOT WEAKENED' }, options = {}) {
  const fs = { readFileSync: vi.fn(() => '{}'), mkdtempSync: vi.fn(() => '/scratch/audit-1'),
    copyFileSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn(), mkdirSync: vi.fn(), appendFileSync: vi.fn() };
  const spawnSync = vi.fn(command => ({ status: 0, stdout: command === 'git' ? '.git/index\n' : JSON.stringify(report) }));
  const deps = createAuditDeps({ cwd: '/repo', home: '/home/test', scratchRoot: '/scratch', fs, spawnSync, ...options });
  return { deps, fs, spawnSync };
}

describe('audit IO with injected filesystem and subprocesses', () => {
  it('refuses a contradictory launcher report before the persistence adapter runs', async () => {
    const f = adapter({ exitCode: 0, timedOut: false,
      lastMessage: 'NOT WEAKENED\nWEAKENED\nscripts/gate.mjs:12 the fail-closed guard was removed' });
    f.deps.resolveSha = ref => ref === 'origin/main' ? BASE : HEAD;
    f.deps.stdout = vi.fn();
    f.deps.stderr = vi.fn();
    expect(await main(ARGS, f.deps)).toBe(3);
    expect(f.deps.stderr).toHaveBeenCalledWith(expect.stringContaining('UNPARSEABLE'));
    expect(f.deps.stdout).not.toHaveBeenCalled();
    expect(f.fs.appendFileSync).not.toHaveBeenCalled();
    expect(f.fs.rmSync).toHaveBeenCalledWith('/scratch/audit-1', { recursive: true, force: true });
  });

  it('resolves commits using verify and commit peeling with argv, never a shell', () => {
    const f = adapter();
    f.spawnSync.mockReturnValue({ status: 0, stdout: BASE + '\n' });
    expect(f.deps.resolveSha('origin/main')).toBe(BASE);
    expect(f.spawnSync.mock.calls[0]).toEqual(['git', ['rev-parse', '--verify', 'origin/main^{commit}'], expect.objectContaining({ cwd: '/repo', maxBuffer: expect.any(Number) })]);
  });

  it('passes a temporary task file to read-only Codex and removes it', () => {
    const f = adapter();
    expect(f.deps.runCodex('fixed prompt')).toBe('NOT WEAKENED');
    expect(f.fs.writeFileSync).toHaveBeenCalledWith('/scratch/audit-1/task.md', 'fixed prompt', expect.any(Object));
    expect(f.spawnSync.mock.calls[1][1]).toEqual([fileURLToPath(new NodeURL('../../codex-direct-task.mjs', import.meta.url)), '--review', '--json', '--gate=none', '--task-file=/scratch/audit-1/task.md', '--dir=/repo']);
    expect(f.fs.rmSync).toHaveBeenCalledWith('/scratch/audit-1', { recursive: true, force: true });
  });

  it('launches the module-relative trusted script when the audited cwd differs', () => {
    const cwd = '/audited/checkout';
    const f = adapter(undefined, { cwd });
    f.deps.runCodex('prompt');
    expect(f.spawnSync.mock.calls[1]).toEqual([process.execPath,
      [fileURLToPath(new NodeURL('../../codex-direct-task.mjs', import.meta.url)), '--review', '--json',
        '--gate=none', '--task-file=/scratch/audit-1/task.md', `--dir=${cwd}`],
      expect.objectContaining({ cwd })]);
  });

  it('accepts an injected launcher path while keeping the audited cwd', () => {
    const launcherPath = '/trusted/scripts/test-launcher.mjs';
    const f = adapter(undefined, { launcherPath });
    f.deps.runCodex('prompt');
    expect(f.spawnSync.mock.calls[1][1][0]).toBe(launcherPath);
    expect(f.spawnSync.mock.calls[1][1]).toContain('--dir=/repo');
    expect(f.spawnSync.mock.calls[1][2].cwd).toBe('/repo');
  });

  it.each(['.git/index', '/shared/worktrees/lane/index'])('isolates the Codex index from %s in scratch and removes it', indexPath => {
    const f = adapter();
    f.spawnSync.mockReturnValueOnce({ status: 0, stdout: indexPath + '\n' });
    expect(f.deps.runCodex('prompt')).toBe('NOT WEAKENED');
    expect(f.spawnSync.mock.calls[0]).toEqual(['git', ['rev-parse', '--git-path', 'index'],
      expect.objectContaining({ cwd: '/repo' })]);
    expect(f.spawnSync.mock.calls[0][2].env).toBeUndefined();
    expect(f.fs.copyFileSync).toHaveBeenCalledWith(indexPath.startsWith('/') ? indexPath : '/repo/' + indexPath,
      '/scratch/audit-1/index');
    expect(f.spawnSync.mock.calls[1][2].env).toEqual({ ...process.env, GIT_INDEX_FILE: '/scratch/audit-1/index' });
    expect(f.fs.copyFileSync.mock.invocationCallOrder[0]).toBeLessThan(f.spawnSync.mock.invocationCallOrder[1]);
    expect(f.fs.rmSync).toHaveBeenCalledWith('/scratch/audit-1', { recursive: true, force: true });
  });

  it('runs real Git with an absent repository index, isolates intent-to-add and removes scratch', () => {
    const root = realFs.mkdtempSync(join(process.env.TMPDIR, 'codex-audit-test-'));
    const cwd = join(root, 'repo');
    let scratchIndex;
    const spawnSync = vi.fn((command, args, options) => {
      if (command === 'git') return realSpawnSync(command, args, options);
      expect(command).toBe(process.execPath);
      scratchIndex = options.env.GIT_INDEX_FILE;
      expect(dirname(dirname(scratchIndex))).toBe(root);
      const added = realSpawnSync('git', ['add', '--intent-to-add', '--', 'sample.txt'], options);
      expect(added.stderr).toBe('');
      expect(added.status).toBe(0);
      expect(realFs.existsSync(scratchIndex)).toBe(true);
      const diff = realSpawnSync('git', ['diff', '--', 'sample.txt'], options);
      expect(diff.status).toBe(0);
      expect(diff.stdout).toContain('+audit fixture');
      return { status: 0, stdout: JSON.stringify({ exitCode: 0, timedOut: false, lastMessage: 'NOT WEAKENED' }) };
    });
    try {
      const init = realSpawnSync('git', ['init', '--quiet', cwd], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
      expect(init.status).toBe(0);
      realFs.writeFileSync(join(cwd, 'sample.txt'), 'audit fixture\n');
      expect(realFs.existsSync(join(cwd, '.git', 'index'))).toBe(false);
      const deps = createAuditDeps({ cwd, scratchRoot: root, spawnSync });
      expect(deps.runCodex('prompt')).toBe('NOT WEAKENED');
      expect(realFs.existsSync(join(cwd, '.git', 'index'))).toBe(false);
      expect(realFs.existsSync(dirname(scratchIndex))).toBe(false);
    } finally {
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an unreadable index without launching Codex and removes scratch', () => {
    const f = adapter();
    f.fs.copyFileSync.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    expect(() => f.deps.runCodex('prompt')).toThrow('denied');
    expect(f.spawnSync).toHaveBeenCalledTimes(1);
    expect(f.spawnSync.mock.calls[0][0]).toBe('git');
    expect(f.fs.rmSync).toHaveBeenCalledWith('/scratch/audit-1', { recursive: true, force: true });
  });

  it('reads the final JSON report after streamed JSONL events', () => {
    const f = adapter();
    f.spawnSync.mockReturnValue({ status: 0, stdout: '{"type":"event"}\n' + JSON.stringify({ exitCode: 0, timedOut: false, lastMessage: 'WEAKENED' }, null, 2) });
    f.spawnSync.mockReturnValueOnce({ status: 0, stdout: '.git/index\n' });
    expect(f.deps.runCodex('prompt')).toBe('WEAKENED');
  });

  it.each([{ exitCode: 1, timedOut: false, lastMessage: 'NOT WEAKENED' },
    { exitCode: 0, timedOut: true, lastMessage: 'NOT WEAKENED' }, {}, null])('rejects failed or incomplete report %j', report => {
    const f = adapter(report);
    expect(() => f.deps.runCodex('prompt')).toThrow();
    expect(f.fs.rmSync).toHaveBeenCalled();
  });

  it.each([{ status: 1 }, { status: null, error: new Error('maxBuffer exceeded') }, { status: 0, stdout: 'bad json' }])('rejects failed, oversized or malformed subprocess output %j', result => {
    const f = adapter();
    f.spawnSync.mockReturnValue(result);
    f.spawnSync.mockReturnValueOnce({ status: 0, stdout: '.git/index\n' });
    expect(() => f.deps.runCodex('prompt')).toThrow();
    expect(f.spawnSync).toHaveBeenCalledTimes(2);
    expect(f.fs.rmSync).toHaveBeenCalled();
  });

  it.each(['{}', '{"auditRecordPath":"~/custom/audits.jsonl"}'])('expands configured or default record path: %s', settings => {
    const f = adapter();
    f.fs.readFileSync.mockReturnValue(settings);
    f.deps.appendRecord({ head: HEAD });
    const path = settings === '{}' ? '/home/test/workspace/.operations/coordination/audits.jsonl' : '/home/test/custom/audits.jsonl';
    expect(f.fs.appendFileSync).toHaveBeenCalledWith(path, JSON.stringify({ head: HEAD }) + '\n', expect.any(Object));
  });

  it('defaults when the settings file is absent', () => {
    const f = adapter();
    f.fs.readFileSync.mockImplementation(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); });
    f.deps.appendRecord({ head: HEAD });
    expect(f.fs.appendFileSync.mock.calls[0][0]).toBe('/home/test/workspace/.operations/coordination/audits.jsonl');
  });

  it.each(['invalid JSON', '{"auditRecordPath":""}', '{"auditRecordPath":42}'])('refuses corrupt settings instead of silently recording elsewhere: %s', settings => {
    const f = adapter();
    f.fs.readFileSync.mockReturnValue(settings);
    expect(() => f.deps.appendRecord({ head: HEAD })).toThrow();
    expect(f.fs.appendFileSync).not.toHaveBeenCalled();
  });
});
