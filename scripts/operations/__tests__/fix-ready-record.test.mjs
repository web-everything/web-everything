import { afterEach, describe, expect, it, vi } from 'vitest';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReadyRecord, writeReadyRecord, readyRecordPath, adoptionReaderPath, parseArgs, main } from '../fix-ready-record.mjs';
import { createAdoptionMatrixReader } from '../adoption-matrix-io.mjs';
import { parseFixReadyLines } from '../adoption-matrix.mjs';
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
  it('does not cut back bytes another writer appended while this write was failing', () => {
    const file = tmp();
    const other = `${JSON.stringify({ ref: 'lane/other', sha: 'a'.repeat(40), tests: 'green', audit: 'NOT WEAKENED' })}\n`;
    let calls = 0;
    const fsApi = {
      ...fs,
      writeSync: (fd, buf, off = 0, len = buf.length - off) => {
        if (calls++ === 0) return fs.writeSync(fd, buf, off, 5);
        fs.appendFileSync(file, other); // a writer that took over the stale lock appends meanwhile
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    };
    const r = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file, fsApi });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/NOT cut back/);
    expect(readFileSync(file, 'utf8').endsWith(other)).toBe(true);
  });
  it('refuses a record too large for the adoption matrix reader to keep (it reads only the last 1 MiB)', () => {
    const file = tmp();
    const r = writeReadyRecord({ ...base, audit: 'WEAKENED', auditRuling: 'R816', auditDisclosed: ['x'.repeat(70 * 1024)] }, { file });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/limit is 65536/);
    expect(existsSync(file)).toBe(false);
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
  it('refuses an identical legacy record whose keys are in a different order, leaving the ledger bytes unchanged', () => {
    const file = tmp();
    const legacy = `${JSON.stringify({ audit: 'NOT WEAKENED', tests: 'green', sha, ref })}\n`;
    writeFileSync(file, legacy);
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file }).error).toMatch(/duplicate/);
    expect(readFileSync(file, 'utf8')).toBe(legacy);
    const weakened = `${JSON.stringify({ auditDisclosed: findings, auditRuling: 'R816', audit: 'WEAKENED', tests: 'green', sha, ref })}\n`;
    writeFileSync(file, weakened);
    expect(writeReadyRecord({ ...base, audit: 'WEAKENED', auditRuling: 'R816', auditDisclosed: findings }, { file }).error).toMatch(/duplicate/);
    expect(readFileSync(file, 'utf8')).toBe(weakened);
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
  it('stamps every written record with a parseable `at` that the adoption matrix reader accepts (no "malformed")', () => {
    const file = tmp();
    const at = Date.parse('2026-11-10T12:00:00.000Z');
    const a = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file, now: () => at });
    const b = writeReadyRecord({ ...base, ref: 'lane/other', audit: 'WEAKENED', auditRuling: 'R816', auditDisclosed: findings }, { file, now: () => at + 5000 });
    expect(a.record.at).toBe('2026-11-10T12:00:00.000Z');
    const incomplete = [];
    const rows = parseFixReadyLines(readFileSync(file, 'utf8'), { onIncomplete: (m) => incomplete.push(m) });
    expect(incomplete).toEqual([]);
    expect(rows).toEqual([
      { ref, at: a.record.at, sha },
      { ref: 'lane/other', at: b.record.at, sha },
    ]);
  });
  it('ignores `at` when deciding a duplicate: the same record written later is still refused', () => {
    const file = tmp();
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file, now: () => 1_700_000_000_000 }).ok).toBe(true);
    expect(writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file, now: () => 1_800_000_000_000 }).error).toMatch(/duplicate/);
    expect(jsonLines(readFileSync(file, 'utf8'))).toHaveLength(1);
  });
  it.each([[NaN], [undefined], [1e20], [-1e20]])('refuses to write when the clock returns no usable time (%s), and writes nothing', (bad) => {
    const file = tmp();
    const r = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file, now: () => bad });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/clock/);
    expect(existsSync(file)).toBe(false);
  });
  it('never stamps a ref below its latest `at` in the ledger, so the reader keeps the newer record (clock stepped back)', () => {
    const file = tmp();
    const later = '2026-11-10T12:00:00.000Z';
    writeFileSync(file, `${JSON.stringify({ ref, sha: 'a'.repeat(40), tests: 'green', audit: 'NOT WEAKENED', at: later })}\n`);
    const r = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file, now: () => Date.parse(later) - 3_600_000 });
    expect(r.ok).toBe(true);
    expect(r.record.at).toBe(later);
    expect(parseFixReadyLines(readFileSync(file, 'utf8'))).toEqual([{ ref, at: later, sha }]);
    // a different ref is unaffected by this ref's `at`
    const other = writeReadyRecord({ ...base, ref: 'lane/other', audit: 'NOT WEAKENED' }, { file, now: () => Date.parse(later) - 3_600_000 });
    expect(other.record.at).toBe('2026-11-10T11:00:00.000Z');
  });
  it('uses the clock when it is ahead of the ledger, and ignores unparseable `at` values in old lines', () => {
    const file = tmp();
    writeFileSync(file, `${JSON.stringify({ ref, sha: 'a'.repeat(40), tests: 'green', audit: 'NOT WEAKENED', at: 'not-a-date' })}\n`);
    const r = writeReadyRecord({ ...base, audit: 'NOT WEAKENED' }, { file, now: () => Date.parse('2026-11-10T13:00:00.000Z') });
    expect(r.record.at).toBe('2026-11-10T13:00:00.000Z');
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
      // The diagnostic names BOTH files: where the adoption matrix reads and where the writer would append.
      expect(err.mock.calls[0][0]).toContain(`adoption matrix reads ${join(dir, 'elsewhere.jsonl')}`);
      expect(err.mock.calls[0][0]).toContain(`would append to ${join(dir, 'ledger.jsonl')}`);
      expect(main(argv, { env: { HOME: dir }, settingsFile, adoptionSettings: { fixReadyPath: join(dir, 'set.jsonl') } })).toBe(1);
      expect(err.mock.calls[1][0]).toContain(`adoption matrix reads ${join(dir, 'set.jsonl')}`);
      expect(err.mock.calls[1][0]).toContain(`would append to ${join(dir, 'ledger.jsonl')}`);
      expect(existsSync(join(dir, 'ledger.jsonl'))).toBe(false);
      expect(existsSync(join(dir, 'elsewhere.jsonl'))).toBe(false);
      expect(existsSync(join(dir, 'set.jsonl'))).toBe(false);
    });
    describe('names for the same file are not a split', () => {
      const argv = [`--ref=${ref}`, `--sha=${sha}`, '--tests=green', '--audit=NOT-WEAKENED'];
      const setup = () => {
        quiet();
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fix-ready-p-')));
        mkdirSync(join(dir, 'sub'));
        const settingsFile = join(dir, 'p.json');
        const ledger = join(dir, 'ledger.jsonl');
        writeFileSync(settingsFile, JSON.stringify({ readyRecordPath: ledger }));
        return { dir, settingsFile, ledger };
      };
      it('accepts a `..` segment and a redundant `.` in the reader path', () => {
        const { dir, settingsFile, ledger } = setup();
        const env = { HOME: dir, WE_FIX_READY_PATH: `${dir}/sub/../././ledger.jsonl` };
        expect(main(argv, { env, settingsFile, adoptionSettings: { fixReadyPath: null } })).toBe(0);
        expect(jsonLines(readFileSync(ledger, 'utf8'))).toHaveLength(1);
      });
      it('accepts a relative reader path that resolves to the writer file (via the working directory)', () => {
        const { dir, settingsFile, ledger } = setup();
        const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
        const env = { HOME: dir };
        expect(main(argv, { env, settingsFile, adoptionSettings: { fixReadyPath: './sub/../ledger.jsonl' } })).toBe(0);
        expect(cwd).toHaveBeenCalled();
        expect(jsonLines(readFileSync(ledger, 'utf8'))).toHaveLength(1);
      });
      it('accepts a symlinked directory that holds the same file', () => {
        const { dir, settingsFile } = setup();
        const link = join(dir, 'link');
        symlinkSync(join(dir, 'sub'), link);
        // the writer path goes through the symlink, the reader path does not (and neither file exists yet)
        writeFileSync(settingsFile, JSON.stringify({ readyRecordPath: join(link, 'l.jsonl') }));
        const env = { HOME: dir, WE_FIX_READY_PATH: join(dir, 'sub', 'l.jsonl') };
        expect(main(argv, { env, settingsFile, adoptionSettings: { fixReadyPath: null } })).toBe(0);
        expect(jsonLines(readFileSync(join(dir, 'sub', 'l.jsonl'), 'utf8'))).toHaveLength(1);
      });
      it('refuses `link/..` when the link points at a nested directory: `..` leaves the link target, not the link parent', () => {
        const { dir, settingsFile, ledger } = setup();
        const { err } = quiet();
        mkdirSync(join(dir, 'sub', 'deep'));
        symlinkSync(join(dir, 'sub', 'deep'), join(dir, 'link'));
        // The kernel opens `<dir>/sub/ledger.jsonl` for this name; the writer's ledger is `<dir>/ledger.jsonl`.
        const env = { HOME: dir, WE_FIX_READY_PATH: `${dir}/link/../ledger.jsonl` };
        expect(main(argv, { env, settingsFile, adoptionSettings: { fixReadyPath: null } })).toBe(1);
        expect(err.mock.calls[0][0]).toMatch(/refused/);
        expect(existsSync(ledger)).toBe(false);
        // ...and accepts it when the writer really names the file the kernel reaches.
        writeFileSync(settingsFile, JSON.stringify({ readyRecordPath: join(dir, 'sub', 'ledger.jsonl') }));
        expect(main(argv, { env, settingsFile, adoptionSettings: { fixReadyPath: null } })).toBe(0);
        expect(jsonLines(readFileSync(join(dir, 'sub', 'ledger.jsonl'), 'utf8'))).toHaveLength(1);
      });
      it('still refuses two different files whose names merely look alike', () => {
        const { dir, settingsFile } = setup();
        const { err } = quiet();
        const env = { HOME: dir, WE_FIX_READY_PATH: `${dir}/sub/../other.jsonl` };
        expect(main(argv, { env, settingsFile, adoptionSettings: { fixReadyPath: null } })).toBe(1);
        expect(err.mock.calls[0][0]).toMatch(/refused/);
      });
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
    it.each([
      ['a missing file', (dir) => join(dir, 'missing.json'), null],
      ['malformed JSON', (dir) => join(dir, 'bad.json'), '{not json'],
    ])('main fails closed (exit 2) when the adoption-matrix settings cannot be read: %s', (_n, pick, content) => {
      const { err } = quiet();
      const dir = mkdtempSync(join(tmpdir(), 'fix-ready-p-'));
      const settingsFile = join(dir, 'p.json');
      writeFileSync(settingsFile, JSON.stringify({ readyRecordPath: join(dir, 'ledger.jsonl') }));
      const adoptionSettingsFile = pick(dir);
      if (content !== null) writeFileSync(adoptionSettingsFile, content);
      const argv = [`--ref=${ref}`, `--sha=${sha}`, '--tests=green', '--audit=NOT-WEAKENED'];
      expect(main(argv, { env: { HOME: dir }, settingsFile, adoptionSettingsFile })).toBe(2);
      expect(err.mock.calls[0][0]).toMatch(/adoption-matrix settings/);
      expect(existsSync(join(dir, 'ledger.jsonl'))).toBe(false);
    });
    it.each([
      ['a missing prototype-load settings file', (dir) => join(dir, 'nope.json'), null],
      ['malformed prototype-load settings', (dir) => join(dir, 'p-bad.json'), '{not json'],
      ['prototype-load settings without readyRecordPath', (dir) => join(dir, 'p-empty.json'), '{}'],
    ])('main fails closed (exit 2) when the writer ledger path cannot be resolved: %s', (_n, pick, content) => {
      const { err } = quiet();
      const dir = mkdtempSync(join(tmpdir(), 'fix-ready-p-'));
      const settingsFile = pick(dir);
      if (content !== null) writeFileSync(settingsFile, content);
      const argv = [`--ref=${ref}`, `--sha=${sha}`, '--tests=green', '--audit=NOT-WEAKENED'];
      expect(main(argv, { env: { HOME: dir }, settingsFile, adoptionSettings: { fixReadyPath: null } })).toBe(2);
      expect(err.mock.calls[0][0]).toMatch(/cannot resolve the ledger path/);
      expect(existsSync(join(dir, 'ledger.jsonl'))).toBe(false);
    });
  });

  it('maps --audit=NOT-WEAKENED to a NOT WEAKENED record and exits 0', () => {
    const { log } = quiet();
    const file = tmp();
    expect(main([`--ref=${ref}`, `--sha=${sha}`, '--tests=green', '--audit=NOT-WEAKENED'], { file })).toBe(0);
    expect(jsonLines(readFileSync(file, 'utf8'))).toEqual([{ ref, sha, tests: 'green', audit: 'NOT WEAKENED', at: expect.any(String) }]);
    expect(log.mock.calls[0][0]).toMatch(/wrote lane\/example@/);
  });
  it('reads a WEAKENED record\'s disclosed findings from --auditDisclosed-file', () => {
    quiet();
    const file = tmp();
    const disclosed = tmp();
    writeFileSync(disclosed, JSON.stringify(findings));
    expect(main([`--ref=${ref}`, `--sha=${sha}`, '--tests=green', '--audit=WEAKENED', '--auditRuling=R816', `--auditDisclosed-file=${disclosed}`], { file })).toBe(0);
    expect(jsonLines(readFileSync(file, 'utf8'))[0]).toEqual({ ref, sha, tests: 'green', audit: 'WEAKENED', auditRuling: 'R816', auditDisclosed: findings, at: expect.any(String) });
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
