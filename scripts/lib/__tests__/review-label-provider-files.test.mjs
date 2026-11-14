import { describe, expect, it } from 'vitest';
import { createGhProvider } from '../review-label-provider.mjs';

describe('readPrFiles exact', () => {
  it('keeps a newline or padded path as one exact path', () => {
    const lines = [JSON.stringify('backlog/a.md\nbacklog/b.md'), JSON.stringify(' backlog/c.md ')].join('\n');
    const provider = createGhProvider({ exec: () => lines });
    expect(provider.readPrFiles('o/n', 1, { exact: true })).toEqual(['backlog/a.md\nbacklog/b.md', ' backlog/c.md ']);
  });
  it('throws on an unparsable line', () => {
    expect(() => createGhProvider({ exec: () => 'backlog/a.md' }).readPrFiles('o/n', 1, { exact: true })).toThrow();
  });
});
