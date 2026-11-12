// @vitest-environment node
import {describe, it, expect} from 'vitest';
import {changedLinesFinding, manifestEntry} from '../forge-exec-manifest.mjs';

describe('changedLinesFinding', () => {
  const path = Buffer.from('credentials.md');
  const secret = () => ['AK', 'IA', '0123456789ABCDEF'].join('');
  const highEntropy = () => Array.from({length:32}, (_, i) => String.fromCharCode(65+i)).join('');
  const finding = (content, base) => changedLinesFinding(path, Buffer.from(content), Buffer.from(base));

  it('allows a clean edit', () => {
    expect(finding('public\nclean edit\n', 'public\n')).toBeNull();
  });

  it('finds a secret in an added line', () => {
    expect(finding(`public\n${secret()}\n`, 'public\n')).toBe('aws-access-key');
  });

  it('refuses a secret in an unchanged public line outside the former context window', () => {
    const base = [secret(), 'one', 'two', 'three', 'four', 'old'].join('\n');
    expect(finding(base.replace('old', 'clean edit'), base)).toBe('aws-access-key');
  });

  it('refuses reordering existing lines to put a high-entropy value under password', () => {
    const value = `  ${highEntropy()}`;
    const base = ['public:', value, 'password:', 'next: example'].join('\n');
    const content = ['public:', 'password:', value, 'next: example'].join('\n');
    expect(finding(base, base)).toBeNull();
    expect(finding(content, base)).toBe('high-entropy-password');
  });

  it('refuses a high-entropy continuation more than three lines below password', () => {
    const base = ['password:', '  one', '  two', '  three', '  four', 'next: example'].join('\n');
    const content = base.replace('next: example', `  ${highEntropy()}\nnext: example`);
    expect(finding(content, base)).toBe('high-entropy-password');
  });

  it('refuses an added exported password literal', () => {
    const added = ['export const password', ' = "', 'private-live-', 'password', '";'].join('');
    expect(finding(`public\n${added}\n`, 'public\n')).toBe('credential-literal-assignment');
  });

  it('allows harmless added code beside an existing public password literal', () => {
    const base = ['export const password', ' = "', 'example', '";\n'].join('');
    expect(finding(`${base}export const count = 1;\n`, base)).toBeNull();
  });

  it('counts duplicate lines so an extra password assignment is still added', () => {
    const base = ['export const password', ' = "', 'example', '";\n'].join('');
    expect(finding(base + base, base)).toBe('credential-literal-assignment');
  });

  it('returns the whole-file finding before trying to decode invalid public bytes', () => {
    expect(changedLinesFinding(path, Buffer.from(secret()), Buffer.from([0xff]))).toBe('aws-access-key');
  });

  it('manifestEntry refuses a literal private-key header in a tracked credential-named path', () => {
    const content = Buffer.from(['-----', 'BEGIN PRIVATE', ' KEY-----'].join(''));
    expect(() => manifestEntry(path, content, false, true)).toThrow(
      expect.objectContaining({code:'excluded-source-file', message:expect.stringContaining('credentials.md (pem-header)')}));
  });

  it.each([['before', -3], ['after', 3]])('scans an unchanged secret three lines %s an edit', (_label, offset) => {
    const lines = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
    lines[3 + offset] = secret();
    const content = [...lines];
    content[3] = 'clean edit';
    expect(finding(content.join('\n'), lines.join('\n'))).toBe('aws-access-key');
  });

  it.each([
    ['binary bytes', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ['NUL', Buffer.from('public\0edit')],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
  ])('fails closed on %s in the working content', (_label, content) => {
    expect(changedLinesFinding(path, content, Buffer.from('public'))).toBe('unsupported-text-encoding');
  });

  it('fails closed on invalid UTF-8 in public bytes', () => {
    expect(changedLinesFinding(path, Buffer.from('clean edit'), Buffer.from([0xff])))
      .toBe('unsupported-text-encoding');
  });
});
