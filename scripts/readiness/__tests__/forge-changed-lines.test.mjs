// @vitest-environment node
import {describe, it, expect} from 'vitest';
import {changedLinesFinding} from '../forge-exec-manifest.mjs';

describe('changedLinesFinding', () => {
  const path = Buffer.from('credentials.md');
  const secret = () => ['AK', 'IA', '0123456789ABCDEF'].join('');
  const finding = (content, base) => changedLinesFinding(path, Buffer.from(content), Buffer.from(base));

  it('allows a clean edit', () => {
    expect(finding('public\nclean edit\n', 'public\n')).toBeNull();
  });

  it('finds a secret in an added line', () => {
    expect(finding(`public\n${secret()}\n`, 'public\n')).toBe('aws-access-key');
  });

  it('ignores a secret only in an unchanged public line outside the context window', () => {
    const base = [secret(), 'one', 'two', 'three', 'four', 'old'].join('\n');
    expect(finding(base.replace('old', 'clean edit'), base)).toBeNull();
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
