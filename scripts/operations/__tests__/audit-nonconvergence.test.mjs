import { it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { assessLineage, findingKeysOf, lineageRounds, NONCONVERGENCE_SIGNATURE } from '../audit-nonconvergence.mjs';
import { main, QUESTION_HASH } from '../codex-audit.mjs';
import { createAuditDeps } from '../codex-audit-io.mjs';

const ref = 'lane/audit', head = 'c'.repeat(40);
const round = (letter, cls = 'B1', verdict = 'WEAKENED') => ({ head: letter.repeat(40), verdict,
  findings: verdict === 'WEAKENED' ? [`src/a.mjs:12 ${cls} missing guard`] : [], ref, questionHash: QUESTION_HASH });
const prior = [round('a'), round('b', 'E1')];
function fixture(verdict = 'WEAKENED') {
  const deps = { resolveSha: name => name === 'main' ? 'f'.repeat(40) : head,
    runCodex: () => verdict === 'WEAKENED' ? `${verdict}\nsrc/a.mjs:12 D1 missing check` : verdict, readRecords: () => prior,
    findBranch: () => ref, appendRecord: vi.fn(), escalate: vi.fn(), now: () => '2026-11-24T00:00:00Z',
    stdout: vi.fn(), stderr: vi.fn() };
  return { deps, run: () => main(['--base=main', `--head=${head}`, '--now'], deps) };
}
function scratch(run) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'audit-nonconvergence-'));
  try { return run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

it('a historical NOT WEAKENED commentary resets the streak without reserving finding keys', () => {
  const note = { ...round('b', 'B1', 'NOT WEAKENED'), findings: round('c', 'D1').findings };
  expect(assessLineage([round('a'), note])).toMatchObject({ streak: 0, escalate: false });
  expect(assessLineage([round('a'), note, round('c', 'D1')])).toMatchObject({ streak: 1, escalate: false });
});

it.each(['WEAKENED', ' \tWEAKENED\t ', '\x1b[31mWEAKENED\x1b[0m', 'ＷＥＡＫＥＮＥＤ',
  'WEAK\u200bENED', 'WEAK\rENED', 'notes\u2028WEAKENED', 'notes\u2029WEAKENED'])
('historical contradictory commentary remains unreadable: %j', text => {
  const record = { ...round('a', 'B1', 'NOT WEAKENED'), findings: [text] };
  expect(assessLineage([record])).toMatchObject({ escalate: true, reason: 'unreadable-lineage' });
});

it('unclassified same-file findings use the first three description words', () => {
  const descriptions = ['missing authorization check before save', 'removed input validation before save', 'disabled output escaping before render'];
  const rounds = descriptions.map((text, index) => ({ ...round('abc'[index]), findings: [`src/a.mjs:12 - ${text}`] }));
  const keys = rounds.map(record => findingKeysOf(record.findings)[0]);
  expect(new Set(keys).size).toBe(3);
  expect(findingKeysOf(['src/a.mjs:99 - missing authorization check after rename'])).toEqual([keys[0]]);
  expect(assessLineage(rounds)).toMatchObject({ streak: 3, escalate: true });
});

it.each(['ref', 'routing error'])('sanitises user-controlled %s in nonconvergence stderr', async field => {
  const { deps, run } = fixture();
  const unsafe = 'lane/audit\n\r\u2028\u2029\x1b[31m\x00';
  if (field === 'ref') {
    deps.findBranch = () => unsafe;
    deps.readRecords = () => prior.map(record => ({ ...record, ref: unsafe }));
  } else deps.escalate.mockRejectedValue(new Error(unsafe));
  expect(await run()).toBe(1);
  expect(deps.stderr.mock.calls.length).toBe(field === 'ref' ? 1 : 2);
  for (const [line] of deps.stderr.mock.calls) {
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/[\x00-\x1f\x7f\u2028\u2029]/);
  }
  expect(deps.stderr.mock.calls[0][0]).toContain('ref=lane/audit');
});

