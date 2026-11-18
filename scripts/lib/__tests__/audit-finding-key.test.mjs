/** @file Stable audit identities and deterministic head symbol lookup. */
import { describe, expect, it } from 'vitest';
import { findingKey, parseFindingLocation, symbolAt } from '../audit-finding-key.mjs';
import { FINDING_CLASSES } from '../../operations/audit-verdict.mjs';

const source = `// top
export function X() {
  const inner = () => {
    return "}"; // ignored brace
  };
  return inner();
}
const Y = (x) => x + 1;
class Example {
  async method() {
    return 1;
  }
}
// outside`;

describe('finding identity', () => {
  it('normalizes paths and defaults the symbol, with the closed class vocabulary', () => {
    for (const cls of FINDING_CLASSES) expect(findingKey({ file: './lib/../x.mjs', class: cls })).toBe(`x.mjs|<top>|${cls}`);
    expect(findingKey({ file: 'x.mjs', symbol: '', class: 'B1' })).toBe('x.mjs|<top>|B1');
  });
  it.each(['/x', '../x', 'a/../../x', 'a|x', 'a\\x', 'https://x'])('rejects non-repository identity %s', file => {
    expect(() => findingKey({ file, class: 'B1' })).toThrow();
  });
  it('rejects unknown classes and separator-bearing symbols', () => {
    expect(() => findingKey({ file: 'x', class: 'B8' })).toThrow();
    expect(() => findingKey({ file: 'x', class: 'B1', symbol: 'a|b' })).toThrow();
  });
  it('b3 reworded finding text keeps exactly the same file/symbol/class key', () => {
    const keys = ['`./x.mjs:6` missing guard', 'A guard can be bypassed at x.mjs:6.'].map(text => {
      const { file, line } = parseFindingLocation(text);
      return findingKey({ file, symbol: symbolAt(source, line), class: 'B2' });
    });
    expect(keys).toEqual(['x.mjs|X|B2', 'x.mjs|X|B2']);
  });
  it('extracts location without treating prose as identity', () => {
    expect(parseFindingLocation('- (src/test.mjs:42) finding')).toEqual({ file: 'src/test.mjs', line: 42 });
    for (const text of [null, 'no location', 'x:0', '/etc/passwd:1', '../x:1', 'x:9007199254740992', 'x:1 and y:2']) {
      expect(parseFindingLocation(text)).toBeNull();
    }
  });
});

describe('symbolAt', () => {
  it('selects the nearest enclosing function, const arrow or class method', () => {
    expect(symbolAt(source, 2)).toBe('X');
    expect(symbolAt(source, 4)).toBe('inner');
    expect(symbolAt(source, 6)).toBe('X');
    expect(symbolAt(source, 8)).toBe('Y');
    expect(symbolAt(source, 11)).toBe('method');
  });
  it('ignores control blocks, string/comment braces and returns top outside functions', () => {
    expect(symbolAt('function outer() {\n if (true) {\n /* } */ return "{";\n }\n}', 3)).toBe('outer');
    expect(symbolAt(source, 14)).toBe('<top>');
    for (const line of [0, -1, 100, NaN]) expect(symbolAt(source, line)).toBe('<top>');
    expect(symbolAt(null, 1)).toBe('<top>');
  });
});
