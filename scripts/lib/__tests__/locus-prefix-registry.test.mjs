import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { LOCUS_PREFIX_NAMES, LOCUS_PREFIX_RE_SOURCE, findDanglingLoci, findBlankLineLoci } from '../citation-check.mjs';
import { cardFindingText } from '../locus-prefix-text.mjs';
import { dirLevelScopeFinding } from '../../check-standards-rules.mjs';

describe('shared locus-prefix vocabulary', () => {
  it.each(LOCUS_PREFIX_NAMES)('preserves %s citations beside bare references', (prefix) => {
    const marked = `${prefix}:scripts/check-cards.mjs:12`;
    expect(cardFindingText(`Fix ${marked} and scripts/check-cards.mjs:12`))
      .toBe(`Fix ${marked} and we:scripts/check-cards.mjs:12`);
    expect(dirLevelScopeFinding({ status: 'open', scope: [`${prefix}:backlog/`] }))
      .toEqual([`${prefix}:backlog/`]);
  });

  it.each(LOCUS_PREFIX_NAMES)('resolves %s citations only in their own repo', (prefix) => {
    const local = ['we', 'webeverything'].includes(prefix);
    const cite = `${prefix}:scripts/check-cards.mjs:12`;
    const fileExists = () => { expect(local).toBe(true); return true; };
    expect(findDanglingLoci(cite, { fileExists, lineCount: () => 1 })).toHaveLength(local ? 1 : 0);
    expect(findBlankLineLoci(cite, { fileExists, readLines: () => Array(12).fill('') })).toHaveLength(local ? 1 : 0);
  });

  it('rejects unknown prefixes and keeps the exported names immutable', () => {
    const scope = new RegExp(`^(?:${LOCUS_PREFIX_RE_SOURCE}):`);
    for (const value of ['ops:', 'longshoreai:', 'xlongshore:', 'longshore2:', 'LONGSHORE:']) {
      expect(scope.test(value), value).toBe(false);
    }
    expect(Object.isFrozen(LOCUS_PREFIX_NAMES)).toBe(true);
  });

  it('forbids copied literal locus alternations anywhere in tracked scripts outside the shared source', () => {
    const files = execFileSync('git', ['ls-files', '-z', '--', 'scripts'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      .split('\0').filter(Boolean).filter((file) => !file.includes('/__tests__/') && !/\.(?:test|spec)\./.test(file));
    // Recognize any ordering, including the old colon-inside-lookbehind variant.
    // A full locus roster contains these three original short names. Smaller lists
    // (launchd label families, PR-pinned card readers) describe different domains.
    const hasCopiedRoster = (line) => [...line.matchAll(/\((?:\?:|\?<!)?([a-z-]+:?(?:\|[a-z-]+:?)+)\)/g)]
      .some((m) => ['we', 'fui', 'plateau'].every((prefix) => m[1].split('|').map((s) => s.replace(/:$/, '')).includes(prefix)));
    expect(hasCopiedRoster('/(?:we|fui|plateau):/')).toBe(true);
    expect(hasCopiedRoster('(?<!plateau:|we:|fui:)')).toBe(true);
    expect(hasCopiedRoster('/^com\\.(we|plateau)\\./')).toBe(false);
    const copies = files.filter((file) => file !== 'scripts/lib/citation-check.mjs')
      .flatMap((file) => readFileSync(file, 'utf8').split('\n')
        .flatMap((line, i) => hasCopiedRoster(line) ? [`${file}:${i + 1}`] : []));
    expect(copies).toEqual([]);
  });
});