it('the real adapter creates the first ledger on an empty home without escalation', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'audit-first-ledger-'));
  try {
    const injectedFs = { ...fs, readFileSync: (path, encoding) => String(path).endsWith('prototype-load.json')
      ? JSON.stringify({ auditRecordPath: '~/audits.jsonl' }) : fs.readFileSync(path, encoding) };
    const deps = createAuditDeps({ cwd: dir, home: dir, fs: injectedFs });
    Object.assign(deps, { resolveSha: name => name === 'main' ? 'f'.repeat(40) : head,
      runCodex: () => 'NOT WEAKENED', findBranch: () => ref, fingerprint: () => null,
      stdout: vi.fn(), stderr: vi.fn() });
    expect(await main(['--base=main', `--head=${head}`, '--now'], deps)).toBe(0);
    expect(deps.readRecords()).toEqual([expect.objectContaining({ verdict: 'NOT WEAKENED', ref })]);
    expect(deps.stderr).not.toHaveBeenCalled();
    expect(fs.existsSync(join(dir, 'audit-nonconvergence.jsonl'))).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it.each(['EACCES', 'malformed'])('the real adapter keeps %s ledger failures closed', async failure => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'audit-bad-ledger-'));
  try {
    const ledger = join(dir, 'audits.jsonl');
    fs.writeFileSync(ledger, 'not json\n');
    const injectedFs = { ...fs, readFileSync: (path, encoding) => {
      if (String(path).endsWith('prototype-load.json')) return JSON.stringify({ auditRecordPath: ledger });
      if (path === ledger && failure === 'EACCES') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.readFileSync(path, encoding);
    } };
    const deps = createAuditDeps({ cwd: dir, home: dir, fs: injectedFs });
    Object.assign(deps, { resolveSha: name => name === 'main' ? 'f'.repeat(40) : head,
      runCodex: () => 'NOT WEAKENED', findBranch: () => ref, fingerprint: () => null,
      stdout: vi.fn(), stderr: vi.fn() });
    expect(await main(['--base=main', `--head=${head}`, '--now'], deps)).toBe(3);
    expect(fs.readFileSync(ledger, 'utf8')).toBe('not json\n');
    expect(deps.stdout).not.toHaveBeenCalled();
    expect(deps.stderr.mock.calls[0][0]).toContain(NONCONVERGENCE_SIGNATURE);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it('a failed queue append releases the lock so a retry can enqueue', () => scratch(dir => {
  const path = join(dir, 'audit-nonconvergence.jsonl');
  let failed = false;
  const injectedFs = { ...fs,
    readFileSync: (file, encoding) => String(file).endsWith('prototype-load.json')
      ? JSON.stringify({ auditRecordPath: join(dir, 'audits.jsonl') }) : fs.readFileSync(file, encoding),
    appendFileSync: (...args) => {
      if (!failed) { failed = true; throw Object.assign(new Error('full'), { code: 'ENOSPC' }); }
      return fs.appendFileSync(...args);
    } };
  const deps = createAuditDeps({ cwd: dir, home: dir, fs: injectedFs });
  const request = { ref, head, streak: 3, questionHash: QUESTION_HASH };
  expect(() => deps.escalate(request)).toThrow('full');
  deps.escalate(request);
  expect(fs.readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse)).toEqual([expect.objectContaining(request)]);
  expect(fs.readdirSync(dir).filter(name => name.includes('ledger-append-'))).toEqual([]);
}));

