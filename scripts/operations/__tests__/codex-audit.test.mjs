/** @file Hermetic standalone audit contract and real-adapter boundary tests. */
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { CANONICAL_QUESTION, EXHAUSTIVE_INSTRUCTION, QUESTION_HASH, main, findAudit, isAcceptedQuestionHash, resolvePriorQuestionHashes, MAX_PRIOR_WINDOW_MS } from '../codex-audit.mjs';
import { createAuditDeps } from '../codex-audit-io.mjs';
import { parseCards } from '../file-held-cards.mjs';
import { cardLine as renderCardLine } from '../audit-base-repro.mjs';

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
  it('resolves exemption policy through the settings cascade and logs provenance', () => {
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const f = adapter(undefined, { settingsOptions: { env: {}, platform: { releaseStage: 'prod' },
        fileRead: () => JSON.stringify({ audit: { releaseStage: 'prerelease', cards: { requirePayBy: false, requireOnMain: true } } }) } });
      expect(f.deps.preExistingExemptionEnabled()).toBe(false);
      expect(f.deps.auditPolicy()).toEqual({ releaseStage: 'prerelease', requirePayBy: false, requireOnMain: true });
      for (const name of ['preExistingExemptionEnabled', 'releaseStage', 'requirePayBy', 'requireOnMain']) {
        expect(log.mock.calls.flat().join('')).toContain(`audit.${name}=`);
        expect(log.mock.calls.flat().join('')).toMatch(new RegExp(`audit\\.${name}=.* source=`));
      }
    } finally { log.mockRestore(); }
  });
  it.each(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'])('persists and verifies both security lines for %s, including replay', cls => {
    const files = new Map();
    const f = adapter();
    f.fs.readFileSync.mockImplementation(path => files.get(path) ?? '');
    f.fs.appendFileSync.mockImplementation((path, text) => files.set(path, (files.get(path) ?? '') + text));
    const input = { key: `x.mjs|X|${cls}`, cardLine: `held ${cls}`, expedite: true, needsYou: true };
    expect(f.deps.fileCard(input)).toEqual({ written: true, expedite: true, needsYou: true });
    const held = [...files.values()].find(text => text.startsWith(`held ${cls}`));
    expect(held).toContain(`[needs-you]`);
    expect(held).toContain(`security pre-existing (${cls}) x.mjs|X|${cls}`);
    const count = f.fs.appendFileSync.mock.calls.length;
    expect(f.deps.fileCard(input)).toEqual({ written: true, expedite: true, needsYou: true });
    expect(f.fs.appendFileSync).toHaveBeenCalledTimes(count);
    for (const patch of [{ expedite: false }, { needsYou: false }]) {
      expect(() => f.deps.fileCard({ ...input, ...patch })).toThrow('security escalation required');
    }
  });
  it('cannot confirm security when the needs-you line was not persisted', () => {
    const files = new Map(), f = adapter();
    f.fs.readFileSync.mockImplementation(path => files.get(path) ?? '');
    f.fs.appendFileSync.mockImplementation((path, text) => files.set(path,
      (files.get(path) ?? '') + text.split('\n').filter(line => !line.includes('[needs-you]')).join('\n')));
    expect(() => f.deps.fileCard({ key: 'x.mjs|X|B2', cardLine: 'held', expedite: true, needsYou: true }))
      .toThrow('card persistence verification failed');
  });
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


