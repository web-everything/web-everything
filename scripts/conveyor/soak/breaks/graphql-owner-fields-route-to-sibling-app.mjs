/**
 * 2026-11-23: the daemon gh shim ignored the owner=/name= fields of `gh api graphql`, so a plateauapp/plateau-app
 * comment read used the web-everything App token ("Could not resolve to a Repository"). Every accepted review then
 * parked at the confirm step with no verdict label. The owner must be read from the graphql fields.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'graphql-owner-fields-route-to-sibling-app',
  title: 'gh shim: graphql owner=/name= fields must select the sibling repo owner App installation, not the checkout owner',
  card: 'plateau-app review accepts park: graphql owner routing (PA-REVIEW-WRITEBACK)',
  fixedBy: { sha: 'pending', where: 'lane/pa-writeback-owner-routing', paths: ['scripts/lib/github-app-installations.mjs'] },
  // The fix ships with this break, so it is always required: a regression fails CI instead of flipping to expected-fail.
  fixPresent() { return true; },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { ownerFromGhArgv } = await import(pathToFileURL(join(root, 'scripts/lib/github-app-installations.mjs')).href);
    const violations = [];
    const q = ['api', 'graphql', '-f', 'query=query{x}'];
    const got = ownerFromGhArgv([...q, '-f', 'owner=plateauapp', '-f', 'name=plateau-app']);
    if (got !== 'plateauapp') violations.push(`graphql -f owner=plateauapp name=plateau-app resolved to ${got}`);
    const got2 = ownerFromGhArgv([...q, '-F', 'owner=plateauapp', '-F', 'name=plateau-app']);
    if (got2 !== 'plateauapp') violations.push(`graphql -F fields resolved to ${got2}`);
    const none = ownerFromGhArgv([...q, '-f', 'owner=plateauapp']);
    if (none !== null) violations.push('a graphql call with owner but no name must not route');
    const rest = ownerFromGhArgv(['api', 'repos/plateauapp/plateau-app/issues']);
    if (rest !== 'plateauapp') violations.push('REST path routing regressed');
    return { violations };
  },
  judge(report) { return report.violations; },
};
