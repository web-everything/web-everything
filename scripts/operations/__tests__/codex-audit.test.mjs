/** @file Hermetic standalone audit contract and real-adapter boundary tests. */
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { CANONICAL_QUESTION, QUESTION_HASH, main, findAudit, isAcceptedQuestionHash, resolvePriorQuestionHashes, MAX_PRIOR_WINDOW_MS } from '../codex-audit.mjs';
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

  it.each(['NOT WEAKENED', 'WEAKENED'])('preserves repeated agreeing verdicts and findings mentioning verdict words: %s', async verdict => {
    const f = fixture(`${verdict}\n${verdict}\nscripts/gate.mjs:12 checks WEAKENED and NOT WEAKENED, \`WEAKENED\`, "NOT WEAKENED", --head and ../paths`);
    expect(await main(ARGS, f.deps)).toBe(verdict === 'NOT WEAKENED' ? 0 : 1);
    expect(f.records).toHaveLength(1);
    expect(findAudit(f.records, { base: BASE, head: HEAD, questionHash: QUESTION_HASH })).toBe(f.records[0]);
  });

  it.each(conflictingAnswers)('findAudit ignores historical contradictory records: %j', async answer => {
    const verdict = answer.startsWith('WEAKENED') ? 'WEAKENED' : 'NOT WEAKENED';
    const f = fixture(verdict);
    await main(ARGS, f.deps);
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
    const f = fixture('WEAKENED\nx:1 \x1b[31mbypass\x1b[0m\x07');
    await main(ARGS, f.deps);
    expect(f.output.join('')).toBe('WEAKENED\nx:1 bypass\n');
  });

  it('findAudit selects the later appended record when timestamps are equal', () => {
    const first = { base: BASE, head: HEAD, questionHash: QUESTION_HASH, at: AT, verdict: 'NOT WEAKENED' };
    const later = { ...first, verdict: 'WEAKENED' };
    expect(findAudit([first, later], { base: BASE, head: HEAD, questionHash: QUESTION_HASH })).toBe(later);
  });

  it('findAudit selects latest exact base, head and canonical hash, rejecting other hashes and heads', () => {
    const first = { base: BASE, head: HEAD, questionHash: QUESTION_HASH, verdict: 'NOT WEAKENED', at: '2026-01-01T00:00:00.000Z' };
    const latest = { ...first, at: AT };
    const records = [latest, { ...latest, head: BASE }, { ...latest, questionHash: 'other' }, first];
    expect(findAudit(records, { base: BASE, head: HEAD, questionHash: QUESTION_HASH })).toBe(latest);
    expect(findAudit(records, { base: BASE, head: BASE, questionHash: 'other' })).toBeNull();
    expect(findAudit([first], { base: BASE, head: BASE, questionHash: QUESTION_HASH })).toBeNull();
    expect(findAudit([{ ...first, questionHash: 'other' }], { base: BASE, head: HEAD, questionHash: 'other' })).toBeNull();
    expect(findAudit([], { base: BASE, head: HEAD, questionHash: QUESTION_HASH })).toBeNull();
  });

  it('findAudit rejects a different base for the same head and canonical hash', () => {
    const record = { base: HEAD, head: HEAD, questionHash: QUESTION_HASH, verdict: 'NOT WEAKENED', at: AT };
    expect(findAudit([record], { base: BASE, head: HEAD, questionHash: QUESTION_HASH })).toBeNull();
  });

  it.each([undefined, null, '', 'origin/main', 'a'.repeat(39), 'g'.repeat(40), BASE + '\n'])('findAudit rejects missing or non-full base %j', base => {
    const record = { base, head: HEAD, questionHash: QUESTION_HASH, verdict: 'NOT WEAKENED', at: AT };
    expect(findAudit([record], { base, head: HEAD, questionHash: QUESTION_HASH })).toBeNull();
  });

  it.each([undefined, null, '', 'main', 'b'.repeat(39), 'b'.repeat(41), 'g'.repeat(40), HEAD + '\n'])('findAudit rejects missing or non-full head %j even when the record matches', head => {
    const record = { base: BASE, head, questionHash: QUESTION_HASH, verdict: 'NOT WEAKENED', at: AT };
    expect(findAudit([record], { base: BASE, head, questionHash: QUESTION_HASH })).toBeNull();
  });

  it.each([undefined, null, '', 'garbage', 'not weakened', 'NOT WEAKENED ', ' WEAKENED', 'WEAKENED\n'])('findAudit ignores newer invalid verdict %j without displacing valid evidence', verdict => {
    const valid = { base: BASE, head: HEAD, questionHash: QUESTION_HASH, verdict: 'WEAKENED', at: '2026-01-01T00:00:00.000Z' };
    const invalid = { ...valid, verdict, at: AT };
    const query = { base: BASE, head: HEAD, questionHash: QUESTION_HASH };
    expect(findAudit([valid, invalid], query)).toBe(valid);
    expect(findAudit([invalid], query)).toBeNull();
  });

  it('findAudit rejects a missing query base and legacy records without a base', () => {
    const record = { base: BASE, head: HEAD, questionHash: QUESTION_HASH, verdict: 'NOT WEAKENED', at: AT };
    expect(findAudit([record], { head: HEAD, questionHash: QUESTION_HASH })).toBeNull();
    const legacy = { head: HEAD, questionHash: QUESTION_HASH, verdict: 'NOT WEAKENED', at: AT };
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

describe('prior question hashes (AU1 PR-B)', () => {
  const PRIOR = 'c'.repeat(64);
  const NOW = Date.parse('2026-11-04T12:00:00.000Z');
  const window = acceptUntil => [{ hash: PRIOR, acceptUntil }];
  const open = window('2026-11-10T00:00:00.000Z');
  const rec = (verdict, over = {}) => ({ head: HEAD, base: BASE, questionHash: PRIOR, at: AT, verdict, findings: [], ...over });
  const find = (records, priorQuestionHashes) => findAudit(records, { base: BASE, head: HEAD, questionHash: QUESTION_HASH, priorQuestionHashes, now: NOW });

  it('accepts the current hash and a prior hash only inside its window', () => {
    expect(isAcceptedQuestionHash(QUESTION_HASH, { priorQuestionHashes: [], now: NOW })).toBe(true);
    expect(isAcceptedQuestionHash(PRIOR, { priorQuestionHashes: open, now: NOW })).toBe(true);
    expect(isAcceptedQuestionHash(PRIOR, { priorQuestionHashes: window('2026-11-04T11:59:59.000Z'), now: NOW })).toBe(false);
    expect(isAcceptedQuestionHash('d'.repeat(64), { priorQuestionHashes: open, now: NOW })).toBe(false);
    expect(isAcceptedQuestionHash(PRIOR, { priorQuestionHashes: [], now: NOW })).toBe(false);
    expect(isAcceptedQuestionHash(PRIOR, { priorQuestionHashes: [{ hash: PRIOR, acceptUntil: 'nope' }], now: NOW })).toBe(false);
  });
  it('a prior NOT WEAKENED passes inside its window', () => {
    const r = rec('NOT WEAKENED');
    expect(find([r], open)).toBe(r);
  });
  it('a prior WEAKENED still blocks (is returned as WEAKENED)', () => {
    expect(find([rec('WEAKENED', { findings: ['x.mjs:1 gap'] })], open)?.verdict).toBe('WEAKENED');
  });
  it('a later prior WEAKENED beats an earlier prior NOT WEAKENED', () => {
    const later = rec('WEAKENED', { at: '2026-11-02T12:00:00.000Z', findings: ['x.mjs:1 gap'] });
    expect(find([rec('NOT WEAKENED'), later], open)).toBe(later);
  });
  it('unknown, expired or unlisted prior hashes are ignored', () => {
    expect(find([rec('NOT WEAKENED')], [])).toBeNull();
    expect(find([rec('NOT WEAKENED')], window('2026-11-04T11:00:00.000Z'))).toBeNull();
    expect(find([rec('NOT WEAKENED', { questionHash: 'd'.repeat(64) })], open)).toBeNull();
  });
  it('a prior NOT WEAKENED never overrides a current-question WEAKENED, in either order', () => {
    const cur = rec('WEAKENED', { questionHash: QUESTION_HASH, at: '2026-11-01T12:00:00.000Z', findings: ['x.mjs:1 gap'] });
    const prior = rec('NOT WEAKENED', { at: '2026-11-03T12:00:00.000Z' });
    expect(find([cur, prior], open)).toBe(cur);
    expect(find([prior, cur], open)).toBe(cur);
  });
  it('a contradictory current-question record blocks the prior fallback', () => {
    const bad = rec('NOT WEAKENED', { questionHash: QUESTION_HASH, at: '2026-11-02T12:00:00.000Z', findings: ['WEAKENED'] });
    expect(find([rec('NOT WEAKENED'), bad], open)).toBeNull();
  });
  it('prior records older than 30 days before acceptUntil, or dated after it, are ignored', () => {
    expect(find([rec('NOT WEAKENED', { at: '2020-01-01T00:00:00.000Z' })], open)).toBeNull();
    expect(find([rec('NOT WEAKENED', { at: '2026-11-11T00:00:00.000Z' })], open)).toBeNull();
  });
  it('contradictory prior records are still rejected', () => {
    expect(find([rec('NOT WEAKENED', { findings: ['WEAKENED'] })], open)).toBeNull();
  });
  it('the setting lands empty and invalid values resolve to empty', () => {
    expect(resolvePriorQuestionHashes()).toEqual([]);
    expect(resolvePriorQuestionHashes({ readFile: () => '{"audit":{"priorQuestionHashes":[{"hash":"zz","acceptUntil":"2026-12-01"}]}}' })).toEqual([]);
    expect(resolvePriorQuestionHashes({ readFile: () => { throw new Error('unreadable'); } })).toEqual([]);
  });
  const settingsWith = list => () => JSON.stringify({ audit: { priorQuestionHashes: list } });
  it('resolves a valid nonempty prior-question-hash setting', () => {
    const list = [{ hash: PRIOR, acceptUntil: '2026-12-01T00:00:00.000Z' }, { hash: 'd'.repeat(64), acceptUntil: '2026-12-02T00:00:00.000Z' }];
    expect(resolvePriorQuestionHashes({ readFile: settingsWith(list), env: {} })).toEqual(list);
    // one invalid entry voids the whole list (strictest reading)
    expect(resolvePriorQuestionHashes({ readFile: settingsWith([...list, { hash: 'zz', acceptUntil: '2026-12-01' }]), env: {} })).toEqual([]);
  });
  it('excludes platform prior-question hashes', () => {
    const dir = realFs.mkdtempSync(join(tmpdir(), 'codex-audit-platform-'));
    try {
      const file = join(dir, 'platform.json');
      const platform = { hash: 'e'.repeat(64), acceptUntil: '2026-12-05T00:00:00.000Z' };
      realFs.writeFileSync(file, JSON.stringify({ audit: { priorQuestionHashes: [platform] } }));
      const env = { WE_PLATFORM_PREFERENCES_FILE: file };
      // tool layer unset (empty file, then unreadable): a platform-only value must not surface
      expect(resolvePriorQuestionHashes({ env, readFile: () => '{}' })).toEqual([]);
      expect(resolvePriorQuestionHashes({ env, readFile: () => { throw new Error('unreadable'); } })).toEqual([]);
      // a tool value is kept without the platform entry merged in
      const tool = { hash: PRIOR, acceptUntil: '2026-12-01T00:00:00.000Z' };
      expect(resolvePriorQuestionHashes({ env, readFile: settingsWith([tool]) })).toEqual([tool]);
    } finally { realFs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('window boundaries: acceptUntil and the 30-day lower bound are inclusive, one ms past is rejected', () => {
    const until = '2026-11-10T00:00:00.000Z', U = Date.parse(until), list = window(until);
    const ok = (now, at) => isAcceptedQuestionHash(PRIOR, { priorQuestionHashes: list, now, at });
    expect(MAX_PRIOR_WINDOW_MS).toBe(30 * 24 * 3600 * 1000);
    expect(ok(U, undefined)).toBe(true);
    expect(ok(U + 1, undefined)).toBe(false);
    expect(ok(U, until)).toBe(true);
    expect(ok(U, new Date(U + 1).toISOString())).toBe(false);
    expect(ok(U, new Date(U - MAX_PRIOR_WINDOW_MS).toISOString())).toBe(true);
    expect(ok(U, new Date(U - MAX_PRIOR_WINDOW_MS - 1).toISOString())).toBe(false);
  });
  it('a current-question record for another head or base does not block the prior fallback', () => {
    const prior = rec('NOT WEAKENED');
    expect(find([prior, rec('WEAKENED', { questionHash: QUESTION_HASH, head: BASE, findings: ['x.mjs:1 gap'] })], open)).toBe(prior);
    expect(find([prior, rec('WEAKENED', { questionHash: QUESTION_HASH, base: HEAD, findings: ['x.mjs:1 gap'] })], open)).toBe(prior);
  });
  it.each([
    ['an invalid timestamp', { at: 'not-a-date' }],
    ['an unrecognized verdict', { verdict: 'MAYBE' }],
    ['a missing verdict', { verdict: undefined }],
  ])('a current-question record with %s blocks the prior fallback', (_name, over) => {
    const bad = rec('NOT WEAKENED', { questionHash: QUESTION_HASH, ...over });
    expect(find([rec('NOT WEAKENED'), bad], open)).toBeNull();
    expect(find([bad, rec('NOT WEAKENED')], open)).toBeNull();
  });
  it('replay over a frozen copy of audits.jsonl is identical with priorQuestionHashes empty', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
    const records = realFs.readFileSync(join(dir, 'audits-frozen.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const expected = JSON.parse(realFs.readFileSync(join(dir, 'audits-frozen.expected.json'), 'utf8'));
    const pairs = [...new Set(records.map(r => `${r.head}/${r.base}`))];
    expect(pairs.length).toBeGreaterThan(10);
    for (const key of pairs) {
      const [head, base] = key.split('/');
      const got = findAudit(records, { head, base, questionHash: QUESTION_HASH, priorQuestionHashes: [] });
      expect(got ? { at: got.at, verdict: got.verdict } : null).toEqual(expected[key]);
    }
  });
});
