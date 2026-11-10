import { afterEach, describe, expect, it, vi } from 'vitest';
import fs, { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReadyRecord, writeReadyRecord, readyRecordPath, adoptionReaderPath, parseArgs, main } from '../fix-ready-record.mjs';
import { createAdoptionMatrixReader } from '../adoption-matrix-io.mjs';
import { jsonLines, readyEvidence } from '../prototype-load.mjs';

const sha = 'b7bb8b2743e5c582d44e22e71a40f9e23ae07f6b';
const ref = 'lane/example';
const base = { ref, sha, tests: 'green' };
const findings = ['a.mjs:1 — one', 'b.mjs:2 — two'];
const tmp = () => join(mkdtempSync(join(tmpdir(), 'fix-ready-')), 'fix-ready.jsonl');

describe('fix-ready-record', () => {
  it('builds NOT WEAKENED and WEAKENED records the reader accepts', () => {
    const ok = buildReadyRecord({ ...base, audit: 'NOT WEAKENED' });
    expect(ok.record).toEqual({ ref, sha, tests: 'green', audit: 'NOT WEAKENED' });
    const w = buildReadyRecord({ ...base, audit: 'WEAKENED', auditRuling: 'R816', auditDisclosed: findings });
    expect(readyEvidence([w.record], { branch: ref, sha }, [{ ref, sha, ruling: 'R816', findings }]).source).toBe('ready-record');
  });
  it.each([
    [{ ...base, sha: 'abc', audit: 'NOT WEAKENED' }, /40-hex/],
    [{ ...base, ref: ' ', audit: 'NOT WEAKENED' }, /ref/],
    [{ ...base, ref: ' lane/x', audit: 'NOT WEAKENED' }, /surrounding whitespace/],
    [{ ...base, ref: 'lane/x\n', audit: 'NOT WEAKENED' }, /surrounding whitespace/],
    [{ ...base, tests: 'red', audit: 'NOT WEAKENED' }, /green/],
    [{ ...base, audit: 'maybe' }, /audit must be/],
    [{ ...base, audit: 'WEAKENED', auditDisclosed: findings }, /auditRuling/],
    [{ ...base, audit: 'WEAKENED', auditRuling: 'x', auditDisclosed: findings }, /auditRuling/],
    [{ ...base, audit: 'WEAKENED', auditRuling: 'R816', auditDisclosed: [] }, /auditDisclosed/],
    [{ ...base, audit: 'WEAKENED', auditRuling: 'R816', auditDisclosed: ['ok', ' '] }, /auditDisclosed/],
    [{ ...base, audit: 'NOT WEAKENED', auditRuling: 'R816' }, /only belong/],
  ])('refuses invalid input %#', (input, message) => {
    const r = buildReadyRecord(input);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(message);
  });
  it('appends one line and refuses a duplicate ref+sha', () => {
    const file = tmp();
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file }).ok).toBe(true);
    const dup = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file });
    expect(dup.ok).toBe(false);
    expect(dup.error).toMatch(/duplicate/);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(writeReadyRecord({ ...base, ref: 'lane/other', audit: 'NOT WEAKENED' }, { file }).ok).toBe(true);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });
  it('reports an unreadable (non-ENOENT) file without any filesystem mutation', () => {
    const calls = [];
    const spy = (name) => (...args) => { calls.push(name); return fs[name](...args); };
    const fsApi = {
      ...fs,
      readFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      mkdirSync: spy('mkdirSync'), openSync: spy('openSync'), writeSync: spy('writeSync'), unlinkSync: spy('unlinkSync'),
    };
    const r = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file: tmp(), fsApi });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot read/);
    expect(calls).toEqual([]);
  });
  it('appends the complete newline-terminated record with exactly one write on an append handle', () => {
    const writes = [];
    const opens = [];
    const fsApi = {
      ...fs,
      openSync: (p, flags) => { opens.push(flags); return fs.openSync(p, flags); },
      writeSync: (fd, data) => { writes.push(data); return fs.writeSync(fd, data); },
    };
    const file = tmp();
    const r = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file, fsApi });
    expect(r.ok).toBe(true);
    expect(writes.map(String)).toEqual([`${JSON.stringify(r.record)}\n`]);
    expect(opens).toContain('a');
    expect(readFileSync(file, 'utf8')).toBe(String(writes[0]));
  });
  it('finishes a short write: keeps writing until the whole record is on disk', () => {
    const file = tmp();
    const fsApi = {
      ...fs,
      // a filesystem that accepts at most 7 bytes per call
      writeSync: (fd, buf, off = 0, len = buf.length - off) => fs.writeSync(fd, buf, off, Math.min(7, len)),
    };
    const r = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file, fsApi });
    expect(r.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify(r.record)}\n`);
  });
  it('refuses and cuts the ledger back when a write fails part-way, leaving no torn line', () => {
    const file = tmp();
    writeFileSync(file, `${JSON.stringify({ ref: 'lane/old', sha, tests: 'green', audit: 'NOT WEAKENED' })}\n`);
    const before = readFileSync(file, 'utf8');
    for (const second of [() => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }, () => 0]) {
      let calls = 0;
      const fsApi = {
        ...fs,
        writeSync: (fd, buf, off = 0, len = buf.length - off) => (calls++ === 0 ? fs.writeSync(fd, buf, off, 5) : second()),
      };
      const r = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file, fsApi });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/write failed|short write/);
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(existsSync(`${file}.lock`)).toBe(false);
    }
  });
  it('keeps both records parseable when the existing file has no trailing newline', () => {
    const file = tmp();
    const first = { ref: 'lane/older', sha: 'a'.repeat(40), tests: 'green', audit: 'NOT WEAKENED' };
    writeFileSync(file, JSON.stringify(first));
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file }).ok).toBe(true);
    const parsed = jsonLines(readFileSync(file, 'utf8'));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(first);
    expect(parsed[1].ref).toBe(ref);
  });
  it('round-trips a write through the reader on an empty-line and CRLF ledger', () => {
    const file = tmp();
    writeFileSync(file, `${JSON.stringify({ ref: 'lane/older', sha: 'a'.repeat(40), tests: 'green', audit: 'NOT WEAKENED' })}\r\n\n`);
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file }).ok).toBe(true);
    expect(jsonLines(readFileSync(file, 'utf8'))).toHaveLength(2);
  });
  it('lets a later, different record supersede an earlier one for the same ref+sha, and refuses only an identical latest', () => {
    const file = tmp();
    expect(writeReadyRecord({ ...base, audit: 'WEAKENED', auditRuling: 'R816', auditDisclosed: findings }, { file }).ok).toBe(true);
    expect(writeReadyRecord({ ...base, audit: 'WEAKENED', auditRuling: 'R816', auditDisclosed: findings }, { file }).error).toMatch(/duplicate/);
    const superseding = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file });
    expect(superseding.ok).toBe(true);
    expect(readyEvidence(jsonLines(readFileSync(file, 'utf8')), { branch: ref, sha }, []).source).toBe('ready-record');
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file }).error).toMatch(/duplicate/);
    // Going back to the earlier state is a real change (the latest record wins), so it is allowed, not a duplicate.
    expect(writeReadyRecord({ ...base, audit: 'WEAKENED', auditRuling: 'R816', auditDisclosed: findings }, { file }).ok).toBe(true);
    expect(jsonLines(readFileSync(file, 'utf8'))).toHaveLength(3);
  });
  it('writes the sha lower-case and refuses a lower-case rewrite of an upper-case sha as a duplicate', () => {
    const file = tmp();
    const upper = sha.toUpperCase();
    const first = writeReadyRecord({ ...base, sha: upper, audit: 'NOT WEAKENED' }, { file });
    expect(first.ok).toBe(true);
    expect(first.record.sha).toBe(sha);
    expect(jsonLines(readFileSync(file, 'utf8'))[0].sha).toBe(sha);
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file }).error).toMatch(/duplicate/);
    expect(writeReadyRecord({ ...base, sha: upper, audit: 'NOT WEAKENED' }, { file }).error).toMatch(/duplicate/);
  });
  it('treats a legacy upper-case sha already in the ledger as the same record', () => {
    const file = tmp();
    writeFileSync(file, `${JSON.stringify({ ref, sha: sha.toUpperCase(), tests: 'green', audit: 'NOT WEAKENED' })}\n`);
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file }).error).toMatch(/duplicate/);
  });
  it('refuses a second concurrent writer: the duplicate check re-reads under the lock', () => {
    const file = tmp();
    let nested = null;
    let reads = 0;
    const fsApi = {
      ...fs,
      // After the first writer's pre-lock read, a second writer runs to completion; the first must then see it.
      // The ledger does not exist yet, so the first read throws ENOENT; the second writer still runs after it.
      readFileSync: (...args) => {
        let out; let failure;
        try { out = fs.readFileSync(...args); } catch (e) { failure = e; }
        if (reads++ === 0) nested = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file });
        if (failure) throw failure;
        return out;
      },
    };
    const r = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file, fsApi });
    expect(nested.ok).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/duplicate/);
    expect(jsonLines(readFileSync(file, 'utf8'))).toHaveLength(1);
    // The duplicate was found only on the re-read under the lock, and the lock was released on that path.
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
  it('does not delete a lock another writer took over while this one was writing', () => {
    const file = tmp();
    const fsApi = {
      ...fs,
      openSync: (p, flags) => {
        if (flags === 'a') writeFileSync(`${file}.lock`, 'another-writers-token'); // our lock was taken over mid-write
        return fs.openSync(p, flags);
      },
    };
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file, fsApi }).ok).toBe(true);
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe('another-writers-token');
  });
  it('does not take a fresh lock that a stale-lock check raced with, and leaves no moved-aside file', () => {
    const file = tmp();
    const lock = `${file}.lock`;
    writeFileSync(lock, 'holder');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    let statCalls = 0;
    const fsApi = {
      ...fs,
      // The first stat sees a stale lock; by the time it is moved aside, a fresh one has replaced it.
      statSync: (p) => {
        const st = fs.statSync(p);
        if (statCalls++ === 0) { const now = new Date(); utimesSync(p, now, now); return { ...st, mtimeMs: old.getTime() }; }
        return st;
      },
    };
    const r = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file, fsApi });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/locked/);
    expect(readFileSync(lock, 'utf8')).toBe('holder');
    expect(existsSync(file)).toBe(false);
    expect(fs.readdirSync(join(file, '..')).filter((n) => n.includes('.stale-'))).toEqual([]);
  });
  it('ignores a ledger line the reader would ignore (non-string sha) when deciding a duplicate', () => {
    const file = tmp();
    writeFileSync(file, `${JSON.stringify({ ref, sha: [sha], tests: 'green', audit: 'NOT WEAKENED' })}\n`);
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file }).ok).toBe(true);
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file }).error).toMatch(/duplicate/);
  });
  it('refuses while another writer holds a fresh lock, and takes over a stale lock', () => {
    const file = tmp();
    const lock = `${file}.lock`;
    writeFileSync(lock, '');
    const busy = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file });
    expect(busy.ok).toBe(false);
    expect(busy.error).toMatch(/locked/);
    expect(existsSync(file)).toBe(false);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file }).ok).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
  it('releases the lock after a successful write', () => {
    const file = tmp();
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file }).ok).toBe(true);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
  it('passes a NOT WEAKENED record through the reader as ready-record', () => {
    const r = buildReadyRecord({ ...base, audit: 'NOT WEAKENED' });
    expect(readyEvidence([r.record], { branch: ref, sha }, []).source).toBe('ready-record');
  });
  it('resolves the reader path with ~ expanded against HOME and parses args', () => {
    const settingsFile = join(mkdtempSync(join(tmpdir(), 'fix-ready-s-')), 'p.json');
    writeFileSync(settingsFile, JSON.stringify({ readyRecordPath: '~/x/fix-ready.jsonl' }));
    expect(readyRecordPath({ env: { HOME: '/h' }, settingsFile })).toBe('/h/x/fix-ready.jsonl');
    expect(readyRecordPath({ env: { HOME: '/h' } })).toMatch(/\/h\/.*fix-ready\.jsonl$/);
    expect(parseArgs(['--ref=a', '--audit=NOT-WEAKENED'])).toEqual({ ref: 'a', audit: 'NOT-WEAKENED' });
  });
});

describe('fix-ready-record main()', () => {
  afterEach(() => vi.restoreAllMocks());
  const quiet = () => ({
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    err: vi.spyOn(console, 'error').mockImplementation(() => {}),
  });

  describe('writer and adoption-matrix reader agree on the ledger path', () => {
    const quietReader = (env, settings = { fixReadyPath: null }) => {
      const asked = [];
      const reader = createAdoptionMatrixReader({
        env, home: '/h', settings, readText: (p) => { asked.push(p); return ''; },
        run: () => null, exec: () => '', readdir: () => [], isDirectory: () => false,
      });
      try { reader({}); } catch { /* clone discovery is irrelevant here: only the path asked for matters */ }
      return asked[0];
    };
    it('shipped defaults resolve to the very file the adoption matrix reads', () => {
      const env = { HOME: '/h' };
      expect(readyRecordPath({ env })).toBe(quietReader(env));
      expect(adoptionReaderPath({ env, home: '/h' })).toBe(quietReader(env));
    });
    it.each([
      ['WE_FIX_READY_PATH', { HOME: '/h', WE_FIX_READY_PATH: '/o/env.jsonl' }, { fixReadyPath: null }, '/o/env.jsonl'],
      ['~ in WE_FIX_READY_PATH', { HOME: '/h', WE_FIX_READY_PATH: '~/o/env.jsonl' }, { fixReadyPath: null }, '/h/o/env.jsonl'],
      ['fixReadyPath setting', { HOME: '/h' }, { fixReadyPath: '/o/set.jsonl' }, '/o/set.jsonl'],
      ['env beats setting', { HOME: '/h', WE_FIX_READY_PATH: '/o/env.jsonl' }, { fixReadyPath: '/o/set.jsonl' }, '/o/env.jsonl'],
    ])('adoptionReaderPath follows the reader for %s', (_n, env, settings, want) => {
      expect(quietReader(env, settings)).toBe(want);
      expect(adoptionReaderPath({ env, home: '/h', settings })).toBe(want);
    });
    it('main refuses (exit 1) when an override sends the adoption matrix to a different file, and writes nothing', () => {
      const { err } = quiet();
      const dir = mkdtempSync(join(tmpdir(), 'fix-ready-p-'));
      const settingsFile = join(dir, 'p.json');
      writeFileSync(settingsFile, JSON.stringify({ readyRecordPath: join(dir, 'ledger.jsonl') }));
      const argv = [`--ref=${ref}`, `--sha=${sha}`, '--tests=green', '--audit=NOT-WEAKENED'];
      const env = { HOME: dir, WE_FIX_READY_PATH: join(dir, 'elsewhere.jsonl') };
      expect(main(argv, { env, settingsFile, adoptionSettings: { fixReadyPath: null } })).toBe(1);
      expect(err.mock.calls[0][0]).toMatch(/adoption matrix reads .*elsewhere\.jsonl/);
      expect(main(argv, { env: { HOME: dir }, settingsFile, adoptionSettings: { fixReadyPath: join(dir, 'set.jsonl') } })).toBe(1);
      expect(existsSync(join(dir, 'ledger.jsonl'))).toBe(false);
      expect(existsSync(join(dir, 'elsewhere.jsonl'))).toBe(false);
    });
    it('main writes when the override names the same file the writer uses', () => {
      quiet();
      const dir = mkdtempSync(join(tmpdir(), 'fix-ready-p-'));
      const settingsFile = join(dir, 'p.json');
      const ledger = join(dir, 'ledger.jsonl');
      writeFileSync(settingsFile, JSON.stringify({ readyRecordPath: ledger }));
      const argv = [`--ref=${ref}`, `--sha=${sha}`, '--tests=green', '--audit=NOT-WEAKENED'];
      expect(main(argv, { env: { HOME: dir, WE_FIX_READY_PATH: ledger }, settingsFile, adoptionSettings: { fixReadyPath: null } })).toBe(0);
      expect(jsonLines(readFileSync(ledger, 'utf8'))).toHaveLength(1);
    });
    it('main fails closed (exit 2) when the adoption-matrix settings cannot be read', () => {
      const { err } = quiet();
      const dir = mkdtempSync(join(tmpdir(), 'fix-ready-p-'));
      const settingsFile = join(dir, 'p.json');
      writeFileSync(settingsFile, JSON.stringify({ readyRecordPath: join(dir, 'ledger.jsonl') }));
      const argv = [`--ref=${ref}`, `--sha=${sha}`, '--tests=green', '--audit=NOT-WEAKENED'];
      expect(main(argv, { env: { HOME: dir }, settingsFile, adoptionSettingsFile: join(dir, 'missing.json') })).toBe(2);
      expect(err.mock.calls[0][0]).toMatch(/adoption-matrix settings/);
      expect(existsSync(join(dir, 'ledger.jsonl'))).toBe(false);
    });
  });

  it('maps --audit=NOT-WEAKENED to a NOT WEAKENED record and exits 0', () => {
    const { log } = quiet();
    const file = tmp();
    expect(main([`--ref=${ref}`, `--sha=${sha}`, '--tests=green', '--audit=NOT-WEAKENED'], { file })).toBe(0);
    expect(jsonLines(readFileSync(file, 'utf8'))).toEqual([{ ref, sha, tests: 'green', audit: 'NOT WEAKENED' }]);
    expect(log.mock.calls[0][0]).toMatch(/wrote lane\/example@/);
  });
  it('reads a WEAKENED record\'s disclosed findings from --auditDisclosed-file', () => {
    quiet();
    const file = tmp();
    const disclosed = tmp();
    writeFileSync(disclosed, JSON.stringify(findings));
    expect(main([`--ref=${ref}`, `--sha=${sha}`, '--tests=green', '--audit=WEAKENED', '--auditRuling=R816', `--auditDisclosed-file=${disclosed}`], { file })).toBe(0);
    expect(jsonLines(readFileSync(file, 'utf8'))[0]).toEqual({ ref, sha, tests: 'green', audit: 'WEAKENED', auditRuling: 'R816', auditDisclosed: findings });
  });
  it('exits 2 for a missing or malformed --auditDisclosed-file and writes nothing', () => {
    const { err } = quiet();
    const file = tmp();
    const bad = tmp();
    writeFileSync(bad, '{not json');
    for (const path of [join(tmpdir(), 'no-such-disclosed.json'), bad]) {
      expect(main([`--ref=${ref}`, `--sha=${sha}`, '--tests=green', '--audit=WEAKENED', '--auditRuling=R816', `--auditDisclosed-file=${path}`], { file })).toBe(2);
    }
    expect(err.mock.calls[0][0]).toMatch(/cannot read auditDisclosed-file/);
    expect(existsSync(file)).toBe(false);
  });
  it('exits 1 on a refusal (invalid input and duplicate) and says why', () => {
    const { err } = quiet();
    const file = tmp();
    expect(main([`--ref=${ref}`, `--sha=${sha}`, '--tests=red', '--audit=NOT-WEAKENED'], { file })).toBe(1);
    expect(err.mock.calls[0][0]).toMatch(/refused: tests must be green/);
    const argv = [`--ref=${ref}`, `--sha=${sha}`, '--tests=green', '--audit=NOT-WEAKENED'];
    expect(main(argv, { file })).toBe(0);
    expect(main(argv, { file })).toBe(1);
    expect(err.mock.calls[1][0]).toMatch(/duplicate/);
  });
});
