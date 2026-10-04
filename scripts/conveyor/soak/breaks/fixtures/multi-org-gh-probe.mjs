#!/usr/bin/env node
/**
 * @file fixtures/multi-org-gh-probe.mjs - soak fixture for `breaks/drain-app-token-pinned-to-one-org.mjs`.
 * Plays the drain's startup: calls the REAL `ensureFreshGithubAppEnv` (from the tree under test) the way
 * `merge-ai-prs.mjs` does, with only the GitHub mint faked, then makes `gh pr list --repo <owner>/<repo>` calls
 * for all three constellation owners through whatever `gh` the resulting env resolves. The fake real `gh` behaves
 * like GitHub: a token only resolves repos of the owner whose installation minted it.
 *
 * argv: <github-app-auth-env.mjs path> <gh-app-shim.mjs path> <workdir>
 * Prints one JSON line: [{ slug, status, stderr }].
 */
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CONSTELLATION_REPOS } from '../../../../lib/constellation-repos.mjs';

const [, , authEnvPath, shimModPath, work] = process.argv;
const OWNERS = { 'web-everything': '167640002', 'frontier-ui': '167639957', plateauapp: '167639975' };
const byId = Object.fromEntries(Object.entries(OWNERS).map(([o, id]) => [id, o]));

const FAKE_GH = `#!/usr/bin/env node
const a = process.argv.slice(2);
const slug = a.includes('--repo') ? a[a.indexOf('--repo') + 1] : '';
const tok = process.env.GH_TOKEN || '';
if (tok && tok !== 'tok-' + slug.split('/')[0]) { process.stderr.write("GraphQL: Could not resolve to a Repository with the name '" + slug + "'.\\n"); process.exit(1); }
process.stdout.write('[]');
`;

async function main() {
  const { ensureFreshGithubAppEnv } = await import(pathToFileURL(authEnvPath).href);
  const { renderGhShimScript } = await import(pathToFileURL(shimModPath).href);
  const realDir = join(work, 'real-bin');
  const shimDir = join(work, 'shim-bin');
  mkdirSync(realDir, { recursive: true }); mkdirSync(shimDir, { recursive: true });
  const realGh = join(realDir, 'gh');
  writeFileSync(realGh, FAKE_GH); chmodSync(realGh, 0o755);
  const cachePath = join(work, 'cache', 'web-everything.json');
  const exp = new Date(Date.now() + 3600e3).toISOString();
  const env = {
    HOME: work, PATH: `${realDir}:${process.env.PATH}`,
    WE_GITHUB_APP_ID: '1', WE_GITHUB_APP_INSTALLATION_ID: OWNERS['web-everything'], WE_GITHUB_APP_PRIVATE_KEY_PATH: join(work, 'k.pem'),
  };
  await ensureFreshGithubAppEnv({
    env, cachePath, statusPath: join(work, 'status.json'), log: { error() {} },
    mint: async ({ installationId }) => ({ token: `tok-${byId[installationId]}`, expiresAt: exp, permissions: { metadata: 'read', pull_requests: 'write', issues: 'write', contents: 'write', workflows: 'write', checks: 'read', statuses: 'read', actions: 'read' } }),
    getInstallationInfo: async () => ({ repositorySelection: 'all' }),
    // Only the drain's own opt-in flag differs between old and new code; the shim install is the real renderer.
    perOwner: true,
    installShim: async () => {
      const shim = join(shimDir, 'gh');
      writeFileSync(shim, renderGhShimScript({ realGhPath: realGh, cachePath, ghThrottleCliPath: join(work, 'missing-throttle.mjs') }));
      chmodSync(shim, 0o755);
      env.PATH = `${shimDir}:${env.PATH}`;
      return { ok: true };
    },
  });
  const out = [];
  for (const { slug } of Object.values(CONSTELLATION_REPOS)) {
    const r = spawnSync('gh', ['pr', 'list', '--repo', slug], { env, encoding: 'utf8', cwd: work });
    out.push({ slug, status: r.status, stderr: (r.stderr || '').trim().split('\n')[0] });
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
main().catch((e) => { process.stderr.write(`multi-org-gh-probe: ${String((e && e.stack) || e)}\n`); process.stdout.write('null\n'); process.exitCode = 1; });
