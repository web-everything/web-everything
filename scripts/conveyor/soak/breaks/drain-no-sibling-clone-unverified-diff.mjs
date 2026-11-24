/**
 * frontierui #53/#54/#58 (2026-11-24): the drain daemon's pool had no `../frontierui`, so the drain could not read
 * those PRs' net diff ("net diff unverified (no-clone)") and the strict hold re-added review:human on every pass,
 * right after every recorded clear-human. The hold must stay strict; the cause is the missing clone. The drain now
 * provisions the sibling itself (blobless, no checkout), and fails closed (null) when it cannot.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Run the scenario in a child node so a missing module on an unfixed tree is a plain string, synchronously. */
function scenario(root) {
  const file = join(root, 'scripts/lib/drain-sibling-clone.mjs');
  if (!existsSync(file)) return 'missing-module';
  const code = `const m = await import(${JSON.stringify(pathToFileURL(file).href)});
    const calls = [];
    const ok = m.ensureSiblingClone({ slug: 'o/frontierui', name: 'frontierui', parentDir: '/pool', localOrigin: 'git@github.com:o/we.git',
      exists: (p) => p.endsWith('.git') ? calls.length > 0 : false, rename: () => {}, exec: (c, a) => { calls.push(a); } });
    m.resetSiblingCloneFailures();
    const bad = m.ensureSiblingClone({ slug: 'o/frontierui', name: 'frontierui', parentDir: '/pool', localOrigin: 'git@github.com:o/we.git',
      exists: () => false, exec: () => { throw new Error('auth'); } });
    const a = calls[0] || [];
    process.stdout.write(JSON.stringify({ ok, bad, blobless: a.includes('--filter=blob:none') && a.includes('--no-checkout'), url: a.find((x) => /frontierui/.test(x)) }));`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export default {
  id: 'drain-no-sibling-clone-unverified-diff',
  title: 'frontierui #53: the drain had no sibling clone, so every frontierui PR was "net diff unverified (no-clone)" and re-parked review:human after each clear-human',
  card: 'CLEAR-HUMAN-NOT-STICKY (drain provisions the missing sibling clone; the unverified-diff hold stays strict)',
  fixedBy: { sha: '0000000000000000000000000000000000000000', where: 'lane/clear-human-not-sticky', paths: ['scripts/lib/drain-sibling-clone.mjs', 'scripts/merge-ai-prs.mjs'] },
  fixPresent(root) {
    try { return JSON.parse(scenario(root)).blobless === true; } catch { return false; }
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const violations = [];
    let r;
    try { r = JSON.parse(scenario(root)); } catch { r = null; }
    if (!r) violations.push('the drain has no way to provision a missing sibling clone, so its net diff stays unread');
    else {
      if (r.ok !== '/pool/frontierui') violations.push(`a missing sibling clone was not provisioned (got ${r.ok})`);
      if (!r.blobless) violations.push('the provisioned clone is not blobless/no-checkout');
      if (r.url !== 'git@github.com:o/frontierui.git') violations.push(`wrong clone url ${r.url}`);
      if (r.bad !== null) violations.push('an unreadable remote did not fail closed (must return null so the hold stays)');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
