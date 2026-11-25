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

const CHILD = `
const m = await import(process.argv[1]);
const calls = [];
const inPool = (p) => p.includes('plateau-app/.git');
const common = { slug: 'o/frontierui', name: 'frontierui', parentDir: '/pool', localOrigin: 'git@github.com:o/we.git', isGitDir: () => true, originOf: () => 'git@github.com:o/frontierui.git' };
const ok = m.ensureSiblingClone({ ...common, exists: (p) => inPool(p) || (p.endsWith('frontierui/.git') && calls.length > 0), rename: () => {}, clone: (u, t) => { calls.push([u, t]); } });
m.resetSiblingCloneFailures();
const bad = m.ensureSiblingClone({ ...common, exists: inPool, clone: () => { throw new Error('auth'); } });
m.resetSiblingCloneFailures();
const wrong = m.ensureSiblingClone({ ...common, exists: () => true, originOf: () => 'git@github.com:evil/frontierui.git' });
const dry = [];
m.resetSiblingCloneFailures();
const dryRes = m.ensureSiblingClone({ ...common, exists: inPool, dryRun: true, clone: () => { dry.push(1); } });
process.stdout.write(JSON.stringify({ ok, bad, wrong, dryClones: dry.length, dryRes, once: calls.length === 1, url: (calls[0] || [])[0] }));
`;

const MODULE = 'scripts/lib/drain-sibling-clone.mjs';

function scenario(root) {
  const file = join(root, MODULE);
  if (!existsSync(file)) return 'missing-module';
  return execFileSync(process.execPath, ['--input-type=module', '-e', CHILD, pathToFileURL(file).href], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, WE_DRAIN_SIBLING_CLONE: 'on' } }).trim();
}

export default {
  id: 'drain-no-sibling-clone-unverified-diff',
  title: 'frontierui #53: the drain had no sibling clone, so every frontierui PR was "net diff unverified (no-clone)" and re-parked review:human after each clear-human',
  card: 'CLEAR-HUMAN-NOT-STICKY (drain provisions the missing sibling clone; the unverified-diff hold stays strict)',
  fixedBy: { sha: '53f5c44e27b20e55eba03e96483f6dd61ebdbfc8', where: 'lane/clear-human-not-sticky', paths: ['scripts/lib/drain-sibling-clone.mjs', 'scripts/merge-ai-prs.mjs'] },
  fixPresent(root) {
    // Declared by the module's presence alone (it exports the provisioning entry point): never by the scenario's outcome,
    // so a regression that makes the scenario throw or misbehave stays a REQUIRED failure, not an expected one.
    if (!existsSync(join(root, MODULE))) return false;
    try { return execFileSync(process.execPath, ['--input-type=module', '-e', 'const m = await import(process.argv[1]); process.stdout.write(String(typeof m.ensureSiblingClone === \'function\'))', pathToFileURL(join(root, MODULE)).href], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) === 'true'; } catch { return false; }
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const violations = [];
    let r;
    try { r = JSON.parse(scenario(root)); } catch { r = null; }
    if (!r) violations.push('the drain has no way to provision a missing sibling clone, so its net diff stays unread');
    else {
      if (r.ok !== '/pool/frontierui') violations.push(`a missing sibling clone was not provisioned (got ${r.ok})`);
      if (!r.once) violations.push('a missing sibling clone was not attempted exactly once');
      if (r.url !== 'git@github.com:o/frontierui.git') violations.push(`wrong clone url ${r.url}`);
      if (r.wrong !== null) violations.push('a sibling clone whose origin is another owner was trusted');
      if (r.dryClones !== 0 || r.dryRes !== null) violations.push('dry-run provisioned a clone');
      if (r.bad !== null) violations.push('an unreadable remote did not fail closed (must return null so the hold stays)');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