describe('R1053 prove mode', () => {
  const source = 'function X() {\n  return unsafeValue;\n}\nfunction Y() {\n  return changedValue;\n}';
  const finding = 'x.mjs:2 unsafe return';
  const reply = (cls = 'B2', status = 'REPRODUCES', relation = 'SAME') => `#1 ${status} ${relation} CLASS=${cls} BASE=x.mjs:2\nQUOTE: return unsafeValue;`;
  function proof(answer = reply()) {
    const f = fixture(`WEAKENED\n${finding}`);
    Object.assign(f.deps, { auditPolicy: () => ({ releaseStage: 'prerelease', requirePayBy: false, requireOnMain: false }),
      preExistingExemptionEnabled: () => true, preExistingMode: () => 'prove', baseRecheckMax: () => 6, protectedPaths: () => [],
      reproOnBase: vi.fn(async () => answer), readBaseFile: () => source, readHeadFile: () => source,
      diffText: () => 'diff --git a/x.mjs b/x.mjs\n--- a/x.mjs\n+++ b/x.mjs\n@@ -5 +5 @@\n-  return oldValue;\n+  return changedValue;\n',
      numstatText: () => '1\t1\tx.mjs\n', fileCard: vi.fn(({ expedite }) => expedite ? { written: true, expedite: true, needsYou: true } : true) });
    return f;
  }
  it.each(['\u2028', '\u2029', '\r', '\r\n', '\n'])('refuses to append an exemption with a contradictory verdict after separator %j', async separator => {
    const f = proof();
    f.deps.runCodex = () => `WEAKENED\n${finding}${separator}\u200bＷＥＡＫＥＮＥＤ`;
    expect(await main([...ARGS, '--json'], f.deps)).toBe(1);
    expect(JSON.parse(f.output.join(''))).toMatchObject({ verdict: 'WEAKENED', preExisting: [] });
    expect(f.deps.appendRecord).not.toHaveBeenCalled();
    expect(f.errors.join('')).toContain('contradictory');
  });
  it.each([undefined, false, 'true'])('disabled or missing exemption %j retains all findings and records shadow evidence', async enabled => {
    const f = proof();
    if (enabled === undefined) delete f.deps.preExistingExemptionEnabled;
    else f.deps.preExistingExemptionEnabled = () => enabled;
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.records[0]).toMatchObject({ verdict: 'WEAKENED', modelVerdict: 'WEAKENED', findings: [finding],
      findingKeys: ['x.mjs|X|B2'], preExisting: [], shadowPreExisting: [{ line: finding, key: 'x.mjs|X|B2', relation: 'SAME' }] });
    expect(f.deps.fileCard).toHaveBeenCalledOnce();
  });
  it.each([
    ['2026-11-18T17:00:00.000Z', '2026-11-18 12:00'],
    ['2026-11-18T05:00:00.000Z', '2026-11-18 00:00'],
    ['2026-11-18T00:04:59.000Z', '2026-11-17 19:04'],
    ['2026-03-08T06:59:59.000Z', '2026-03-08 01:59'],
    ['2026-03-08T07:00:00.000Z', '2026-03-08 03:00'],
    ['2026-11-01T05:59:59.000Z', '2026-11-01 01:59'],
    ['2026-11-01T06:00:00.000Z', '2026-11-01 01:00'],
  ])('round-trips the real audit card through held-card parsing at %s', async (now, date) => {
    const f = proof();
    f.deps.now = () => now;
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(f.deps.fileCard).toHaveBeenCalledOnce();
    const { cardLine } = f.deps.fileCard.mock.calls[0][0];
    const text = `pre-existing audit finding (B2) in we:x.mjs#X, reproduces on main ${BASE.slice(0, 10)}: we:${finding}`;
    expect(cardLine).toBe(`- [R1053] ${date} ET: ${text}`);
    const cards = parseCards(cardLine);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ raw: cardLine, tag: 'R1053', date: date.slice(0, 10), text });
  });
  it.each(['\u2028', '\u2029', '\r', '\r\n', '\n'])('round-trips serialized card separators %j', separator => {
    const card = renderCardLine({ date: '2026-11-18 12:00', cls: 'E2', path: 'x.mjs', symbol: 'X',
      sha10: BASE.slice(0, 10), text: `${finding}${separator}see the probe` });
    expect(card).not.toMatch(/[\r\n\u2028\u2029]/);
    const cards = parseCards(card);
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toContain(`we:${finding} see the probe`);
  });
  it.each(['\u2028', '\u2029'])('serializes a fileable card with separator %j', async separator => {
    const f = proof(reply('E2'));
    const text = `${finding}${separator}see the probe`;
    f.deps.runCodex = () => `WEAKENED\n${text}`;
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(f.deps.fileCard).toHaveBeenCalledOnce();
    const { cardLine } = f.deps.fileCard.mock.calls[0][0];
    expect(cardLine).not.toMatch(/[\r\n\u2028\u2029]/);
    const cards = parseCards(cardLine);
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toContain(`we:${finding} see the probe`);
    expect(f.records[0]).toMatchObject({ verdict: 'NOT WEAKENED', preExisting: [{ line: text }] });
  });
  it.each(['function serve(req = defaultRequest()) {', 'function serve(req): Response {'])
    ('retains SAME evidence when an unrecognized function has a changed guard: %s', async declaration => {
      const f = proof('#1 REPRODUCES SAME CLASS=B2 BASE=x.mjs:9\nQUOTE: return unsafeResponse(req);');
      const base = [declaration, '  requireAuth(req);', ...Array.from({ length: 6 }, (_, i) => `  const v${i} = ${i};`),
        '  return unsafeResponse(req);', '}'].join('\n');
      const text = 'x.mjs:9 unsafe response';
      f.deps.runCodex = () => `WEAKENED\n${text}`;
      f.deps.readBaseFile = () => base;
      f.deps.readHeadFile = () => base.replace('requireAuth', 'skipAuth');
      f.deps.diffText = () => 'diff --git a/x.mjs b/x.mjs\n--- a/x.mjs\n+++ b/x.mjs\n@@ -2 +2 @@\n-  requireAuth(req);\n+  skipAuth(req);\n';
      expect(await main(ARGS, f.deps)).toBe(1);
      expect(f.records[0]).toMatchObject({ verdict: 'WEAKENED', findings: [text], preExisting: [] });
      expect(f.deps.fileCard).not.toHaveBeenCalled();
    });
  it.each(['E1', 'E2'])('production policy blocks %s before filing', async cls => {
    const f = proof(reply(cls));
    f.deps.auditPolicy = () => ({ releaseStage: 'prod', requirePayBy: false, requireOnMain: true });
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.deps.fileCard).not.toHaveBeenCalled();
  });
  it('missing policy dep blocks every finding and names human review', async () => {
    const f = proof(); delete f.deps.auditPolicy;
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.records[0]).toMatchObject({ findings: [finding], preExisting: [] });
    expect(f.deps.fileCard).not.toHaveBeenCalled();
    expect(f.errors.join('')).toContain('human review');
  });
  it('required pay-by ignores model dates and clears only with a valid persisted card', async () => {
    for (const body of [null, '', 'mustPayBefore: 2099-02-31', 'mustPayBefore: 2099-01-01']) {
      const f = proof(reply('D2'));
      f.deps.auditPolicy = () => ({ releaseStage: 'prerelease', requirePayBy: true, requireOnMain: true });
      f.deps.runCodex = () => `WEAKENED\n${finding} backlog/debt.md mustPayBefore: 2099-01-01`;
      f.deps.readCard = vi.fn(() => body);
      expect(await main(ARGS, f.deps)).toBe(body === 'mustPayBefore: 2099-01-01' ? 0 : 1);
      expect(f.deps.readCard).toHaveBeenCalledWith('backlog/debt.md');
    }
  });
  it('requireOnMain refuses D2 without a main card despite held-card confirmation', async () => {
    const f = proof(reply('D2'));
    f.deps.auditPolicy = () => ({ releaseStage: 'prerelease', requirePayBy: false, requireOnMain: true });
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.deps.fileCard).not.toHaveBeenCalled();
  });
  it.each(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'])('%s clears only with expedite and needs-you confirmed', async cls => {
    for (const confirmed of [true, false]) {
      const f = proof(reply(cls));
      f.deps.fileCard = vi.fn(() => ({ written: true, expedite: true, needsYou: confirmed }));
      expect(await main(ARGS, f.deps)).toBe(confirmed ? 0 : 1);
      expect(f.deps.fileCard).toHaveBeenCalledWith(expect.objectContaining({ expedite: true, needsYou: true }));
    }
  });
  it('the repro prompt names the head and the diff range', async () => {
    const f = proof();
    await main(ARGS, f.deps);
    expect(f.deps.reproOnBase.mock.calls[0][0]).toMatch(/Compare with head [0-9a-f]{40}: read git diff [0-9a-f]{40}\.\.\.[0-9a-f]{40}/);
  });
  it('a1 clears X while only Y changes and confirms exactly one card before recording', async () => {
    const f = proof();
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(f.records[0]).toMatchObject({ modelVerdict: 'WEAKENED', verdict: 'NOT WEAKENED', findings: [],
      preExisting: [{ line: finding, key: 'x.mjs|X|B2', relation: 'SAME' }] });
    expect(f.deps.fileCard).toHaveBeenCalledTimes(1);
    expect(f.output.join('')).toBe('NOT WEAKENED\n');
  });
  it('a2 blocks a changed flagged line and records its head symbol key', async () => {
    const f = proof();
    f.deps.diffText = () => 'diff --git a/x.mjs b/x.mjs\n--- a/x.mjs\n+++ b/x.mjs\n@@ -2 +2 @@\n-oldValue\n+unsafeValue\n';
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.records[0].findingKeys).toEqual(['x.mjs|X|B2']);
    expect(f.deps.fileCard).not.toHaveBeenCalled();
  });
  it.each(['UNDETERMINED', 'malformed', 'missing', 'quote absent', 'timeout', 'card throws', 'missing dep', 'numstat absent', 'read throws', 'card unconfirmed'])(
    'a3 fails closed: %s', async kind => {
      const f = proof();
      if (kind === 'UNDETERMINED') f.deps.reproOnBase = () => reply('B2', kind);
      if (kind === 'malformed') f.deps.reproOnBase = () => 'bad';
      if (kind === 'missing') f.deps.reproOnBase = () => '';
      if (kind === 'quote absent') f.deps.readBaseFile = () => 'other source';
      if (kind === 'timeout') f.deps.reproOnBase = () => { throw Error('timeout'); };
      if (kind === 'card throws') f.deps.fileCard = () => { throw Error('disk'); };
      if (kind === 'missing dep') delete f.deps.fileCard;
      if (kind === 'numstat absent') f.deps.numstatText = () => '';
      if (kind === 'read throws') f.deps.readHeadFile = () => { throw Error('missing'); };
      if (kind === 'card unconfirmed') f.deps.fileCard = () => false;
      expect(await main(ARGS, f.deps)).toBe(1);
      expect(f.records[0]).toMatchObject({ verdict: 'WEAKENED', findings: [finding], preExisting: [] });
    });
  it.each([['ABSENT', 'SAME'], ['REPRODUCES', 'WORSENED']])('a4 security %s %s blocks', async (status, relation) => {
    const f = proof(reply('B1', status, relation));
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.deps.fileCard).not.toHaveBeenCalled();
  });
  it('a4 SAME security expedites a card and needs-you', async () => {
    const f = proof(reply('B1'));
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(f.deps.fileCard).toHaveBeenCalledWith(expect.objectContaining({ expedite: true, needsYou: true }));
  });
  it('a5 findings beyond the bound block for human review', async () => {
    const f = proof(reply() + '\n' + reply().replace('#1', '#2'));
    f.deps.runCodex = () => `WEAKENED\n${finding}\n${finding}`;
    f.deps.baseRecheckMax = () => 1;
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.records[0].findings).toEqual([finding]);
    expect(f.records[0].preExisting).toHaveLength(1);
  });
  it('disabled exemption retains both exemptible and blocking findings', async () => {
    const f = proof(reply() + '\n' + reply().replace('#1', '#2'));
    f.deps.runCodex = () => `WEAKENED\n${finding}\n${finding}`;
    f.deps.baseRecheckMax = () => 1;
    f.deps.preExistingExemptionEnabled = () => false;
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.records[0]).toMatchObject({ verdict: 'WEAKENED', findings: [finding, finding], preExisting: [] });
    expect(f.records[0].shadowPreExisting).toHaveLength(1);
  });
  it('a6 block mode preserves captured stdout and record bytes', async () => {
    const golden = JSON.parse(realFs.readFileSync(new NodeURL('./fixtures/codex-audit-block.json', import.meta.url), 'utf8'));
    const f = proof(); f.deps.preExistingMode = () => 'block';
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.output.join('')).toBe(golden.stdout);
    expect(JSON.stringify(f.records[0]) + '\n').toBe(golden.record);
    expect(f.deps.reproOnBase).not.toHaveBeenCalled();
  });
});
