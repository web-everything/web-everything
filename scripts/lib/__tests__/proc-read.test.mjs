/** @file proc-read.test.mjs — complete large reads and fail-closed errors (#74a). */
import { describe, expect, it, vi } from 'vitest';
import { execRead, readGit, readGh, readGhJson, ProcReadError, READ_MAX_BUFFER, MIN_READ_MAX_BUFFER } from '../proc-read.mjs';

const size = 2 * 1024 * 1024;
const fail = (cause) => () => { throw cause; };

describe('process reads', () => {
  it.each([{}, { maxBuffer: 10 }])('reads all 2 MiB from a real child with %j', (opts) => {
    expect(execRead(process.execPath, ['-e', `process.stdout.write('x'.repeat(${size}))`], opts)).toHaveLength(size);
  });

  it('defaults encoding/buffer, strips the seam, and preserves raised limits and other options', () => {
    const exec = vi.fn(() => 'ok');
    expect(READ_MAX_BUFFER).toBe(256 * 1024 * 1024);
    expect(MIN_READ_MAX_BUFFER).toBe(1024 * 1024);
    expect(readGit(['status'], { exec })).toBe('ok');
    expect(exec).toHaveBeenLastCalledWith('git', ['status'], { encoding: 'utf8', maxBuffer: READ_MAX_BUFFER });
    for (const maxBuffer of [MIN_READ_MAX_BUFFER, READ_MAX_BUFFER * 2]) {
      expect(readGh(['api'], { exec, maxBuffer, timeout: 500, cwd: '/tmp' })).toBe('ok');
      expect(exec).toHaveBeenLastCalledWith('gh', ['api'], { encoding: 'utf8', maxBuffer, timeout: 500, cwd: '/tmp' });
    }
  });

  it.each([
    [{ code: 'ENOBUFS', stdout: Buffer.from('partial') }, {}, 'output-too-large'],
    [{ errno: 'ENOBUFS' }, {}, 'output-too-large'],
    [{ code: 'ETIMEDOUT' }, {}, 'timeout'],
    [{ signal: 'SIGTERM' }, { timeout: 10 }, 'timeout'],
    [{ signal: 'SIGTERM' }, {}, 'exit'],
    [{ status: 3, stderr: Buffer.from('bad read') }, {}, 'exit'],
  ])('never returns partial/empty data on %j', (cause, opts, code) => {
    let caught;
    try { execRead('git', ['log'], { ...opts, exec: fail(cause) }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ProcReadError);
    expect(caught).toMatchObject({ code, file: 'git', args: ['log'], cause });
    if (cause.stdout) expect(caught.bytes).toBe(7);
    if (cause.status) {
      expect(caught.status).toBe(3);
      expect(caught.message).toContain('bad read');
    }
  });

  it('retains a real child exit status and stderr', () => {
    expect(() => execRead(process.execPath, ['-e', "process.stderr.write('read denied'); process.exit(7)"],
      { stdio: ['ignore', 'pipe', 'pipe'] })).toThrow(expect.objectContaining({ code: 'exit', status: 7, message: expect.stringContaining('read denied') }));
  });

  it.each(['', ' \n\t', '{bad', '[1,'])('rejects empty or invalid JSON %j', (stdout) => {
    expect(() => readGhJson(['api'], { exec: () => stdout })).toThrow(expect.objectContaining({ code: 'parse', file: 'gh', args: ['api'] }));
  });

  it('parses complete JSON and does not relabel process errors as parse errors', () => {
    expect(readGhJson(['api'], { exec: () => '[]' })).toEqual([]);
    expect(readGhJson(['api'], { exec: () => '{"ok":true}' })).toEqual({ ok: true });
    expect(() => readGhJson(['api'], { exec: fail({ code: 'ENOBUFS' }) })).toThrow(expect.objectContaining({ code: 'output-too-large' }));
  });
});
