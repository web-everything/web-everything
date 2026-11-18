/** PR #6911: a known cross-repo citation must survive card/hold/delivery text production. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export default {
  id: 'longshore-citation-prefix',
  title: 'longshore citations survive alongside bare paths in generated cards',
  card: 'PR #6911',
  fixedBy: {
    sha: 'HEAD', where: 'lane/longshore-locus-s1',
    paths: [
      'scripts/lib/citation-check.mjs', 'scripts/lib/locus-prefix-text.mjs',
      'scripts/check-standards-rules.mjs', 'scripts/operations/build-dispatch-hold-route-land.mjs',
      'scripts/operations/deliver-item-wrapper.mjs',
    ],
  },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/locus-prefix-text.mjs'), 'utf8').includes('LOCUS_PREFIX_RE_SOURCE');
  },
  async run({ log } = {}) {
    const { cardFindingText } = await import('../../../lib/locus-prefix-text.mjs');
    const { findDanglingLoci } = await import('../../../lib/citation-check.mjs');
    const { sanitizeHoldReason } = await import('../../../operations/build-dispatch-hold-route-land.mjs');
    const { prefixOwnPathMentions } = await import('../../../operations/deliver-item-wrapper.mjs');
    const path = 'scripts/check-cards.mjs:12';
    const text = `Fix longshore:${path} and ${path}`;
    const expected = `Fix longshore:${path} and we:${path}`;
    const violations = [];
    for (const [name, actual] of [
      ['ruling card', cardFindingText(text)],
      ['dispatch hold', sanitizeHoldReason(text)],
      ['delivery card', prefixOwnPathMentions(text, [path])],
    ]) {
      if (actual !== expected) violations.push(`${name}: ${actual}`);
      log?.(`${name}: ${actual}`);
    }
    const lone = cardFindingText(`Fix longshore:${path}`);
    if (findDanglingLoci(lone, { fileExists: () => false, lineCount: () => 0 }).length) {
      violations.push('cross-repo finding became a dangling local citation');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
