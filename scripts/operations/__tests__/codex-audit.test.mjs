/** @file Hermetic standalone audit contract and real-adapter boundary tests. */
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CANONICAL_QUESTION, EXHAUSTIVE_INSTRUCTION, QUESTION_HASH, main, findAudit, isAcceptedQuestionHash, resolvePriorQuestionHashes, MAX_PRIOR_WINDOW_MS, resolveEfficiencySettings, resolveWaivedMaxFiles } from '../codex-audit.mjs';
import { createAuditDeps } from '../codex-audit-io.mjs';
import * as protectedPaths from '../../lib/protected-path-floor.mjs';
import { matchesSome } from '../audit-verdict.mjs';

// Lets one test swap the text codex-audit.mjs reads for its settings file; every other read passes through.
const settingsOverride = vi.hoisted(() => ({ text: null }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  const readFileSync = (path, ...rest) => settingsOverride.text !== null && String(path).endsWith('settings/codex-audit.json') ? settingsOverride.text : actual.readFileSync(path, ...rest);
  return { ...actual, readFileSync, default: { ...actual.default, readFileSync } };
});

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
    // R1081: the exhaustive-list instruction follows the hashed question, so the hash and old records are unchanged.
    expect(f.deps.runCodex.mock.calls[0][0]).toContain(`${CANONICAL_QUESTION}\n\n${EXHAUSTIVE_INSTRUCTION}\n\n`);
    expect(CANONICAL_QUESTION).not.toContain(EXHAUSTIVE_INSTRUCTION);
    // Pin the text: reversing the requirement (e.g. "stop at the first finding") must fail this test.
    expect(EXHAUSTIVE_INSTRUCTION).toBe('List EVERY finding you can find in this one exhaustive pass; do not stop at the first finding.');
    expect(f.deps.runCodex.mock.calls[0][0]).toContain('List EVERY finding you can find in this one exhaustive pass; do not stop at the first finding.');
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

  it('findAudit selects the last-appended exact base, head and canonical hash, rejecting other hashes and heads', () => {
    const first = { base: BASE, head: HEAD, questionHash: QUESTION_HASH, verdict: 'NOT WEAKENED', at: '2026-01-01T00:00:00.000Z' };
    const latest = { ...first, at: AT };
    const records = [first, { ...latest, head: BASE }, { ...latest, questionHash: 'other' }, latest];
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
    expect(f.spawnSync.mock.calls[1][2].env).toEqual({ ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_INDEX_FILE: '/scratch/audit-1/index' });
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
  it('findAudit accepts configured prior hashes when options omit priorQuestionHashes', () => {
    // The default parameter resolves the tool-layer setting; feed it a nonempty value through the mocked read.
    const list = [{ hash: PRIOR, acceptUntil: '2099-01-01T00:00:00.000Z' }];
    const prior = rec('NOT WEAKENED', { at: '2098-12-20T00:00:00.000Z' });
    const omit = records => findAudit(records, { base: BASE, head: HEAD, questionHash: QUESTION_HASH, now: Date.parse('2098-12-25T00:00:00.000Z') });
    try {
      settingsOverride.text = JSON.stringify({ audit: { priorQuestionHashes: list } });
      expect(omit([prior])).toBe(prior);
      // the same configured window still honours a prior WEAKENED and the current-question block
      const weak = rec('WEAKENED', { at: '2098-12-21T00:00:00.000Z', findings: ['x.mjs:1 gap'] });
      expect(omit([prior, weak])).toBe(weak);
      expect(omit([prior, rec('NOT WEAKENED', { questionHash: QUESTION_HASH, at: 'not-a-date' })])).toBeNull();
    } finally { settingsOverride.text = null; }
    // the shipped (empty) setting accepts nothing extra
    expect(omit([prior])).toBeNull();
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

describe('audit record fingerprint (R503)', () => {
  it('stores the head net-diff fingerprint when readable and omits it when not', async () => {
    const fp = 'c'.repeat(64);
    const f = fixture(); f.deps.fingerprint = vi.fn(async () => fp);
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(f.deps.fingerprint).toHaveBeenCalledWith(BASE, HEAD);
    expect(f.records[0]).toMatchObject({ head: HEAD, fingerprint: fp });
    for (const bad of [async () => null, async () => { throw new Error('git'); }]) {
      const g = fixture(); g.deps.fingerprint = bad;
      expect(await main(ARGS, g.deps)).toBe(0);
      expect(g.records[0]).not.toHaveProperty('fingerprint');
    }
  });
});

describe('findAudit ordering and clock trust (#7011)', () => {
  const NOW = Date.parse('2026-11-17T12:00:00Z');
  const rec = (verdict, at) => ({ head: HEAD, base: BASE, questionHash: QUESTION_HASH, verdict, at, findings: [] });
  const find = records => findAudit(records, { base: BASE, head: HEAD, questionHash: QUESTION_HASH, priorQuestionHashes: [], now: NOW });

  it('a future-dated NOT WEAKENED does not override a later-appended WEAKENED', () => {
    const pass = rec('NOT WEAKENED', '2099-01-01T00:00:00Z');
    const weak = rec('WEAKENED', '2026-11-17T11:59:00Z');
    expect(find([pass, weak])).toBe(weak);
    expect(find([pass])).toBeNull();
  });

  it('a future-dated WEAKENED still blocks an older pass (fail closed)', () => {
    const pass = rec('NOT WEAKENED', '2026-11-17T11:00:00Z');
    const weak = rec('WEAKENED', '2099-01-01T00:00:00Z');
    expect(find([pass, weak])).toBe(weak);
  });

  it('tolerates up to 5 minutes of clock skew but not more', () => {
    expect(find([rec('NOT WEAKENED', '2026-11-17T12:04:00Z')])).not.toBeNull();
    expect(find([rec('NOT WEAKENED', '2026-11-17T12:06:00Z')])).toBeNull();
  });

  it('append order decides, not the self-reported timestamp', () => {
    const first = rec('NOT WEAKENED', '2026-11-17T11:00:00Z');
    const second = rec('WEAKENED', '2026-11-17T10:00:00Z');
    expect(find([first, second])).toBe(second);
    expect(find([second, first])).toBe(first);
  });
});


describe('debounce and delta audits', () => {
  const PREV = 'c'.repeat(40), NEXT = 'd'.repeat(40);
  const time = Date.parse(AT);
  // The shipped default is delta OFF (maxFiles 0); these tests enable it explicitly.
  beforeEach(() => { settingsOverride.text = JSON.stringify({ audit: { delta: { maxFiles: 5 } } }); });
  afterEach(() => { settingsOverride.text = null; });
  it('the shipped default config never writes a delta record', async () => {
    settingsOverride.text = null;
    const f = delta();
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(f.deps.runCodex.mock.calls[0][0]).toContain(`git diff ${BASE}...${HEAD}`);
    expect(f.records[0]).not.toHaveProperty('basis');
    expect(f.deps.diffFiles).not.toHaveBeenCalled();
  });
  const basis = (over = {}) => ({ base: BASE, head: PREV, questionHash: QUESTION_HASH,
    verdict: 'NOT WEAKENED', at: AT, findings: [], ...over });
  function delta(records = [basis()], files = ['docs/a.md', 'docs/b.md']) {
    const f = fixture();
    Object.assign(f.deps, { nowMs: () => time, readRecords: vi.fn(() => records),
      isAncestor: vi.fn(() => true), diffFiles: vi.fn(() => files) });
    return f;
  }
  async function full(f) {
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(f.deps.runCodex).toHaveBeenCalledOnce();
    expect(f.deps.runCodex.mock.calls[0][0]).toContain(`git diff ${BASE}...${HEAD}`);
    expect(f.records[0]).not.toHaveProperty('basis');
  }
  describe('waived WEAKENED basis (DELTA-AUDIT S1)', () => {
    const ref = 'lane/test', ruling = 'R-delta-audit';
    const findings = ['docs/a.md:12 first waived issue', 'docs/b.md:34 second waived issue'];
    const args = [...ARGS, `--branch=${ref}`, '--now'];
    const waivedBasis = (over = {}) => basis({ verdict: 'WEAKENED', findings: [...findings], ...over });
    function settings(maxFiles = 15, ordinaryMaxFiles = 5) {
      settingsOverride.text = JSON.stringify({ audit: { delta: { maxFiles: ordinaryMaxFiles, waivedCarry: { maxFiles } } } });
    }
    function waived({ records = [waivedBasis()], files, answer = 'NOT WEAKENED' } = {}) {
      const f = delta(records, files);
      f.deps.runCodex.mockResolvedValue(answer);
      Object.assign(f.deps, {
        branchTip: vi.fn(() => HEAD),
        readWaivers: vi.fn(() => [{ ref, sha: PREV, ruling, findings: [...findings] }]),
        mergesBetween: vi.fn(() => false), mergeBaseOf: vi.fn(() => BASE),
      });
      return f;
    }
    async function refused(f, argv = args) {
      expect(await main(argv, f.deps)).toBe(0);
      expect(f.deps.runCodex).toHaveBeenCalledOnce();
      expect(f.deps.runCodex.mock.calls[0][0]).toContain(`Review this exact resolved range: git diff ${BASE}...${HEAD}`);
      expect(f.records).toHaveLength(1);
      expect(f.records[0]).not.toHaveProperty('basis');
      expect(f.records[0]).not.toHaveProperty('deltaOf');
    }
    beforeEach(() => {
      settings();
      vi.stubEnv('WE_AUDIT_DELTA_WAIVED_MAX_FILES', undefined);
      // Vitest 1.x stringifies undefined; explicitly remove the tracked variable.
      delete process.env.WE_AUDIT_DELTA_WAIVED_MAX_FILES;
    });
    afterEach(() => vi.unstubAllEnvs());

    it.each(['0', '1', 'invalid'])('global delta env cap %s also limits waived carry', async bound => {
      vi.stubEnv('WE_AUDIT_DELTA_MAX_FILES', bound);
      await refused(waived());
    });
    it.each([{}, { basis: PREV }])('newer WEAKENED ancestor %j cannot fall back to an older waived ancestor', async over => {
      // Ledger order wins even when the later record reports an earlier timestamp.
      const newer = waivedBasis({ head: NEXT, at: '2026-11-01T11:00:00.000Z', ...over });
      await refused(waived({ records: [waivedBasis(), newer] }));
    });
    it.each([
      { base: NEXT }, { base: NEXT, verdict: 'NOT WEAKENED' },
      { verdict: 'NOT WEAKENED' }, { basis: NEXT }, { findings: ['docs/a.md:12 changed'] },
      { at: 'unreadable' }, { at: undefined }, { verdict: 'UNKNOWN' },
      { questionHash: 'unknown' }, { findings: null }, { at: '2099-01-01' },
    ])('any conflicting or unusable record for candidate vetoes reuse: %j', async conflict => {
      for (const records of [[waivedBasis(conflict), waivedBasis()], [waivedBasis(), waivedBasis(conflict)]]) {
        await refused(waived({ records }));
      }
    });
    it.each(['absent', 'throws', 'mismatch', 'unreadable'])('branch binding refuses %s with an explicit reason', async mode => {
      const f = waived();
      if (mode === 'absent') delete f.deps.branchTip;
      else f.deps.branchTip.mockImplementation(() => {
        if (mode === 'throws') throw new Error('denied');
        return mode === 'mismatch' ? NEXT : null;
      });
      expect(await main([...args, '--explain-basis'], f.deps)).toBe(0);
      expect(f.output.join('')).toBe('refused: branch tip differs from head\n');
      expect(f.deps.runCodex).not.toHaveBeenCalled();
    });
    it.each(['docs/a.md:99 first waived issue', 'docs/a.md:12 a different issue', findings[0] + ' ', findings[0] + '\x1b[0m'])(
      'KNOWN requires byte-equal text: %s', async text => {
        const line = `KNOWN 1: ${text}`, f = waived({ answer: `WEAKENED\n${line}` });
        expect(await main(args, f.deps)).toBe(1);
        expect(f.records[0].findings).toContain(line.replace('\x1b[0m', ''));
      });
    it('WEAKENED without valid KNOWN appends synthetic evidence and retains delta evidence', async () => {
      const f = waived({ answer: 'WEAKENED' });
      expect(await main(args, f.deps)).toBe(1);
      expect(f.records[0]).toMatchObject({ deltaVerdict: 'WEAKENED', deltaFindings: [],
        findings: [...findings, 'delta audit reported WEAKENED without a waived finding to attribute it to'] });
    });
    it.each(['package.json', 'package-lock.json', 'vitest.config.ts', 'vitest.config.mjs',
      'scripts/check-standards.mjs', 'scripts/check-standards-extra.mjs', 'scripts/lib/standards-extra.mjs',
      'scripts/operations/__tests__/codex-audit.test.mjs', 'scripts/operations/__tests__/codex-audit-extra.test.mjs',
      'scripts/operations/codex-audit.mjs', 'scripts/operations/codex-audit-extra.mjs', 'scripts/lib/related-test-selection.mjs',
      'scripts/operations/urgent-verify-marker.mjs', 'scripts/verify-lane.mjs', 'scripts/verify-lane-io.mjs'])(
      'merge protection refuses build or verification path %s', async file => { await refused(waived({ files: [file] })); });

    it('selects a waived full basis, numbers its findings and records the exact canonical binding', async () => {
      const f = waived();
      f.deps.fingerprint = vi.fn(() => 'delta-fingerprint');
      expect(await main(args, f.deps)).toBe(1);
      const prompt = f.deps.runCodex.mock.calls[0][0];
      expect(prompt).toContain(`${CANONICAL_QUESTION}\n\n${EXHAUSTIVE_INSTRUCTION}`);
      expect(prompt).toContain(`Head ${PREV} is audited WEAKENED with these 2 findings, which the operator waived under ${ruling}.`);
      expect(prompt).toContain(`Judge only \`git diff ${PREV}..${HEAD}\`, in the context of the whole change.`);
      expect(prompt).toContain(`1. ${findings[0]}`);
      expect(prompt).toContain(`2. ${findings[1]}`);
      expect(prompt).toContain('When a delta finding is the same issue as waived finding k, write it as `KNOWN k: <text>`.');
      expect(prompt).toContain(`Review this exact resolved range: git diff ${PREV}..${HEAD}\n`);
      expect(f.records).toEqual([{ at: AT, base: BASE, head: HEAD, baseRef: 'origin/main',
        questionHash: QUESTION_HASH, verdict: 'WEAKENED', findings, fingerprint: 'delta-fingerprint',
        basis: PREV, deltaOf: { sha: PREV, ruling }, deltaVerdict: 'NOT WEAKENED', deltaFindings: [] }]);
      expect(findAudit(f.records, { base: BASE, head: HEAD, questionHash: QUESTION_HASH, now: time })).toBe(f.records[0]);
      expect(f.deps.readWaivers).toHaveBeenCalledWith(ref);
      expect(f.deps.isAncestor).toHaveBeenCalledWith(PREV, HEAD);
      expect(f.deps.diffFiles).toHaveBeenCalledWith(PREV, HEAD);
      expect(f.deps.mergesBetween).toHaveBeenCalledWith(PREV, HEAD);
      expect(f.deps.mergeBaseOf.mock.calls).toEqual([[BASE, PREV], [BASE, HEAD]]);
    });
    it('selects the waived basis after main moves when the fork point is unchanged (#7458)', async () => {
      const f = waived({ records: [waivedBasis({ base: NEXT })] });
      expect(await main(args, f.deps)).toBe(1);
      expect(f.deps.mergeBaseOf.mock.calls).toEqual([[NEXT, PREV], [BASE, HEAD]]);
      expect(f.deps.runCodex.mock.calls[0][0]).toContain(`git diff ${PREV}..${HEAD}`);
      expect(f.records[0]).toMatchObject({ base: BASE, head: HEAD, basis: PREV,
        findings, deltaOf: { sha: PREV, ruling }, deltaVerdict: 'NOT WEAKENED', deltaFindings: [] });
    });
    it.each(['different', 'prior throws', 'current throws', 'unreadable'])(
      'fork point %s refuses with an explicit reason', async evidence => {
        const f = waived({ records: [waivedBasis({ base: NEXT })] });
        f.deps.mergeBaseOf.mockImplementation((base, head) => {
          if ((evidence === 'prior throws' && head === PREV) || (evidence === 'current throws' && head === HEAD))
            throw new Error('unreadable');
          return evidence === 'unreadable' ? undefined : evidence === 'different' && head === HEAD ? NEXT : BASE;
        });
        expect(await main([...args, '--explain-basis'], f.deps)).toBe(0);
        expect(f.output.join('')).toBe('refused: fork point differs\n');
        expect(f.deps.runCodex).not.toHaveBeenCalled();
        expect(f.deps.appendRecord).not.toHaveBeenCalled();
      });
    it.each([
      ['only KNOWN findings', findings.map((f, i) => `KNOWN ${i + 1}: ${f}`), []],
      ['a new finding', ['docs/c.md:9 new issue'], ['docs/c.md:9 new issue']],
      ['KNOWN with a different cited file', ['KNOWN 1: docs/c.md:9 different issue'], ['KNOWN 1: docs/c.md:9 different issue']],
      ['KNOWN with out-of-range index', ['KNOWN 3: docs/a.md:9 issue'], ['KNOWN 3: docs/a.md:9 issue']],
      ['KNOWN with zero index', ['KNOWN 0: docs/a.md:9 issue'], ['KNOWN 0: docs/a.md:9 issue']],
      ['KNOWN with noninteger index', ['KNOWN 1.5: docs/a.md:9 issue'], ['KNOWN 1.5: docs/a.md:9 issue']],
      ['KNOWN without a cited file', ['KNOWN 1: same issue'], ['KNOWN 1: same issue']],
    ])('preserves verbatim waived findings and appends unrecognized delta findings: %s', async (_label, deltaFindings, added) => {
      const f = waived({ answer: ['WEAKENED', ...deltaFindings].join('\n') });
      expect(await main(args, f.deps)).toBe(1);
      expect(f.records[0]).toMatchObject({ basis: PREV, verdict: 'WEAKENED', deltaVerdict: 'WEAKENED',
        deltaFindings, findings: [...findings, ...added, ...(deltaFindings.some(f => findings.some((w, i) => f === `KNOWN ${i + 1}: ${w}`)) ? [] : ['delta audit reported WEAKENED without a waived finding to attribute it to'])] });
      expect(JSON.stringify(f.records[0].findings) === JSON.stringify(findings)).toBe(added.length === 0);
    });
    it.each([
      ['revoked or absent waiver', f => f.deps.readWaivers.mockReturnValue([])],
      ['wrong branch waiver', f => f.deps.readWaivers.mockReturnValue([{ ref: 'lane/other', sha: PREV, ruling, findings }])],
      ['wrong head waiver', f => f.deps.readWaivers.mockReturnValue([{ ref, sha: NEXT, ruling, findings }])],
      ['non-byte-equal findings', f => f.deps.readWaivers.mockReturnValue([{ ref, sha: PREV, ruling, findings: [...findings].reverse() }])],
      ['not an ancestor', f => f.deps.isAncestor.mockReturnValue(false)],
      ['candidate is head itself', f => f.deps.readRecords.mockReturnValue([waivedBasis({ head: HEAD })])],
      ['candidate is a delta record', f => f.deps.readRecords.mockReturnValue([waivedBasis({ basis: NEXT })])],
      ['candidate base unreadable', f => f.deps.readRecords.mockReturnValue([waivedBasis({ base: 'invalid' })])],
      ['merge in delta', f => f.deps.mergesBetween.mockReturnValue(true)],
      ['fork point differs', f => f.deps.mergeBaseOf.mockReturnValueOnce(BASE).mockReturnValueOnce(NEXT)],
      ['oversized delta', f => f.deps.diffFiles.mockReturnValue(Array.from({ length: 16 }, (_, i) => `docs/${i}.md`))],
      ['unreadable file list', f => f.deps.diffFiles.mockReturnValue(null)],
      ['WEAKENED current head', f => f.deps.readRecords.mockReturnValue([waivedBasis(), waivedBasis({ head: HEAD })])],
      ['equal-at later delta record', f => f.deps.readRecords.mockReturnValue([waivedBasis(), waivedBasis({ basis: NEXT })])],
      ['equal-at later changed findings', f => f.deps.readRecords.mockReturnValue([waivedBasis(), waivedBasis({ findings: ['docs/a.md:12 changed'] })])],
    ])('refuses waived reuse and runs a full audit: %s', async (_label, change) => {
      const f = waived(); change(f); await refused(f);
    });
    it('without --branch runs a full audit without looking up a waiver', async () => {
      const f = waived(); await refused(f, ARGS);
      expect(f.deps.readWaivers).not.toHaveBeenCalled();
    });
    it.each(['readWaivers', 'mergesBetween', 'mergeBaseOf', 'diffFiles', 'isAncestor'])(
      'unreadable %s falls back to the full audit for operator review', async key => {
        const f = waived(); f.deps[key].mockImplementation(() => { throw new Error('unreadable'); });
        await refused(f);
      });
    it.each(['readWaivers', 'mergesBetween', 'mergeBaseOf'])(
      'missing optional %s evidence falls back to full', async key => {
        const f = waived(); delete f.deps[key]; await refused(f);
      });
    it.each([
      ['scripts/operations/canonical-audit-gate.mjs'], ['scripts/pr-land.mjs'],
      ['scripts/operations/__tests__/renamed.test.mjs', 'scripts/pr-land.mjs'],
      ['scripts/guard-a.mjs'], ['scripts/readiness/forge-deploy.mjs'],
    ])('protected delta including either rename side forces full: %j', async (...files) => {
      await refused(waived({ files }));
    });
    it.each([0, -1, '15', null, {}, 1.5])('disabled or invalid waivedCarry.maxFiles=%j forces full', async maxFiles => {
      settings(maxFiles); await refused(waived());
    });
    it('unreadable settings force full', async () => {
      settingsOverride.text = 'unreadable JSON'; await refused(waived());
    });
    it('the shipped waived bound is 15 even with ordinary delta OFF', async () => {
      settingsOverride.text = null;
      const f = waived({ files: Array.from({ length: 15 }, (_, i) => `docs/${i}.md`) });
      expect(await main(args, f.deps)).toBe(1);
      expect(f.records[0].basis).toBe(PREV);
    });
    it('the shipped waived bound refuses 16 files', async () => {
      settingsOverride.text = null;
      await refused(waived({ files: Array.from({ length: 16 }, (_, i) => `docs/${i}.md`) }));
    });
    it('environment may tighten the waived bound', async () => {
      vi.stubEnv('WE_AUDIT_DELTA_WAIVED_MAX_FILES', '1'); await refused(waived());
    });
    it('environment cannot raise the waived bound', async () => {
      settings(1); vi.stubEnv('WE_AUDIT_DELTA_WAIVED_MAX_FILES', '15'); await refused(waived());
    });
    it('invalid environment bound forces full', async () => {
      vi.stubEnv('WE_AUDIT_DELTA_WAIVED_MAX_FILES', 'invalid'); await refused(waived());
    });
    it('prefers the existing NOT WEAKENED path without consulting waivers', async () => {
      const f = waived({ records: [basis()] });
      expect(await main(args, f.deps)).toBe(0);
      expect(f.records[0]).toMatchObject({ basis: PREV, verdict: 'NOT WEAKENED' });
      expect(f.records[0]).not.toHaveProperty('deltaOf');
      expect(f.deps.readWaivers).not.toHaveBeenCalled();
    });
    it.each([
      ['waived', () => waived(), `basis=${PREV} (waived)\n`],
      ['ordinary', () => waived({ records: [basis()] }), `basis=${PREV}\n`],
    ])('--explain-basis reports %s selection without auditing or writing', async (_label, make, expected) => {
      const f = make();
      expect(await main([...args, '--explain-basis'], f.deps)).toBe(0);
      expect(f.output.join('')).toBe(expected);
      expect(f.deps.runCodex).not.toHaveBeenCalled();
      expect(f.deps.appendRecord).not.toHaveBeenCalled();
    });
    it('--explain-basis reports an explicit refusal without auditing or writing', async () => {
      const f = waived(); f.deps.readWaivers.mockReturnValue([]);
      expect(await main([...args, '--explain-basis'], f.deps)).toBe(0);
      expect(f.output.join('')).toMatch(/^refused: [^\n]+\n$/);
      expect(f.output.join('')).toMatch(/waiver/i);
      expect(f.deps.runCodex).not.toHaveBeenCalled();
      expect(f.deps.appendRecord).not.toHaveBeenCalled();
    });
  });
  it('a second push within the debounce window cancels the pending audit and audits only the newest head once', async () => {
    let clock = time, tip = HEAD;
    const a = fixture();
    Object.assign(a.deps, { nowMs: () => clock, branchTip: vi.fn(() => tip),
      sleep: vi.fn(ms => { clock += Math.min(ms, 60_000); tip = NEXT; }) });
    expect(await main([...ARGS, '--branch=lane/test'], a.deps)).toBe(4);
    expect(a.deps.runCodex).not.toHaveBeenCalled();
    expect(a.records).toEqual([]);
    expect([...a.output, ...a.errors].join('')).toContain(`SUPERSEDED: branch moved to ${NEXT}; audit only the newest head`);
    const b = fixture();
    b.deps.resolveSha = vi.fn(ref => ref === 'origin/main' ? BASE : NEXT);
    Object.assign(b.deps, { nowMs: () => clock, branchTip: vi.fn(() => tip),
      sleep: vi.fn(ms => { clock += ms; }) });
    const start = clock;
    b.deps.runCodex.mockImplementation(() => { expect(clock - start).toBeGreaterThanOrEqual(300_000); return 'NOT WEAKENED'; });
    expect(await main(['--base=origin/main', `--head=${NEXT}`, '--branch=lane/test'], b.deps)).toBe(0);
    expect(b.deps.runCodex).toHaveBeenCalledOnce();
    expect(b.records).toHaveLength(1);
    expect(b.records[0].head).toBe(NEXT);
  });
  it('--now skips debounce but still checks the branch for waived eligibility', async () => {
    const f = fixture();
    Object.assign(f.deps, { branchTip: vi.fn(), sleep: vi.fn(), nowMs: () => time });
    expect(await main([...ARGS, '--now', '--branch=lane/test'], f.deps)).toBe(0);
    expect(f.deps.branchTip).toHaveBeenCalledOnce();
    expect(f.deps.branchTip).toHaveBeenCalledWith('lane/test');
    expect(f.deps.sleep).not.toHaveBeenCalled();
  });
  it('an undetermined branch runs immediately', async () => {
    const f = fixture();
    Object.assign(f.deps, { branchTip: vi.fn(() => null), sleep: vi.fn(), nowMs: () => time });
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(f.deps.sleep).not.toHaveBeenCalled();
  });
  it.each(['scripts/guard-a.mjs', 'scripts/nested/guard-a.mjs', 'scripts/readiness/forge-deploy.mjs'])('a changed guard or merge-path file forces full audit: %s', async file => {
    await full(delta(undefined, [file]));
  });
  it('a WEAKENED basis is never reused even with a later pass on a non-ancestor head', async () => {
    const f = delta([basis(), basis({ verdict: 'WEAKENED' }), basis({ head: NEXT })]);
    f.deps.isAncestor.mockImplementation(sha => sha === PREV);
    await full(f);
  });
  it.each([{ base: NEXT }, { questionHash: 'f'.repeat(64) }, { at: '2099-01-01' }, { at: 'invalid' },
    { findings: ['WEAKENED'] }, { head: HEAD }])('invalid basis falls back to full: %j', async over => { await full(delta([basis(over)])); });
  it('a non-ancestor basis falls back to full', async () => {
    const f = delta(); f.deps.isAncestor.mockReturnValue(false); await full(f);
  });
  it.each(['isAncestor', 'readRecords', 'diffFiles'])('throwing %s falls back to full rather than skipping', async key => {
    const f = delta(); f.deps[key].mockImplementation(() => { throw new Error('unreadable'); }); await full(f);
  });
  it.each([null, [], {}])('no readable usable ledger falls back to full: %j', async records => { await full(delta(records)); });
  it('a delta over maxFiles falls back to full', async () => { await full(delta(undefined, Array.from({ length: 6 }, (_, i) => `docs/${i}.md`))); });
  it.each([NEXT, null, ''])('finding 1: a delta record cannot become a basis, even with basis=%j', async prior => {
    await full(delta([basis({ basis: prior })]));
  });
  it.each([
    { verdict: 'WEAKENED' },
    { verdict: 'WEAKENED', base: NEXT, at: 'invalid', findings: ['NOT WEAKENED'] },
    { verdict: 'WEAKENED', questionHash: 'f'.repeat(64) },
    { verdict: 'unknown' }, { at: 'invalid' }, { findings: ['WEAKENED'] },
  ])('finding 2: any weakened or unreadable current-head record forces FULL: %j', async over => {
    await full(delta([basis(), basis({ head: HEAD, ...over })]));
  });
  it.each([{ base: NEXT }, { base: NEXT, at: 'invalid', findings: ['NOT WEAKENED'] },
    { questionHash: 'f'.repeat(64) }])('finding 3: any weakened basis record vetoes reuse across bases and states: %j', async over => {
    await full(delta([basis({ verdict: 'WEAKENED', ...over }), basis()]));
  });
  it('finding 4: an uppercase weakened basis head vetoes a lowercase pass', async () => {
    await full(delta([basis(), basis({ head: PREV.toUpperCase(), verdict: 'WEAKENED' })]));
  });
  it('finding 4: an uppercase weakened current head forces FULL', async () => {
    await full(delta([basis(), basis({ head: HEAD.toUpperCase(), base: NEXT.toUpperCase(), verdict: 'WEAKENED' })]));
  });
  it('finding 4: uppercase passing base and head use the normalized exact delta', async () => {
    const f = delta([basis({ base: BASE.toUpperCase(), head: PREV.toUpperCase() })]);
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(f.records[0].basis).toBe(PREV);
    expect(f.deps.diffFiles).toHaveBeenCalledWith(PREV, HEAD);
    expect(f.deps.runCodex.mock.calls[0][0]).toContain(`git diff ${PREV}..${HEAD}\n`);
  });
  it('valid basis plus two ordinary files audits the delta and preserves exact findAudit binding', async () => {
    const f = delta();
    expect(await main(ARGS, f.deps)).toBe(0);
    const prompt = f.deps.runCodex.mock.calls[0][0];
    expect(prompt).toContain(CANONICAL_QUESTION);
    expect(prompt).toContain(`git diff ${PREV}..${HEAD}\n`);
    expect(prompt).toContain('already audited NOT WEAKENED');
    expect(f.records[0]).toEqual({ at: AT, base: BASE, head: HEAD, baseRef: 'origin/main',
      questionHash: QUESTION_HASH, verdict: 'NOT WEAKENED', findings: [], basis: PREV });
    expect(findAudit(f.records, { base: BASE, head: HEAD, questionHash: QUESTION_HASH, now: time })).toBe(f.records[0]);
    expect(f.deps.diffFiles).toHaveBeenCalledWith(PREV, HEAD);
  });
  it('latest usable ancestor wins by ledger order, not self-reported timestamp', async () => {
    const f = delta([basis(), basis({ head: NEXT, at: '2026-10-31' })]);
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(f.records[0].basis).toBe(NEXT);
  });
  it.each([0, -1, '5', null])('invalid debounce minutes %j uses five minutes, never zero', async minutes => {
    settingsOverride.text = JSON.stringify({ audit: { debounce: { minutes } } });
    const f = fixture(); let clock = time;
    Object.assign(f.deps, { branchTip: vi.fn(() => HEAD), nowMs: () => clock, sleep: vi.fn(ms => { clock += ms; }) });
    try {
      expect(await main([...ARGS, '--branch=lane/test'], f.deps)).toBe(0);
      expect(clock - time).toBe(300_000);
    } finally { settingsOverride.text = null; }
  });
  it.each(['bad JSON', JSON.stringify({ audit: { delta: { maxFiles: -1 } } }), JSON.stringify({ audit: { delta: { maxFiles: '5' } } })])('unreadable or invalid delta setting disables delta: %s', async text => {
    settingsOverride.text = text;
    try { await full(delta()); } finally { settingsOverride.text = null; }
  });
});


describe('debounce and delta real adapters', () => {
  it('reads the same JSONL ledger that appendRecord writes', () => {
    const f = adapter();
    f.fs.readFileSync.mockImplementation(path => String(path).endsWith('prototype-load.json')
      ? '{"auditRecordPath":"audit.jsonl"}' : JSON.stringify({ head: HEAD }) + '\n');
    expect(f.deps.readRecords()).toEqual([{ head: HEAD }]);
    f.deps.appendRecord({ head: HEAD });
    expect(f.fs.readFileSync).toHaveBeenCalledWith('/repo/audit.jsonl', 'utf8');
    expect(f.fs.appendFileSync.mock.calls[0][0]).toBe('/repo/audit.jsonl');
  });
  it('gets the pushed branch tip and derives only a single matching lane branch', () => {
    const f = adapter();
    f.spawnSync.mockReturnValue({ status: 0, stdout: `${HEAD}\trefs/heads/lane/test\n` });
    expect(f.deps.branchTip('lane/test')).toBe(HEAD);
    expect(f.spawnSync.mock.calls[0][1]).toEqual(['ls-remote', '--heads', 'origin', 'refs/heads/lane/test']);
    expect(f.deps.findBranch(HEAD)).toBe('lane/test');
    f.spawnSync.mockReturnValue({ status: 0, stdout: `${HEAD}\trefs/heads/lane/a\n${HEAD}\trefs/heads/lane/b\n` });
    expect(f.deps.findBranch(HEAD)).toBeNull();
  });
  it('uses strict ancestry and exact two-dot file differences including renamed old paths', () => {
    const f = adapter();
    f.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    expect(f.deps.isAncestor(BASE, HEAD)).toBe(false);
    f.spawnSync.mockReturnValue({ status: 0, stdout: '' });
    expect(f.deps.isAncestor(BASE, HEAD)).toBe(true);
    expect(f.deps.isAncestor(HEAD, HEAD)).toBe(false);
    f.spawnSync.mockReturnValue({ status: 0, stdout: 'docs/a.md\0docs/b.md\0' });
    expect(f.deps.diffFiles(BASE, HEAD)).toEqual(['docs/a.md', 'docs/b.md']);
    expect(f.spawnSync.mock.calls.at(-1)[1]).toEqual(['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--name-only', '--no-renames', '-z', `${BASE}..${HEAD}`, '--']);
    f.spawnSync.mockReturnValue({ status: 128, stdout: '' });
    expect(() => f.deps.isAncestor(BASE, HEAD)).toThrow();
  });
});


describe('efficiency settings and late pushes', () => {
  it('honors configured debounce and derives a lane branch when omitted', async () => {
    settingsOverride.text = JSON.stringify({ audit: { debounce: { minutes: 2 } } });
    let clock = Date.parse(AT);
    const start = clock, f = fixture();
    Object.assign(f.deps, { findBranch: vi.fn(() => 'lane/test'), branchTip: vi.fn(() => HEAD),
      nowMs: () => clock, sleep: vi.fn(ms => { clock += ms; }) });
    try {
      expect(await main(ARGS, f.deps)).toBe(0);
      expect(clock - start).toBe(120_000);
      expect(f.deps.findBranch).toHaveBeenCalledWith(HEAD);
      expect(f.deps.branchTip).toHaveBeenCalledWith('lane/test');
    } finally { settingsOverride.text = null; }
  });
  it('does not publish a record if the branch moves while Codex is running', async () => {
    let clock = Date.parse(AT), tip = HEAD;
    const f = fixture();
    Object.assign(f.deps, { branchTip: vi.fn(() => tip), nowMs: () => clock,
      sleep: vi.fn(ms => { clock += ms; }) });
    f.deps.runCodex.mockImplementation(() => { tip = BASE; return 'NOT WEAKENED'; });
    expect(await main([...ARGS, '--branch=lane/test'], f.deps)).toBe(4);
    expect(f.records).toEqual([]);
  });
  it.each(['--branch=../lane', '--branch=-lane', '--branch=lane/test\n', '--now=true'])('rejects malformed new flags: %s', async flag => {
    const f = fixture(); expect(await main([...ARGS, flag], f.deps)).toBe(2);
    expect(f.deps.runCodex).not.toHaveBeenCalled();
  });
});


describe('efficiency settings cascade', () => {
  const resolve = (audit, extra = {}) => resolveEfficiencySettings({ readFile: () => JSON.stringify({ audit }),
    platform: null, env: {}, log: () => {}, ...extra });
  it('defaults missing efficiency keys to five, using a Node file URL for real settings', () => {
    expect(resolve({})).toEqual({ minutes: 5, maxFiles: 0 });
    const readFile = vi.fn(path => { expect(path).toBeInstanceOf(NodeURL); return '{"audit":{}}'; });
    expect(resolve({}, { readFile })).toEqual({ minutes: 5, maxFiles: 0 });
  });
  it('unreadable settings fall back to five minutes and FULL', () => {
    expect(resolve({}, { readFile: () => { throw new Error('unreadable'); } })).toEqual({ minutes: 5, maxFiles: 0 });
  });
  it('cascades standard, platform, tool and tightening environment values', () => {
    expect(resolve({ delta: { maxFiles: 4 } }, { platform: { debounce: { minutes: 2 }, delta: { maxFiles: 3 } },
      env: { WE_AUDIT_DELTA_MAX_FILES: '1', WE_AUDIT_DEBOUNCE_MINUTES: '3' } })).toEqual({ minutes: 3, maxFiles: 1 });
    expect(resolve({ delta: { maxFiles: 2 } }, { env: { WE_AUDIT_DELTA_MAX_FILES: '9' } }).maxFiles).toBe(2);
  });
  it.each([{}, null, [], 'invalid'])('malformed delta section %j disables delta', section => {
    expect(resolve({ delta: section }).maxFiles).toBe(0);
  });
  it.each([{}, { nested: 1 }, [], '5', null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'finding 5: raw invalid maxFiles %j disables delta in either layer with fallback warning', maxFiles => {
      for (const layer of ['tool', 'platform']) {
        const log = vi.fn();
        const audit = { delta: { maxFiles } };
        expect(resolve(layer === 'tool' ? audit : {}, {
          platform: layer === 'platform' ? audit : null, log,
        }).maxFiles).toBe(0);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('delta.maxFiles=0 (fallback; 0 means FULL)'));
      }
    });
});

describe('MERGE_PATH_FLOOR contract (DELTA-AUDIT S1)', () => {
  it('exports an immutable floor covering shared protections and every merge-path family', () => {
    const floor = protectedPaths.MERGE_PATH_FLOOR;
    expect(Array.isArray(floor)).toBe(true);
    expect(Object.isFrozen(floor)).toBe(true);
    expect(floor).toEqual(expect.arrayContaining([
      ...protectedPaths.GUARD_FLOOR, ...protectedPaths.REVIEW_AUTH_FLOOR, ...protectedPaths.AUDITOR_FLOOR,
      'scripts/operations/canonical-audit-gate.mjs', 'scripts/operations/prototype-load*',
      'scripts/operations/ruled-weakened-*', 'scripts/operations/fix-ready-record.mjs',
      'scripts/operations/waiver-delta-carry.mjs', 'scripts/operations/open-pr*', 'scripts/pr-land*',
      'scripts/lib/net-diff-fingerprint.mjs', 'scripts/lib/file-class-policy.mjs', '.github/**',
    ]));
    for (const file of ['scripts/operations/prototype-load-io.mjs', 'scripts/operations/ruled-weakened-store.mjs',
      'scripts/operations/open-pr.mjs', 'scripts/pr-land.mjs', '.github/workflows/ci.yml']) {
      expect(matchesSome(file, floor), file).toBe(true);
    }
    expect(matchesSome('docs/a.md', floor)).toBe(false);
  });
});


describe('waived audit real evidence adapters', () => {
  const entry = { ref: 'lane/test', sha: BASE, ruling: 'R12', findings: ['docs/a.md:1 issue'],
    actor: 'operator', quote: 'approved', at: AT };
  const storeFixture = () => {
    const f = adapter();
    f.fs.readFileSync.mockImplementation(path => {
      if (String(path).endsWith('waiver-requests.jsonl')) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return JSON.stringify(entry) + '\n';
    });
    return f;
  };
  it('reads exact-branch waivers from the canonical store and applies withdrawals', () => {
    const f = storeFixture();
    expect(f.deps.readWaivers(entry.ref)).toEqual([entry]);
    expect(f.deps.readWaivers('lane/other')).toEqual([]);
    f.fs.readFileSync.mockImplementation(path => JSON.stringify(String(path).endsWith('waiver-requests.jsonl')
      ? { ref: entry.ref, sha: BASE, ruling: 'WITHDRAWN', at: AT } : entry) + '\n');
    expect(f.deps.readWaivers(entry.ref)).toEqual([]);
  });
  it.each(['ruled-weakened.jsonl', 'waiver-requests.jsonl'])('refuses unreadable %s evidence', file => {
    const f = storeFixture(), read = f.fs.readFileSync.getMockImplementation();
    f.fs.readFileSync.mockImplementation(path => {
      if (String(path).endsWith(file)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return read(path);
    });
    expect(() => f.deps.readWaivers(entry.ref)).toThrow();
  });
  it('refuses a partially corrupt waiver store instead of accepting its valid line', () => {
    const f = storeFixture(), read = f.fs.readFileSync.getMockImplementation();
    f.fs.readFileSync.mockImplementation(path => String(path).endsWith('ruled-weakened.jsonl')
      ? JSON.stringify(entry) + '\ninvalid\n' : read(path));
    expect(() => f.deps.readWaivers(entry.ref)).toThrow();
  });
  it('diff evidence includes submodules and auditor and fingerprint ignore replacement objects', () => {
    const execFileSync = vi.fn(() => Buffer.from(BASE + '\n'));
    const f = adapter(undefined, { execFileSync });
    f.deps.diffFiles(BASE, HEAD);
    expect(f.spawnSync.mock.calls.at(-1)[1]).toContain('--ignore-submodules=none');
    f.deps.runCodex('prompt');
    expect(f.spawnSync.mock.calls.at(-1)[2].env.GIT_NO_REPLACE_OBJECTS).toBe('1');
    f.deps.fingerprint(BASE, HEAD);
    expect(execFileSync).toHaveBeenCalled();
    for (const [, , options] of execFileSync.mock.calls) expect(options.env.GIT_NO_REPLACE_OBJECTS).toBe('1');
  });
  it('pins local merge and diff evidence to bounded Git calls without replacements or external transforms', () => {
    const f = adapter();
    f.spawnSync.mockReturnValue({ status: 0, stdout: '' });
    expect(f.deps.mergesBetween(BASE, HEAD)).toBe(false);
    expect(f.spawnSync.mock.calls.at(-1)[1]).toEqual(['rev-list', '--merges', `${BASE}..${HEAD}`, '--']);
    f.spawnSync.mockReturnValue({ status: 0, stdout: BASE + '\n' });
    expect(f.deps.mergesBetween(BASE, HEAD)).toBe(true);
    expect(f.deps.mergeBaseOf(BASE, HEAD)).toBe(BASE);
    expect(f.spawnSync.mock.calls.at(-1)[1]).toEqual(['merge-base', BASE, HEAD]);
    f.deps.diffFiles(BASE, HEAD); f.deps.isAncestor(BASE, HEAD);
    for (const [, , options] of f.spawnSync.mock.calls) expect(options).toMatchObject({
      env: { GIT_NO_REPLACE_OBJECTS: '1' }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    expect(f.spawnSync.mock.calls[3][1]).toContain('--no-ext-diff');
    expect(f.spawnSync.mock.calls[3][1]).toContain('--no-textconv');
    f.spawnSync.mockReturnValue({ status: 128, stdout: '' });
    expect(() => f.deps.mergesBetween(BASE, HEAD)).toThrow();
    expect(() => f.deps.mergeBaseOf(BASE, HEAD)).toThrow();
  });
});

describe('waived bound policy cascade', () => {
  const resolve = (audit, extra = {}) => resolveWaivedMaxFiles({ readFile: path => String(path).endsWith('codex-audit.json') ? JSON.stringify({ audit }) : '{}',
    env: {}, log: () => {}, ...extra });
  it.each([null, [], 'bad', 1, false])('malformed platform or tool audit %j disables waived carry', audit => {
    expect(resolve({}, { platform: audit })).toBe(0);
    expect(resolve(audit)).toBe(0);
  });
  it.each([{}, { nested: 1 }, [], '5', null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'malformed ordinary maxFiles %j disables waived carry in either layer', maxFiles => {
      const valid = { delta: { waivedCarry: { maxFiles: 15 } } };
      const audit = { delta: { maxFiles, waivedCarry: { maxFiles: 15 } } };
      for (const layer of ['tool', 'platform']) {
        const log = vi.fn();
        expect(resolve(layer === 'tool' ? audit : valid, {
          platform: layer === 'platform' ? audit : undefined, log,
        })).toBe(0);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('0 means FULL; retry full audit or request human review'));
      }
    });
  it('defaults to 0 and logs tool/environment provenance', () => {
    expect(resolve({})).toBe(0);
    const log = vi.fn();
    expect(resolve({ delta: { waivedCarry: { maxFiles: 3 } } }, { log })).toBe(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('maxFiles=3 (tool;'));
    expect(resolve({ delta: { waivedCarry: { maxFiles: 2 } } }, {
      platform: { delta: { waivedCarry: { maxFiles: 3 } } }, env: { WE_AUDIT_DELTA_WAIVED_MAX_FILES: '1' }, log,
    })).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('maxFiles=1 (env (tightened from tool)'));
  });
  it.each([
    {}, { delta: {} }, { delta: { waivedCarry: {} } },
    ...[undefined, '15', 1.5, -1, null, {}, Number.MAX_SAFE_INTEGER + 1].map(maxFiles => ({ delta: { waivedCarry: { maxFiles } } })),
    ...[null, [], '15'].map(waivedCarry => ({ delta: { waivedCarry } })),
  ])('missing or malformed carry bound %j disables reuse in either layer', audit => {
    const valid = { delta: { waivedCarry: { maxFiles: 15 } } };
    for (const layer of ['tool', 'platform']) {
      const log = vi.fn();
      expect(resolve(layer === 'tool' ? audit : valid, {
        platform: layer === 'platform' ? audit : valid, log,
      })).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('0 means FULL; retry full audit or request human review'));
    }
  });
  it('unreadable platform evidence disables reuse', () => {
    expect(resolve({}, { platform: undefined, readFile: path => {
      if (String(path).endsWith('codex-audit.json')) return '{"audit":{}}';
      throw new Error('unreadable');
    } })).toBe(0);
  });
});
