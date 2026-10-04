/**
 * @file breaks/drain-app-token-pinned-to-one-org.mjs - live break, 2026-10-03 23:17Z. After the org move each
 * constellation repo has its OWN GitHub App installation. `github-app-auth-env.mjs#ensureFreshGithubAppEnv`
 * minted ONE token at start and pinned it as `process.env.GH_TOKEN`; the drain sweeps all three repos in one
 * process, so that web-everything token made `gh pr list --repo frontier-ui/frontierui` fail ("Could not resolve
 * to a Repository") and the pass died: nothing merged in any repo.
 *
 * Fix: `ensureFreshGithubAppEnv({ perOwner: true })` (what the drain now passes) pins no GH_TOKEN, keeps a token
 * cached per owner, and routes `gh` through the shim, which picks the token by each call's target repo owner.
 *
 * Scenario: the fixture replays the drain's startup against a fake GitHub (a token only resolves its own owner's
 * repos) and lists all three repos. RED = any owner's call fails. The red-green proof reverts the fix commit's
 * change to `github-app-auth-env.mjs`, which ignores `perOwner` and pins the single token again.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSoak } from '../soak.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/multi-org-gh-probe.mjs', import.meta.url));

export default {
  id: 'drain-app-token-pinned-to-one-org',
  title: 'the drain pinned ONE org installation token as GH_TOKEN, so gh calls for the other orgs\' repos failed and the whole pass died',
  card: 'fix-app-auth-multi-org (follow-up to #3854)',
  fixedBy: {
    sha: '487f90ab6',
    where: 'lane/fix-app-auth-multi-org',
    paths: ['scripts/lib/github-app-auth-env.mjs'],
  },
  fixPresent(root) {
    try {
      return /perOwner/.test(readFileSync(join(root, 'scripts/lib/github-app-auth-env.mjs'), 'utf8'));
    } catch {
      return false;
    }
  },
  async run({ log } = {}) {
    return runSoak({
      name: 'break:drain-app-token-pinned-to-one-org',
      rounds: 1,
      mainEvery: 0,
      fleet: false,
      log,
      setup() { return {}; },
      async perRound(w, round, ctx, api) {
        if (round !== 0) return;
        const work = join(w.root, 'multi-org-probe');
        mkdirSync(work, { recursive: true });
        const res = spawnSync(process.execPath, [
          FIXTURE,
          join(w.simCloneRoot, 'scripts/lib/github-app-auth-env.mjs'),
          join(w.simCloneRoot, 'scripts/lib/gh-app-shim.mjs'),
          work,
        ], { encoding: 'utf8', env: { ...w.env, HOME: work } });
        let calls = null;
        try { calls = JSON.parse((res.stdout || '').trim() || 'null'); } catch { /* handled below */ }
        if (!Array.isArray(calls)) {
          api.violation('multi-org-gh-failed', `probe did not run: ${(res.stderr || res.stdout || '').trim().split('\n')[0]}`);
          return;
        }
        for (const c of calls) {
          api.say(`r00 gh pr list --repo ${c.slug} -> exit ${c.status}${c.stderr ? ` (${c.stderr})` : ''}`);
          if (c.status !== 0) api.violation('multi-org-gh-failed', `gh pr list --repo ${c.slug} failed under the drain's auth: ${c.stderr}`);
        }
      },
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => v.invariant === 'multi-org-gh-failed')
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
