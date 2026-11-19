/** Replays the 2026-11-18 cost regression through the real drain with injected git/gh fakes. */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFastDrainContextCli } from '../../../__tests__/fixtures/fast-drain-context-cli.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export default {
  id: 'fast-drain-full-open-listing',
  title: 'a single green-event drain lists checks for every open PR',
  card: '2026-11-18 single-PR fast-drain listing latency',
  fixedBy: { sha: 'working-tree', where: 'scripts/lib/fast-drain-context.mjs' },
  fixPresent: root => existsSync(join(root, 'scripts/lib/fast-drain-context.mjs')),
  async run() { return runFastDrainContextCli({ root: process.env.SOAK_TREE_ROOT || ROOT }); },
  judge(report) {
    const violations = [];
    if (report.status !== 0) violations.push(`drain failed: ${report.stderr}`);
    if (report.fullListings !== 0 || report.heavyListings !== 0) violations.push(`single-PR drain issued ${report.fullListings} full page listings and ${report.heavyListings} heavy context listings`);
    if (report.leanListings !== 3) violations.push(`expected one lean inventory per context repo, saw ${report.leanListings}`);
    return violations;
  },
};
