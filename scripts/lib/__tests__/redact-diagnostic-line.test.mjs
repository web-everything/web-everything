import { describe, expect, it } from 'vitest';
import { redactDiagnosticLine } from '../daemon-rebuild/smoke-classify/redact-detail.mjs';

describe('operator diagnostic redaction', () => {
  it.each(['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'])(
    'removes %s token values from diagnostic output', prefix => {
      const secret = 'credentialValue_0123456789';
      const result = redactDiagnosticLine(`failed with ${prefix}${secret} while checking`);
      expect(result).toBe(`failed with ${prefix}<redacted> while checking`);
      expect(result).not.toContain(secret);
    },
  );

  it('redacts token values even when terminal controls split the credential', () => {
    const result = redactDiagnosticLine('failed with ghp_credential\u001bValue_0123456789');
    expect(result).toBe('failed with ghp_<redacted>');
    expect(result).not.toContain('credential');
    expect(result).not.toContain('Value_0123456789');
  });

  const controls = [
    ...Array.from({ length: 32 }, (_, code) => code).filter(code => code !== 10 && code !== 13),
    ...Array.from({ length: 33 }, (_, index) => index + 127),
  ].map(code => ({ name: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`, char: String.fromCharCode(code) }));

  it.each(controls)('removes terminal control $name from diagnostic output', ({ char }) => {
    const result = redactDiagnosticLine(`before${char}after`);
    expect(result).toBe('beforeafter');
    expect(result).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  it.each(['\r', '\n'])('excludes terminal line control %j and subsequent text', char => {
    const result = redactDiagnosticLine(`before${char}after`);
    expect(result).toBe('before');
    expect(result).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });
});
