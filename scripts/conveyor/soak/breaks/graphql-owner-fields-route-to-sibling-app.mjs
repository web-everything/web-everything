/** GraphQL target fields must select the sibling App and refuse ambiguous targets. */
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SHIM = 'scripts/lib/gh-app-shim.mjs';

export default {
  id: 'graphql-owner-fields-route-to-sibling-app',
  title: 'GraphQL owner fields route to the sibling App and uncertain fields refuse auth',
  card: 'GraphQL owner field routing incident',
  fixedBy: { sha: 'HEAD', where: 'working tree', paths: [SHIM, 'scripts/lib/github-app-installations.mjs'] },
  // Behaviour decides the verdict: keep this present when the routing regresses.
  fixPresent: root => existsSync(join(root, SHIM)),
  async run({ sourceRoot = ROOT, log } = {}) {
    const { renderGhShimScript } = await import(pathToFileURL(join(sourceRoot, SHIM)).href);
    const dir = mkdtempSync(join(tmpdir(), 'soak-graphql-owner-'));
    const violations = [];
    try {
      const realGh = join(dir, 'real-gh');
      writeFileSync(realGh, '#!/usr/bin/env node\nconsole.log(process.env.GH_TOKEN);\n', { mode: 0o755 });
      const cachePath = join(dir, 'cache.json');
      for (const [id, token] of [['167639975', 'sibling'], ['167640002', 'checkout']]) {
        writeFileSync(join(dir, 'cache.' + id + '.json'), JSON.stringify({ v: 2, installationId: id, token,
          expiresAt: new Date(Date.now() + 3600e3).toISOString() }));
      }
      const shim = join(dir, 'shim.cjs');
      writeFileSync(shim, renderGhShimScript({ realGhPath: realGh, cachePath,
        ghThrottleCliPath: join(dir, 'missing-throttle.mjs') }));
      const cases = [
        ['sibling', ['-f', 'query=query { repository(owner:$owner,name:$name) { id } }', '-F', 'owner=plateauapp', '-F', 'name=plateau-app'], 'sibling'],
        ['file owner', ['-Fowner=@owner.txt', '-Fname=plateau-app'], null],
        ['conflicting owners', ['-fowner=plateauapp', '-fowner=frontier-ui', '-fname=plateau-app'], null],
        ['different name/repo', ['-fowner=plateauapp', '-fname=plateau-app', '-Frepo=other'], null],
        ['no owner', ['-fquery=query { viewer { login } }'], 'checkout'],
      ];
      for (const [label, args, expected] of cases) {
        const result = spawnSync(process.execPath, [shim, 'api', 'graphql', ...args], {
          cwd: dir, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
          env: { ...process.env, HOME: dir, GH_REPO: 'web-everything/web-everything', GH_TOKEN: 'personal',
            WE_GH_DAEMON_CALLER: '', XPC_SERVICE_NAME: '', WE_GH_AUTH_PERSONAL_FALLBACK: '' },
        });
        const ok = !result.error && (expected
          ? result.status === 0 && result.stdout.trim() === expected
          : result.status === 1 && result.stdout === '' && result.stderr.includes('REFUSING personal-auth fallback: unresolved GraphQL'));
        log?.(label + ': ' + (ok ? 'ok' : 'failed'));
        if (!ok) violations.push(label + ': GraphQL installation routing/refusal failed');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations,
};
