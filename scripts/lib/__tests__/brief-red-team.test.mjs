/**
 * Brief red-team before code (R469 part 3): only guard/daemon/credential touch-sets, bounded, fail-open, settings-gated.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isBriefRedTeamTouchSet, readPrepFile, readBriefRedTeamPolicy, redTeamBrief, renderRedTeamSection } from '../brief-red-team.mjs';

const GUARD = ['we:scripts/lib/red-team-gate.mjs'];
const PLAIN = ['we:scripts/lib/format-date.mjs'];
const policy = (over = {}) => ({ enabled: true, timeoutMs: 50, maxClasses: 3, ...over });
const ok = { classes: [{ attack: 'bypass via symlink', test: 'rejects a symlinked path' }, { attack: 'empty input passes', test: 'denies empty input' }] };

describe('isBriefRedTeamTouchSet', () => {
  it('is true for a guard path (reusing isGuardPath) and for daemon or credential files', () => {
    expect(isBriefRedTeamTouchSet(GUARD)).toBe(true);
    expect(isBriefRedTeamTouchSet(['we:scripts/lib/daemon-load-overlay.mjs'])).toBe(true);
    expect(isBriefRedTeamTouchSet(['we:scripts/lib/github-token-store.mjs'])).toBe(true);
  });
  it('covers daemon names anywhere in the path and ignores design-token files', () => {
    expect(isBriefRedTeamTouchSet(['we:scripts/conveyor/resource-sampler-daemon.mjs'])).toBe(true);
    expect(isBriefRedTeamTouchSet(['we:scripts/lib/daemon-rebuild/prepare.mjs'])).toBe(true);
    expect(isBriefRedTeamTouchSet(['we:scripts/lib/token-css.mjs'])).toBe(false);
  });
  it('is false for an ordinary touch-set, so ordinary dispatch is not slowed', () => {
    expect(isBriefRedTeamTouchSet(PLAIN)).toBe(false);
    expect(isBriefRedTeamTouchSet([])).toBe(false);
  });
});

describe('readBriefRedTeamPolicy', () => {
  it('defaults on with a bounded timeout, and honours the env switch', () => {
    const p = readBriefRedTeamPolicy({ env: {}, read: () => ({}) });
    expect(p.enabled).toBe(true);
    expect(p.timeoutMs).toBeGreaterThan(0);
    expect(readBriefRedTeamPolicy({ env: { WE_BRIEF_RED_TEAM_ENABLED: 'false' }, read: () => ({}) }).enabled).toBe(false);
  });
  it('reads the settings file and ignores invalid values', () => {
    expect(readBriefRedTeamPolicy({ env: {}, read: () => ({ briefRedTeam: { enabled: false, timeoutMs: 9 } }) })).toMatchObject({ enabled: false, timeoutMs: 9 });
    expect(readBriefRedTeamPolicy({ env: {}, read: () => ({ briefRedTeam: { timeoutMs: -1 } }) }).timeoutMs).toBeGreaterThan(0);
    expect(readBriefRedTeamPolicy({ env: {}, read: () => { throw new Error('x'); } }).enabled).toBe(true);
  });
});

describe('redTeamBrief', () => {
  it('skips (never runs) for an ordinary touch-set', async () => {
    const run = vi.fn();
    expect(await redTeamBrief({ files: PLAIN, prep: 'p', policy: policy(), run })).toMatchObject({ status: 'skipped' });
    expect(run).not.toHaveBeenCalled();
  });
  it('skips when the setting is off', async () => {
    const run = vi.fn();
    expect(await redTeamBrief({ files: GUARD, prep: 'p', policy: policy({ enabled: false }), run })).toMatchObject({ status: 'skipped' });
    expect(run).not.toHaveBeenCalled();
  });
  it('skips when there is no prep or acceptance text to attack', async () => {
    const run = vi.fn();
    expect(await redTeamBrief({ files: GUARD, prep: '  ', policy: policy(), run })).toMatchObject({ status: 'skipped' });
    expect(run).not.toHaveBeenCalled();
  });
  it('returns attack classes, each with a test, capped at maxClasses', async () => {
    const run = async () => ({ classes: [...ok.classes, ...ok.classes] });
    const r = await redTeamBrief({ files: GUARD, prep: 'prep', acceptance: 'acc', policy: policy(), run });
    expect(r.status).toBe('ok');
    expect(r.classes).toHaveLength(3);
    expect(r.classes.every((c) => c.attack && c.test)).toBe(true);
  });
  it('drops a class that has no test', async () => {
    const r = await redTeamBrief({ files: GUARD, prep: 'prep', policy: policy(), run: async () => ({ classes: [{ attack: 'a', test: '' }, ok.classes[0]] }) });
    expect(r.classes).toEqual([ok.classes[0]]);
  });
  it('fails open and logs when the red-team throws', async () => {
    const log = vi.fn();
    const r = await redTeamBrief({ files: GUARD, prep: 'prep', policy: policy(), run: async () => { throw new Error('boom'); }, log });
    expect(r).toMatchObject({ status: 'failed', classes: [] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
  it('fails open and logs on timeout, and on a malformed result', async () => {
    const log = vi.fn();
    const slow = await redTeamBrief({ files: GUARD, prep: 'prep', policy: policy({ timeoutMs: 10 }), run: () => new Promise(() => {}), log });
    expect(slow).toMatchObject({ status: 'failed' });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/timed out/i));
    expect((await redTeamBrief({ files: GUARD, prep: 'prep', policy: policy(), run: async () => 'junk', log })).status).toBe('failed');
  });
});

describe('renderRedTeamSection', () => {
  it('renders each class with a required-test line, and nothing for skipped or failed', () => {
    const text = renderRedTeamSection({ status: 'ok', classes: ok.classes });
    expect(text).toContain('bypass via symlink');
    expect(text).toContain('rejects a symlinked path');
    expect(text).toMatch(/must have a test/i);
    expect(renderRedTeamSection({ status: 'skipped', classes: [] })).toBe('');
    expect(renderRedTeamSection({ status: 'failed', classes: [] })).toBe('');
  });
});

describe('readPrepFile (bounded, regular files only)', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'we-prep-'));
  it('reads a regular file', () => {
    const dir = tmp();
    const file = path.join(dir, 'p.md');
    fs.writeFileSync(file, 'prep text');
    try { expect(readPrepFile(file)).toBe('prep text'); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects a FIFO without opening it (would block until EOF)', () => {
    const dir = tmp();
    const fifo = path.join(dir, 'f');
    spawnSync('mkfifo', [fifo]);
    try { expect(() => readPrepFile(fifo)).toThrow(/regular file/); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects a directory and a missing path', () => {
    const dir = tmp();
    try {
      expect(() => readPrepFile(dir)).toThrow(/regular file/);
      expect(() => readPrepFile(path.join(dir, 'nope'))).toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('caps bytes actually read when fstat reports size 0 (procfs-style or growing file)', () => {
    const reads = [];
    const fsOps = {
      openSync: () => 7, closeSync: vi.fn(),
      fstatSync: () => ({ isFile: () => true, size: 0 }),
      readSync: (fd, buf, off, len) => { reads.push(len); buf.fill(0x61, off, off + len); return len; },
    };
    expect(() => readPrepFile('/x', { maxBytes: 64, fs: fsOps })).toThrow(/exceeds 64 bytes/);
    expect(reads.reduce((a, b) => a + b, 0)).toBe(65);
    expect(fsOps.closeSync).toHaveBeenCalledWith(7);
  });
  it('checks the opened descriptor, not the path, so a path swapped to a FIFO after open is not read', () => {
    const fsOps = { openSync: () => 9, closeSync: vi.fn(), readSync: vi.fn(), fstatSync: () => ({ isFile: () => false }) };
    expect(() => readPrepFile('/x', { fs: fsOps })).toThrow(/regular file/);
    expect(fsOps.readSync).not.toHaveBeenCalled();
    expect(fsOps.closeSync).toHaveBeenCalledWith(9);
  });
  it('rejects an oversized file', () => {
    const dir = tmp();
    const file = path.join(dir, 'big.md');
    fs.writeFileSync(file, 'x'.repeat(2048));
    try { expect(() => readPrepFile(file, { maxBytes: 1024 })).toThrow(/exceeds 1024 bytes/); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
