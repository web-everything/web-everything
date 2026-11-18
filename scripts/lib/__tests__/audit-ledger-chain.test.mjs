import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendChained, buildGenesis, newId, sha256Line } from '../audit-ledger-chain.mjs';
import { createGenesisRunner } from '../../operations/audit-ledger-genesis.mjs';

let root, path;
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'ledger-chain-')); path = join(root, 'ledger.jsonl'); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const records = () => fs.readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const hash = raw => createHash('sha256').update(raw).digest('hex');
const genesis = () => appendChained(path, { kind: 'genesis' });

describe('audit ledger chain', () => {
  it('generates 128-bit hex ids and hashes raw line bytes', () => {
    expect(newId()).toMatch(/^[a-f0-9]{32}$/);
    expect(sha256Line(' raw\r')).toBe(hash(' raw\r'));
  });
  it('keeps pre-genesis appends unchained, even with legacy numeric seq', async () => {
    fs.writeFileSync(path, '{"seq":999}\n');
    await appendChained(path, { verdict: 'WEAKENED', id: 'old', seq: 90, prev: 'bad' });
    expect(records()[1]).toEqual({ verdict: 'WEAKENED' });
    await genesis();
    await appendChained(path, { verdict: 'NOT WEAKENED' });
    expect(records().at(-1).seq).toBe(1);
  });
  it('refuses to append after a truncation below the high-water mark', async () => {
    await genesis();
    for (let i = 0; i < 4; i++) await appendChained(path, { verdict: 'WEAKENED', n: i });
    const hwm = join(root, 'audits.hwm.json');
    expect(JSON.parse(fs.readFileSync(hwm, 'utf8'))).toMatchObject({ seq: 4, lineHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const kept = fs.readFileSync(path, 'utf8').split('\n').slice(0, 2).join('\n') + '\n';
    fs.writeFileSync(path, kept);
    const before = fs.readFileSync(path);
    await expect(appendChained(path, { verdict: 'NOT WEAKENED' })).rejects.toThrow(/rollback/);
    expect(fs.readFileSync(path)).toEqual(before);
    expect(fs.existsSync(`${path}.lock`)).toBe(false);
  });
  it('refuses when the line at the high-water seq was rewritten', async () => {
    await genesis();
    await appendChained(path, { verdict: 'WEAKENED' });
    await appendChained(path, { verdict: 'WEAKENED' });
    const lines = fs.readFileSync(path, 'utf8').trim().split('\n');
    lines[2] = JSON.stringify({ ...JSON.parse(lines[2]), verdict: 'NOT WEAKENED' });
    fs.writeFileSync(path, `${lines.join('\n')}\n`);
    await expect(appendChained(path, { verdict: 'NOT WEAKENED' })).rejects.toThrow(/rollback/);
  });
  it('refuses when an earlier record or a legacy byte was rewritten', async () => {
    fs.writeFileSync(path, '{"legacy":1}\n');
    await genesis();
    await appendChained(path, { verdict: 'WEAKENED' });
    await appendChained(path, { verdict: 'WEAKENED' });
    const good = fs.readFileSync(path, 'utf8');
    const lines = good.trim().split('\n');
    lines[2] = JSON.stringify({ ...JSON.parse(lines[2]), verdict: 'NOT WEAKENED' });
    fs.writeFileSync(path, `${lines.join('\n')}\n`);
    await expect(appendChained(path, { verdict: 'x' })).rejects.toThrow(/rollback/);
    fs.writeFileSync(path, good.replace('"legacy":1', '"legacy":2'));
    await expect(appendChained(path, { verdict: 'x' })).rejects.toThrow(/rollback/);
  });
  it('refuses when the high-water file is deleted after genesis', async () => {
    await genesis();
    await appendChained(path, { verdict: 'WEAKENED' });
    fs.rmSync(join(root, 'audits.hwm.json'));
    fs.writeFileSync(path, fs.readFileSync(path, 'utf8').split('\n')[0] + '\n');
    await expect(appendChained(path, { verdict: 'x' })).rejects.toThrow(/missing after genesis/);
  });
  it('hashes all original legacy bytes and the last nonempty raw line', async () => {
    const raw = Buffer.from(' {"old":1}\r\n\nnot-json\n\n');
    fs.writeFileSync(path, raw);
    const built = buildGenesis(raw);
    expect(built).toMatchObject({ kind: 'genesis', seq: 0, legacyCount: 2,
      legacyDigest: hash(raw), prev: hash('not-json'), id: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect(Number.isFinite(Date.parse(built.at))).toBe(true);
    await genesis();
    const before = fs.readFileSync(path);
    expect(buildGenesis(before)).toBeNull();
    expect(await genesis()).toBeNull();
    expect(fs.readFileSync(path)).toEqual(before);
  });
  it('handles an empty ledger and an unterminated legacy line', async () => {
    expect(buildGenesis(Buffer.alloc(0))).toMatchObject({ legacyCount: 0, legacyDigest: hash(''), prev: null });
    fs.writeFileSync(path, '{"old":1}');
    await genesis();
    expect(records()).toHaveLength(2);
    expect(records()[1].legacyDigest).toBe(hash('{"old":1}\n'));
    await appendChained(path, { verdict: 'WEAKENED' });
    const lines = fs.readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(JSON.parse(lines[2])).toMatchObject({ seq: 1, prev: hash(lines[1]) });
  });
  it.each(['broken', '{"legacy":true}', '{"verdict":"NOT WEAKENED","seq":7}'])('skips a stale-writer line %s between chained lines without wedging', async stale => {
    fs.writeFileSync(path, '{"seq":900}\n');
    await genesis();
    await appendChained(path, { verdict: 'WEAKENED' });
    fs.appendFileSync(path, `${stale}\n\n`);
    await appendChained(path, { verdict: 'WEAKENED' });
    const lines = fs.readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(JSON.parse(lines.at(-1))).toMatchObject({ seq: 2, prev: hash(lines[2]) });
    await appendChained(path, { verdict: 'WEAKENED' });
  });
  it('quarantines the record and reseal recovers after tampering', async () => {
    await genesis();
    await appendChained(path, { verdict: 'WEAKENED' });
    fs.writeFileSync(path, fs.readFileSync(path, 'utf8').split('\n')[0] + '\n');
    const error = await appendChained(path, { verdict: 'WEAKENED', n: 1 }).catch(e => e);
    expect(error.code).toBe('LEDGER_TAMPER');
    const quarantined = fs.readFileSync(join(root, 'audits.quarantine.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(quarantined[0]).toMatchObject({ verdict: 'WEAKENED', n: 1, quarantineReason: expect.stringContaining('rollback') });
    const sealed = await appendChained(path, { kind: 'genesis', reseal: true, actor: 'orchestrator', reason: 'test' });
    expect(sealed).toMatchObject({ kind: 'genesis', seq: 0, actor: 'orchestrator', reason: 'test' });
    expect(await appendChained(path, { verdict: 'WEAKENED' })).toMatchObject({ seq: 1 });
  });
  it('serializes parallel calls with contiguous seq, unique ids and correct prev hashes', async () => {
    await genesis();
    await Promise.all(Array.from({ length: 12 }, () => appendChained(path, { verdict: 'WEAKENED' })));
    const lines = fs.readFileSync(path, 'utf8').trimEnd().split('\n'), entries = lines.map(JSON.parse);
    expect(entries.map(e => e.seq)).toEqual(Array.from({ length: 13 }, (_, i) => i));
    expect(new Set(entries.map(e => e.id)).size).toBe(13);
    entries.slice(1).forEach((entry, i) => expect(entry.prev).toBe(hash(lines[i])));
    expect(fs.existsSync(`${path}.lock`)).toBe(false);
  });
  it('serializes independent processes, including concurrent genesis requests', async () => {
    const moduleUrl = pathToFileURL(resolve('scripts/lib/audit-ledger-chain.mjs')).href;
    fs.writeFileSync(`${path}.lock`, '');
    fs.utimesSync(`${path}.lock`, 0, 0);
    await Promise.all(Array.from({ length: 6 }, () => new Promise((resolveChild, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        const { appendChained } = await import(process.argv[1]);
        await appendChained(process.argv[2], { kind: 'genesis' });
        await appendChained(process.argv[2], { verdict: 'WEAKENED' });
      `, moduleUrl, path], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolveChild() : reject(new Error(`writer exited ${code}`)));
    })));
    const entries = records();
    expect(entries.filter(e => e.kind === 'genesis')).toHaveLength(1);
    expect(entries.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(new Set(entries.map(e => e.id)).size).toBe(7);
    const lines = fs.readFileSync(path, 'utf8').trimEnd().split('\n');
    entries.slice(1).forEach((entry, i) => expect(entry.prev).toBe(hash(lines[i])));
  });
  it.each(['readFileSync', 'writeFileSync', 'appendFileSync', 'fsyncSync'])('releases lock when %s fails', async method => {
    const injected = { ...fs, [method]: () => { throw new Error('IO failure'); } };
    await expect(appendChained(path, {}, { fs: injected })).rejects.toThrow('IO failure');
    expect(fs.existsSync(`${path}.lock`)).toBe(false);
    expect(fs.existsSync(`${path}.lock.reap`)).toBe(false);
    await appendChained(path, {});
  });
  it('ignores an unchained maximum-seq line and releases the lock', async () => {
    await genesis();
    fs.appendFileSync(path, `${JSON.stringify({ seq: Number.MAX_SAFE_INTEGER })}\n`);
    expect(await appendChained(path, {})).toMatchObject({ seq: 1 });
    expect(fs.existsSync(`${path}.lock`)).toBe(false);
  });
  it('reclaims an abandoned stale lock', async () => {
    fs.writeFileSync(`${path}.lock`, '');
    fs.utimesSync(`${path}.lock`, 0, 0);
    await appendChained(path, {}, { sleep: async () => {} });
    expect(records()).toEqual([{}]);
    expect(fs.existsSync(`${path}.lock`)).toBe(false);
  });
  it('blocks replacement acquisition between the stale check and empty PID read', async () => {
    await genesis();
    const lock = `${path}.lock`;
    fs.writeFileSync(lock, '');
    fs.utimesSync(lock, 0, 0);
    let resume, replacement, started = false;
    const paused = new Promise(resolvePause => { resume = resolvePause; });
    const writePid = vi.fn((...args) => fs.writeFileSync(...args));
    const injected = { ...fs, readFileSync(file, ...args) {
      if (file !== lock || started) return fs.readFileSync(file, ...args);
      started = true;
      // Previous owner releases after the stale check. The replacement tries to
      // acquire before reclamation reads a PID, exactly the reviewed interleaving.
      fs.unlinkSync(lock);
      replacement = appendChained(path, { writer: 'replacement' }, {
        fs: { ...fs, writeFileSync: writePid }, sleep: () => paused,
      });
      return '';
    } };
    try {
      await appendChained(path, { writer: 'reclaimer' }, { fs: injected });
      expect(started).toBe(true);
      expect(writePid).not.toHaveBeenCalled();
      expect(records().map(entry => entry.seq)).toEqual([0, 1]);
    } finally { resume(); await replacement; }
    const entries = records(), lines = fs.readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(entries.slice(1).map(entry => entry.writer)).toEqual(['reclaimer', 'replacement']);
    expect(entries.map(entry => entry.seq)).toEqual([0, 1, 2]);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(3);
    entries.slice(1).forEach((entry, i) => expect(entry.prev).toBe(hash(lines[i])));
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.existsSync(`${lock}.reap`)).toBe(false);
  });
  it('fails closed with operator repair when the coordination mutex is abandoned', async () => {
    const coordinator = `${path}.lock.reap`;
    fs.writeFileSync(coordinator, '');
    fs.utimesSync(coordinator, 0, 0);
    const sleep = vi.fn(async () => {});
    await expect(appendChained(path, {}, { sleep })).rejects.toThrow('abandoned coordinators require operator repair');
    expect(sleep).toHaveBeenCalledTimes(40);
    expect(fs.readdirSync(root)).toEqual(['ledger.jsonl.lock.reap']);
  });
  it.each([false, true])('bounds contention and provides an operator fallback (stale=%s)', async stale => {
    fs.writeFileSync(`${path}.lock`, String(process.pid));
    if (stale) fs.utimesSync(`${path}.lock`, 0, 0);
    const sleep = vi.fn(async () => {});
    await expect(appendChained(path, {}, { sleep })).rejects.toThrow('retry later or inspect the lock owner');
    expect(sleep).toHaveBeenCalledTimes(40);
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.readFileSync(`${path}.lock`, 'utf8')).toBe(String(process.pid));
  });
  it('dry run defaults to no writes and apply is idempotent', async () => {
    const migrate = createGenesisRunner({ path });
    expect(await migrate()).toMatchObject({ legacyCount: 0, legacyDigest: hash(''), genesisExists: false, wouldAppend: true, applied: false });
    expect(fs.readdirSync(root)).toEqual([]);
    expect(await migrate({ apply: true })).toMatchObject({ applied: true });
    const bytes = fs.readFileSync(path);
    expect(await migrate({ apply: true })).toMatchObject({ genesisExists: true, wouldAppend: false, applied: false });
    expect(fs.readFileSync(path)).toEqual(bytes);
  });
});
