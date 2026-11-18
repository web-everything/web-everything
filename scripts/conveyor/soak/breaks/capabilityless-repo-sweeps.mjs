import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_MANIFEST } from '../../../../skills-src/conveyor/daemon-manifest.mjs';
import { runDraftPromotionStep } from '../../draft-promotion-loop.mjs';
import { runOrphanFixRoundPass } from '../../orphan-fix-round.mjs';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const expected = ['we', 'frontierui', 'plateau-app'].map(key => CONSTELLATION_REPOS[key].slug);

export default {
  id: 'capabilityless-repo-sweeps',
  title: 'A cards-only repo starts watcher daemons and enters maintenance sweeps',
  card: '8418',
  fixedBy: {
    sha: 'HEAD', where: 'lane/longshore-locus-s1',
    paths: ['skills-src/conveyor/daemon-manifest.mjs', 'scripts/conveyor/draft-promotion-loop.mjs', 'scripts/conveyor/orphan-fix-round.mjs'],
  },
  fixPresent(root) {
    return /Object\.entries\(capableRepos\(\)\)/.test(readFileSync(join(root, 'skills-src/conveyor/daemon-manifest.mjs'), 'utf8'));
  },
  async run({ log } = {}) {
    const violations = [];
    const names = Object.keys(DAEMON_MANIFEST).filter(name => name.endsWith('-longshore'));
    if (names.length) violations.push(`capability-less daemon entries: ${names.join(',')}`);
    for (const kind of ['draft', 'orphan']) {
      const seen = [];
      const list = slug => {
        seen.push(slug);
        if (slug === CONSTELLATION_REPOS.longshore.slug) throw new Error('HTTP 404: private cards-only repo');
        return [];
      };
      if (kind === 'draft') runDraftPromotionStep({ listDrafts: ({ repoSlug }) => list(repoSlug) });
      else await runOrphanFixRoundPass({ env: {}, listBounced: list });
      if (JSON.stringify(seen) !== JSON.stringify(expected)) violations.push(`${kind}: queried ${seen.join(',')}`);
      log?.(`${kind}: ${seen.join(',')}`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