it('concurrent same-key escalations enqueue exactly one request', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'audit-concurrent-'));
  const gate = new SharedArrayBuffer(4);
  const workers = [];
  const adapterUrl = pathToFileURL(resolve('scripts/operations/codex-audit-io.mjs')).href;
  const start = first => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const { syncBuiltinESMExports } = require('node:module');
      const path = require('node:path');
      const gate = new Int32Array(workerData.gate);
      const rename = fs.renameSync;
      fs.renameSync = (...args) => {
        if (!workerData.first) parentPort.postMessage('contending');
        return rename(...args);
      };
      syncBuiltinESMExports();
      import(workerData.adapterUrl).then(({ createAuditDeps }) => {
        const injectedFs = { ...fs, readFileSync: (file, encoding) => {
          if (String(file).endsWith('prototype-load.json')) return JSON.stringify({ auditRecordPath: path.join(workerData.dir, 'audits.jsonl') });
          let value, error;
          try { value = fs.readFileSync(file, encoding); } catch (e) { error = e; }
          if (String(file).endsWith('audit-nonconvergence.jsonl')) {
            parentPort.postMessage('read');
            if (Atomics.wait(gate, 0, 0, 10000) === 'timed-out') throw new Error('test barrier timed out');
          }
          if (error) throw error;
          return value;
        }};
        createAuditDeps({ cwd: workerData.dir, home: workerData.dir, fs: injectedFs }).escalate(workerData.request);
      }).catch(error => { throw error; });
    `, { eval: true, execArgv: [], workerData: { first, dir, gate, adapterUrl,
      request: { ref, head, streak: 3, questionHash: QUESTION_HASH } } });
    workers.push(worker);
    const done = new Promise((resolve, reject) => { worker.on('error', reject); worker.on('exit', code => code ? reject(new Error(`worker exit ${code}`)) : resolve()); });
    return { worker, done };
  };
  const signal = (worker, names) => new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', message => { if (names.includes(message)) resolve(); });
  });
  try {
    const first = start(true);
    await signal(first.worker, ['read']);
    const second = start(false);
    // With a lock the second writer contends before reading; without it both hold an empty snapshot.
    await signal(second.worker, ['contending', 'read']);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    await Promise.all([first.done, second.done]);
    const records = fs.readFileSync(join(dir, 'audit-nonconvergence.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(records).toEqual([expect.objectContaining({ ref, questionHash: QUESTION_HASH })]);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

it('two consecutive new-class WEAKENED rounds on one ref reach streak 2 and the third head escalates to a design pass', async () => {
  expect(assessLineage(prior)).toMatchObject({ streak: 2, rounds: 2, escalate: false });
  expect(assessLineage([...prior, round('c', 'D1')])).toMatchObject({ streak: 3, rounds: 3, escalate: true });
  const { deps, run } = fixture();
  expect(await run()).toBe(1);
  expect(deps.stderr).toHaveBeenCalledWith(`${NONCONVERGENCE_SIGNATURE} ref=${ref} head=${head} streak=3: stop patching, a design pass is required\n`);
  expect(deps.appendRecord.mock.calls[0][0]).toMatchObject({ ref, nonconverge: { streak: 3, rounds: 3 } });
  expect(deps.escalate).toHaveBeenCalledOnce();
  expect(deps.escalate).toHaveBeenCalledWith({ ref, head, streak: 3, questionHash: QUESTION_HASH });
});

it('a NOT WEAKENED round or a round with no new key resets the streak', () => {
  for (const last of [round('c', 'D1', 'NOT WEAKENED'), round('c', 'B1')]) {
    expect(assessLineage([...prior, last])).toMatchObject({ streak: 0, escalate: false });
    expect(assessLineage([...prior, last, round('d', 'X2')])).toMatchObject({ streak: 1, escalate: false });
  }
  expect(assessLineage([round('a', 'B1', 'NOT WEAKENED'), round('b')]).streak).toBe(1);
});

it('an unreadable lineage fails closed (escalates, never passes)', async () => {
  for (const bad of [null, 'invalid', { ...round('a'), head: 'bad' }, { ...round('a'), head: 123 },
    { ...round('a'), verdict: 'UNKNOWN' }, { ...round('a'), findings: null }, { ...round('a'), findings: [123] },
    { ...round('a'), findings: [] }, { ...round('a'), verdict: 'NOT WEAKENED', findings: ['WEAKENED'] }]) {
    expect(assessLineage([bad])).toEqual({ escalate: true, reason: 'unreadable-lineage', streak: 0, rounds: 1 });
  }
  for (const verdict of ['WEAKENED', 'NOT WEAKENED']) {
    const { deps, run } = fixture(verdict);
    deps.readRecords = () => { throw new Error('unreadable'); };
    expect(await run()).toBe(verdict === 'WEAKENED' ? 1 : 3);
    if (verdict === 'WEAKENED') {
      expect(deps.appendRecord.mock.calls[0][0].nonconverge).toEqual({ streak: 0, rounds: 1, reason: 'unreadable-lineage' });
    } else {
      expect(deps.appendRecord).not.toHaveBeenCalled();
      expect(deps.stdout).not.toHaveBeenCalled();
      expect(deps.stderr.mock.calls[1][0]).toContain('UNPARSEABLE audit (unreadable-lineage)');
    }
    expect(deps.escalate).toHaveBeenCalledOnce();
    expect(deps.stderr.mock.calls[0][0]).toContain(NONCONVERGENCE_SIGNATURE);
  }
});

it('an invalid verdict followed by a valid round for the same head remains unreadable', () => {
  const records = [{ ...round('a'), verdict: 'UNKNOWN' }, round('a')];
  expect(assessLineage(lineageRounds(records, ref, QUESTION_HASH)))
    .toEqual({ escalate: true, reason: 'unreadable-lineage', streak: 0, rounds: 2 });
});

it('a WEAKENED round with empty findings escalates as unreadable', () => {
  expect(assessLineage([{ ...round('a'), findings: [] }]))
    .toMatchObject({ escalate: true, reason: 'unreadable-lineage' });
});

it('escalation never changes the verdict word or exit code', async () => {
  for (const verdict of ['WEAKENED', 'NOT WEAKENED']) {
    const { deps, run } = fixture(verdict);
    deps.escalate.mockRejectedValue(new Error('routing\n\r\u2028\u2029\u001b[31m failed\u0000'));
    expect(await run()).toBe(verdict === 'WEAKENED' ? 1 : 0);
    expect(deps.stdout).toHaveBeenCalledWith(verdict === 'WEAKENED' ? `${verdict}\nsrc/a.mjs:12 D1 missing check\n` : `${verdict}\n`);
    expect(deps.appendRecord.mock.calls[0][0].verdict).toBe(verdict);
    expect(deps.escalate).toHaveBeenCalledTimes(verdict === 'WEAKENED' ? 1 : 0);
    if (verdict === 'WEAKENED') {
      expect(deps.stderr.mock.calls[1][0]).toBe('audit-nonconvergence: design-pass request failed to record (routing failed)\n');
      expect(deps.stderr).toHaveBeenCalledTimes(2);
    }
  }
});

it('a rename-only round (same file and class, different prose) is not new', () => {
  const renamed = { ...round('b'), findings: ['src/a.mjs:99 B1 renamed function from oldName to newName'] };
  expect(assessLineage([round('a'), renamed])).toMatchObject({ streak: 0, newKeys: [], escalate: false });
  expect(findingKeysOf(renamed.findings)).toEqual(['src/a.mjs|<top>|B1']);
});

it('escalate dedupes per ref', () => scratch(dir => {
  const path = join(dir, 'audit-nonconvergence.jsonl');
  const injectedFs = { ...fs, readFileSync: (path, encoding) => String(path).endsWith('prototype-load.json')
    ? JSON.stringify({ auditRecordPath: join(dir, 'audits.jsonl') }) : fs.readFileSync(path, encoding) };
  const makeDeps = () => createAuditDeps({ cwd: dir, home: dir, fs: injectedFs });
  const request = { ref, head, streak: 3, questionHash: QUESTION_HASH };
  makeDeps().escalate(request);
  makeDeps().escalate({ ...request, head: 'd'.repeat(40) });
  makeDeps().escalate({ ...request, ref: 'lane/other' });
  makeDeps().escalate({ ...request, questionHash: 'another-question' });
  const records = fs.readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(records).toHaveLength(3);
  expect(records[0]).toEqual({ ...request, at: expect.any(String), kind: 'design-pass-request' });
  expect(fs.statSync(path).mode & 0o777).toBe(0o600);
}));

it('the replay CLI prints rounds and the signature at round 3', () => scratch(dir => {
  const rounds = [...prior, { ...round('c', 'D1'), ref: 'ignored' }];
  const ledger = join(dir, 'ledger.jsonl');
  fs.writeFileSync(ledger, [...rounds, round('d', 'X2')].map(record => JSON.stringify(record)).join('\n'));
  const output = execFileSync(process.execPath, [resolve('scripts/operations/audit-nonconvergence.mjs'),
    `--replay=${ledger}`, `--heads=${rounds.map(round => round.head).join(',')}`],
  { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
  expect(output.trim().split('\n')).toEqual([
    'round 1 aaaaaaaa WEAKENED newKeys=1 streak=1', 'round 2 bbbbbbbb WEAKENED newKeys=1 streak=2',
    'round 3 cccccccc WEAKENED newKeys=1 streak=3', `${NONCONVERGENCE_SIGNATURE}: stop patching, a design pass is required`,
  ]);
}));

it('keeps raw ledger order and includes only the canonical question hash on this ref', () => {
  const last = round('a', 'X2');
  expect(lineageRounds([...prior, { ...round('d'), ref: 'other' }, { ...round('e'), questionHash: null },
    { ...round('f'), questionHash: 'old-question-hash' }, last], ref, QUESTION_HASH))
    .toEqual([...prior, last]);
  expect(assessLineage([...prior, last])).toMatchObject({ rounds: 2, streak: 2, escalate: false });
  expect(assessLineage([])).toEqual({ streak: 0, rounds: 0, escalate: false, newKeys: [] });
});

it('hashes unlocated or invalid paths and defaults an unclassified finding to X1', () => {
  const hash = createHash('sha256').update('no location here').digest('hex').slice(0, 16);
  expect(findingKeysOf(['  NO  location\nHere  ', 'no location here'])).toEqual([`text|${hash}`, `text|${hash}`]);
  expect(findingKeysOf(['../escape.mjs:1 B1 bad'])[0]).toMatch(/^text\|[a-f0-9]{16}$/);
  expect(findingKeysOf(['src/a.mjs:1 check'])).toEqual(['src/a.mjs|<top>|X1']);
  expect(assessLineage([{ ...round('a'), findings: ['first text'] }, { ...round('b'), findings: ['changed text'] }]).streak).toBe(2);
});

it('records an explicit ref without lookup and tolerates a failed branch lookup', async () => {
  const { deps, run } = fixture();
  deps.findBranch = vi.fn(() => { throw new Error('unavailable'); });
  expect(await main(['--base=main', `--head=${head}`, `--branch=${ref}`, '--now'], deps)).toBe(1);
  expect(deps.findBranch).not.toHaveBeenCalled();
  expect(await run()).toBe(1);
  expect(deps.appendRecord.mock.calls[1][0]).not.toHaveProperty('ref');
});
