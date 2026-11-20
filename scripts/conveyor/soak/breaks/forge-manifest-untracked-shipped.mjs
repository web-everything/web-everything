import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { buildManifest } from '../../../readiness/remote-exec.mjs';

export default {
  id: 'forge-manifest-untracked-shipped',
  title: 'tracked Forge manifests refuse untracked and dirty bytes with local fallback',
  card: 'S1 tracked-at-HEAD security boundary',
  fixedBy: { sha: 'HEAD', where: 'S1', paths: ['scripts/readiness/remote-exec.mjs'] },
  fixPresent() { return true; },
  async run() {
    const root = await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR, 'soak-forge-tracked-')));
    const cwd = join(root, 'repo'), violations = [];
    const env = { ...process.env, FORGE_MANIFEST_REFUSALS_LOG: join(root, 'refusals.jsonl') };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const git = args => {
      const result = spawnSync('git', args, { cwd, env, maxBuffer: 1024 * 1024 });
      if (result.status !== 0) throw new Error(result.stderr.toString());
    };
    const build = () => buildManifest({ cwd, env, manifestMode: 'tracked' });
    const refused = async reason => {
      try { await build(); violations.push(`${reason} bytes were admitted`); }
      catch (error) {
        if (error.code !== reason || !error.message.includes('use local fallback')) violations.push(`missing ${reason} local fallback`);
      }
    };
    try {
      await fs.mkdir(cwd); git(['init', '-q']);
      await fs.writeFile(join(cwd, 'clean.txt'), 'clean'); git(['add', '.']);
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
      const manifest = await build();
      if (manifest.entries.length !== 1 || !manifest.entries[0].tracked) violations.push('clean tracked blob was not admitted');
      await fs.writeFile(join(cwd, 'scratch.txt'), 'untracked');
      await fs.writeFile(join(cwd, 'clean.txt'), 'dirty');
      await refused('untracked');
      await fs.unlink(join(cwd, 'scratch.txt')); await refused('dirty');
      await fs.writeFile(join(cwd, 'clean.txt'), 'clean');
      if ((await build()).manifestDigest !== manifest.manifestDigest) violations.push('restored clean manifest changed');
      return { violations };
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
