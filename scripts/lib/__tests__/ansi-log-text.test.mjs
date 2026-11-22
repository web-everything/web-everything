// @vitest-environment node
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { readNormalizedJobLog } from '../ansi-log-text.mjs';

describe('SGR-only log evidence normalization', () => {
  it('strips only SGR colours', () => {
    expect(readNormalizedJobLog('\x1b[31mErrors\x1b[0m 1 error'))
      .toEqual({ ok: true, text: 'Errors 1 error' });
  });

  it.each([
    ['OSC with BEL', '\x1b]0;Errors 1 error\x07'],
    ['OSC with ST', '\x1b]0;Errors 1 error\x1b\\'],
    ['stray ESC', '\x1bErrors'],
    ['ESC and space', '\x1b Errors'],
    ['two-character escape', '\x1bMErrors'],
    ['incomplete CSI', '\x1b[31'],
    ...['\x1b[2K', '\x1b[K', '\x1b[?25l', '\x1b[1 q', '\x1b[FAIL', '\x1b[Unhandled'].map(text => [text, text]),
  ])('rejects %s as unreadable', (_name, text) => {
    expect(readNormalizedJobLog(text)).toEqual({ ok: false });
  });

  it('rejects ambiguous ESC[Errors instead of erasing the error marker', () => {
    expect(readNormalizedJobLog('\x1b[Errors 1 error')).toEqual({ ok: false });
  });

  it.each(Array.from({ length: 32 }, (_, i) => String.fromCharCode(0x80 + i)))('rejects C1 control %j', control => {
    expect(readNormalizedJobLog(`${control}Errors 1 error`)).toEqual({ ok: false });
  });

  it('never joins CSI fragments across LF or CRLF boundaries', () => {
    const text = '\x1b[31\nmErrors\r\n\x1b[\r\nErrors\n';
    expect(readNormalizedJobLog(text)).toEqual({ ok: false });
  });

  it('normalizes 80 KiB of repeated OSC openers within a loose linear-time budget', () => {
    const text = '\x1b]'.repeat(40 * 1024) + 'Errors 1 error';
    const started = performance.now();
    expect(readNormalizedJobLog(text)).toEqual({ ok: false });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
  });
});

it.each([null, undefined, {}, 42])('rejects non-log input %j without throwing', log => {
  expect(readNormalizedJobLog(log)).toEqual({ ok: false });
});
