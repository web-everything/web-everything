import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('.gitattributes', () => {
  it('union-merges docs/agent/testing.md', () => {
    const out = execFileSync('git', ['check-attr', 'merge', 'docs/agent/testing.md'], {
      encoding: 'utf8',
    });
    expect(out.trim()).toMatch(/merge: union$/);
  });
});
