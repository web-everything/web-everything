import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import matter from 'gray-matter';

const backlog = fileURLToPath(new URL('../../backlog/', import.meta.url));

function cardsUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cardsUnder(path);
    if (!entry.isFile() || !entry.name.endsWith('.md')) return [];
    return [{ path, ...matter(readFileSync(path, 'utf8')) }];
  });
}

describe('PR #5963: deduplicate the PR #5874 red-team follow-ups', () => {
  it('keeps both findings in exactly one surviving card, regardless of filename', () => {
    const cards = cardsUnder(backlog).filter(({ content, data }) =>
      data.status !== 'closed' && (
        content.includes('946132fb8bc28673347e636886f07602eb66880b') ||
        /^# Red-team follow-ups from web-everything\/web-everything#5874\b/m.test(content)
      ));

    expect(cards.map(({ path }) => path), 'duplicate follow-up cards for the same reviewed head').toHaveLength(1);
    const [survivor] = cards;
    expect(survivor.content.match(/^\d+\. `we:scripts\/lib\/pr-size-admission\.mjs:\d+`/gm)).toHaveLength(2);
    expect(survivor.content).toContain('Editable PR body receipts can suppress split-card filing');
    expect(survivor.content).toContain('CRLF body edits break publication receipts and retry idempotency');
  });
});
