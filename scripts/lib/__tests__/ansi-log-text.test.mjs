// @vitest-environment node
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { stripAnsiLogText } from '../ansi-log-text.mjs';

describe('CSI-only log evidence normalization', () => {
  it('strips well-formed CSI colours, erase commands, private parameters and intermediates', () => {
    expect(stripAnsiLogText('\x1b[31mErrors\x1b[0m \x1b[2K1 error\x1b[K\x1b[?25l\x1b[1 q'))
      .toBe('Errors 1 error');
  });

  it.each([
    ['OSC with BEL', '\x1b]0;Errors 1 error\x07'],
    ['OSC with ST', '\x1b]0;Errors 1 error\x1b\\'],
    ['stray ESC', '\x1bErrors'],
    ['ESC and space', '\x1b Errors'],
    ['two-character escape', '\x1bMErrors'],
    ['8-bit CSI and OSC', '\x9b31mErrors\x9d0;1 error\x9c'],
    ['incomplete CSI', '\x1b[31'],
  ])('preserves %s unchanged', (_name, text) => {
    expect(stripAnsiLogText(text)).toBe(text);
  });

  it('consumes only the valid CSI final byte in ESC[Errors', () => {
    expect(stripAnsiLogText('\x1b[Errors')).toBe('rrors');
  });

  it('never joins CSI fragments across LF or CRLF boundaries', () => {
    const text = '\x1b[31\nmErrors\r\n\x1b[\r\nErrors\n';
    expect(stripAnsiLogText(text)).toBe(text);
  });

  it('normalizes 80 KiB of repeated OSC openers within a loose linear-time budget', () => {
    const text = '\x1b]'.repeat(40 * 1024) + 'Errors 1 error';
    const started = performance.now();
    const result = stripAnsiLogText(text);
    const elapsed = performance.now() - started;
    expect(result).toBe(text);
    expect(elapsed).toBeLessThan(1000);
  });
});
