import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import matter from 'gray-matter';

const backlog = resolve(dirname(fileURLToPath(import.meta.url)), '../../backlog');

function cardsUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cardsUnder(path);
    if (!entry.isFile() || !entry.name.endsWith('.md')) return [];
    return [{ path, ...matter(readFileSync(path, 'utf8')) }];
  });
}

function followUpsForReviewedHead(directory) {
  return cardsUnder(directory).filter(({ content, data }) =>
    data.status !== 'closed' && (
      content.includes('946132fb8bc28673347e636886f07602eb66880b') ||
      /^# Red-team follow-ups from web-everything\/web-everything#5874 \(head 946132fb8\)\s*$/m.test(content)
    ));
}

describe('PR #5963: deduplicate the PR #5874 red-team follow-ups', () => {
  it('keeps both findings in exactly one surviving card, regardless of filename', () => {
    const cards = followUpsForReviewedHead(backlog);

    expect(cards.map(({ path }) => path), 'duplicate follow-up cards for the same reviewed head').toHaveLength(1);
    const [survivor] = cards;
    expect(survivor.content.match(/^\d+\. `we:scripts\/lib\/pr-size-admission\.mjs:\d+`/gm)).toHaveLength(2);
    expect(survivor.content).toContain('Editable PR body receipts can suppress split-card filing');
    expect(survivor.content).toContain('CRLF body edits break publication receipts and retry idempotency');
  });

  it('keeps follow-ups for another reviewed head of the same PR distinct', () => {
    const directory = mkdtempSync(join(tmpdir(), 'backlog-reviewed-head-'));
    try {
      writeFileSync(join(directory, 'survivor.md'), '# Red-team follow-ups from web-everything/web-everything#5874 (head 946132fb8)\n');
      // Main can admit another review of this PR before this batch merges.
      writeFileSync(join(directory, '7265-other-review.md'), '# Red-team follow-ups from web-everything/web-everything#5874 (head 5a0b327d9)\n\nReviewed head `5a0b327d943d32a9028adce76e36419417cfdd79`.\n');

      expect(followUpsForReviewedHead(directory).map(({ path }) => path)).toEqual([join(directory, 'survivor.md')]);
      expect(cardsUnder(directory)).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('still detects renamed and nested duplicates by full hash or reviewed-head title', () => {
    const directory = mkdtempSync(join(tmpdir(), 'backlog-same-head-'));
    try {
      mkdirSync(join(directory, 'nested'));
      const title = '# Red-team follow-ups from web-everything/web-everything#5874 (head 946132fb8)\n';
      writeFileSync(join(directory, 'survivor.md'), title);
      writeFileSync(join(directory, 'renamed.md'), 'Reviewed head `946132fb8bc28673347e636886f07602eb66880b`.\n');
      writeFileSync(join(directory, 'nested', 'duplicate.md'), title);
      writeFileSync(join(directory, 'closed.md'), `---\nstatus: closed\n---\n${title}`);

      expect(followUpsForReviewedHead(directory).map(({ path }) => path).sort()).toEqual([
        join(directory, 'nested', 'duplicate.md'),
        join(directory, 'renamed.md'),
        join(directory, 'survivor.md'),
      ].sort());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
