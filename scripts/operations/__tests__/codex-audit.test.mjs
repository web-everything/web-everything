/** @file Hermetic standalone audit contract and real-adapter boundary tests. */
import { createHash } from 'node:crypto';
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
  it('pins the question text and its sha256 hash', () => {
    expect(CANONICAL_QUESTION).toBe('You are a read-only auditor. Judge the WHOLE diff `git diff <base>...<head>`, including pre-existing behaviour the diff now relies on, not only the changed lines. Does the change WEAKEN anything: a guard, gate, test, assertion or fail-closed path; a loosened check or threshold; removed validation; a new bypass, override or silent fallback; a test that no longer fails when the behaviour breaks? Pre-existing limitations the diff relies on count. Answer with the FIRST line exactly `NOT WEAKENED` or `WEAKENED`, then findings, one per line, each with file:line and why. Do not edit files.');
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

  it.each([['NOT WEAKENED', 0], ['WEAKENED', 1]])('prints and records first-line verdict %s', async (verdict, code) => {
    const f = fixture(`\n\r\n${verdict}\r\nscripts/example.mjs:12 why\n`);
    expect(await main(ARGS, f.deps)).toBe(code);
    expect(f.output.join('')).toBe(`${verdict}\nscripts/example.mjs:12 why\n`);
    expect(f.records).toEqual([{ at: AT, base: BASE, head: HEAD, baseRef: 'origin/main',
      questionHash: QUESTION_HASH, verdict, findings: ['scripts/example.mjs:12 why'] }]);
    expect(f.deps.runCodex.mock.calls[0][0]).toContain(CANONICAL_QUESTION);
    expect(f.deps.runCodex.mock.calls[0][0]).toContain(`git diff ${BASE}...${HEAD}`);
    expect(f.deps.resolveSha.mock.calls).toEqual([['origin/main'], [HEAD]]);
    expect(f.deps.appendRecord.mock.invocationCallOrder[0]).toBeGreaterThan(f.deps.runCodex.mock.invocationCallOrder[0]);
  });

  it('prints exactly one JSON object with the full shas and canonical hash', async () => {
    const f = fixture('WEAKENED\nx.mjs:1 bypass');
    expect(await main([...ARGS, '--json'], f.deps)).toBe(1);
    expect(JSON.parse(f.output.join(''))).toEqual({ verdict: 'WEAKENED', base: BASE, head: HEAD,
      questionHash: QUESTION_HASH, findings: ['x.mjs:1 bypass'] });
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
    const f = fixture('WEAKENED\nx:1 \x1b[31mbypass\x1b[0m\x07');
    await main(ARGS, f.deps);
    expect(f.output.join('')).toBe('WEAKENED\nx:1 bypass\n');
  });

  it('findAudit selects the later appended record when timestamps are equal', () => {
    const first = { head: HEAD, questionHash: QUESTION_HASH, at: AT, verdict: 'NOT WEAKENED' };
    const later = { ...first, verdict: 'WEAKENED' };
    expect(findAudit([first, later], { head: HEAD, questionHash: QUESTION_HASH })).toBe(later);
  });

  it('findAudit selects latest exact head and canonical hash, rejecting other hashes and heads', () => {
    const first = { head: HEAD, questionHash: QUESTION_HASH, at: '2026-01-01T00:00:00.000Z' };
    const latest = { ...first, at: AT };
    const records = [latest, { ...latest, head: BASE }, { ...latest, questionHash: 'other' }, first];
    expect(findAudit(records, { head: HEAD, questionHash: QUESTION_HASH })).toBe(latest);
    expect(findAudit(records, { head: BASE, questionHash: 'other' })).toBeNull();
    expect(findAudit([first], { head: BASE, questionHash: QUESTION_HASH })).toBeNull();
    expect(findAudit([{ ...first, questionHash: 'other' }], { head: HEAD, questionHash: 'other' })).toBeNull();
    expect(findAudit([], { head: HEAD, questionHash: QUESTION_HASH })).toBeNull();
  });
});

function adapter(report = { exitCode: 0, timedOut: false, lastMessage: 'NOT WEAKENED' }) {
  const fs = { readFileSync: vi.fn(() => '{}'), mkdtempSync: vi.fn(() => '/scratch/audit-1'),
    writeFileSync: vi.fn(), rmSync: vi.fn(), mkdirSync: vi.fn(), appendFileSync: vi.fn() };
  const spawnSync = vi.fn(() => ({ status: 0, stdout: JSON.stringify(report) }));
  const deps = createAuditDeps({ cwd: '/repo', home: '/home/test', scratchRoot: '/scratch', fs, spawnSync });
  return { deps, fs, spawnSync };
}

describe('audit IO with injected filesystem and subprocesses', () => {
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
    expect(f.spawnSync.mock.calls[0][1]).toEqual(['scripts/codex-direct-task.mjs', '--review', '--json', '--gate=none', '--task-file=/scratch/audit-1/task.md', '--dir=/repo']);
    expect(f.fs.rmSync).toHaveBeenCalledWith('/scratch/audit-1', { recursive: true, force: true });
  });

  it('reads the final JSON report after streamed JSONL events', () => {
    const f = adapter();
    f.spawnSync.mockReturnValue({ status: 0, stdout: '{"type":"event"}\n' + JSON.stringify({ exitCode: 0, timedOut: false, lastMessage: 'WEAKENED' }, null, 2) });
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
    expect(() => f.deps.runCodex('prompt')).toThrow();
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
