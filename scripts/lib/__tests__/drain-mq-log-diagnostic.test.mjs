import { describe, expect, it, vi } from 'vitest';
import { mqLogDiagnosticExcerpt, readMqDiagnosticLog } from '../drain-mq-log-diagnostic.mjs';
import { mqSameHeadGuard } from '../drain-queue-safety.mjs';
import { probe } from '../../conveyor/soak/breaks/mq-log-readable-never-authorizes-retry.mjs';

vi.mock('../settings-files.mjs', async importOriginal => ({
  ...await importOriginal(), readSettings: () => ({ drain: {} }),
}));

describe('display-only MQ terminal diagnostics', () => {
  it.each([
    ['OSC BEL', '\x1b]FAIL tests/x.test.mjs > t\x07'],
    ['OSC ST', '\x1b]FAIL tests/x.test.mjs > t\x1b\\'],
    ['DCS', '\x1bPFAIL tests/x.test.mjs > t\x1b\\'],
    ['SOS', '\x1bXFAIL tests/x.test.mjs > t\x1b\\'],
    ['PM', '\x1b^FAIL tests/x.test.mjs > t\x1b\\'],
    ['APC', '\x1b_FAIL tests/x.test.mjs > t\x1b\\'],
    ['C1 OSC', '\x9dFAIL tests/x.test.mjs > t\x9c'],
    ['C1 DCS', '\x90FAIL tests/x.test.mjs > t\x9c'],
    ['unterminated OSC', '\x1b]FAIL tests/x.test.mjs > t'],
    ['unterminated DCS', '\x1bPFAIL tests/x.test.mjs > t'],
    ['unterminated CSI', '\x1b[123;'],
  ])('drops the entire %s payload within its line and preserves subsequent lines', (_name, control) => {
    const text = `before ${control}\n\x1b[31mRunner disconnected\x1b[0m\nThe runner has received a shutdown signal`;
    const excerpt = mqLogDiagnosticExcerpt(text);
    expect(excerpt).toBe('before Runner disconnected The runner has received a shutdown signal');
    expect(excerpt).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  it('strips controls and bounds oversized lines without starting inside a control-string payload', () => {
    expect(mqLogDiagnosticExcerpt('x'.repeat(10000) + '\x1b]hidden\x07 visible\x00\r\t\b')).toBe('x'.repeat(592) + ' visible');
    const oversized = '\x1b]hidden payload ' + 'x'.repeat(300000) + '\x07';
    const fallback = mqLogDiagnosticExcerpt(oversized);
    expect(fallback).toMatch(/exceeds diagnostic scan bound; operator must inspect the full log/);
    expect(fallback.length).toBeLessThanOrEqual(600);
    expect(fallback).not.toContain('hidden payload');
  });

  it.each(['utf8', 'buffer'])('throws unreadable log with %s output, retaining only a display side channel', encoding => {
    const display = vi.fn();
    const text = '\x1b[31mRunner disconnected\x1b[0m';
    const exec = vi.fn(() => encoding === 'buffer' ? Buffer.from(text) : text);
    expect(() => readMqDiagnosticLog(exec, 'gh', ['api', 'repos/f/r/actions/jobs/1/logs'], { encoding }, display))
      .toThrow('unreadable log');
    expect(display).toHaveBeenCalledWith('Runner disconnected');
    expect(exec.mock.calls[0][1]).toContain('--allow-escape-sequences');
  });

  it('preserves plain evidence verbatim and propagates existing unreadable errors', () => {
    const plain = Buffer.from('FAIL tests/x.test.mjs > t\n');
    const display = vi.fn();
    expect(readMqDiagnosticLog(() => plain, 'gh', ['api', 'logs'], {}, display)).toBe(plain);
    const error = new Error('410 expired');
    expect(() => readMqDiagnosticLog(() => { throw error; }, 'gh', ['api', 'logs'], {}, display)).toThrow(error);
    expect(display).not.toHaveBeenCalled();
  });

  it('retains holds and bounded visible diagnostics in retry, quarantine, gate and exact-test readers', () => {
    expect(probe(mqSameHeadGuard)).toEqual([]);
  });
});
