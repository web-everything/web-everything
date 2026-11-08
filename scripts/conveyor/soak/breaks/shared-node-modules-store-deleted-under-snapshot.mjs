/** PR #6493: a node_modules store another snapshot links to must not be deleted when a second source (same npm lock,
 *  different pnpm inputs) asks for the same store key. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNodeModulesStore, linkNodeModules, snapshotsRoot } from '../../../lib/daemon-job-snapshots.mjs';
import { ensureStoreGeneration, lockHash } from '../../../lib/lane-deps-installer.mjs';

const SOURCE = 'scripts/lib/daemon-job-snapshots.mjs';

export default {
  id: 'shared-node-modules-store-deleted-under-snapshot',
  title: 'a store a running snapshot links to survives another source with different pnpm inputs',
  card: 'PR #6493',
  fixedBy: { sha: 'HEAD', where: 'lane/pnpm-daemon-rebuilds', paths: [SOURCE] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes('export function storeInUse');
  },
  async run({ log } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-shared-store-'));
    const saved = process.env.WE_PNPM_STORE_DIR;
    try {
      const storeDir = join(dir, 'pnpm-store');
      process.env.WE_PNPM_STORE_DIR = storeDir;
      ensureStoreGeneration(storeDir);
      const target = join(storeDir, 'esbuild');
      mkdirSync(target);
      const jobsDir = join(dir, 'jobs');
      const sourceDir = join(dir, 'src');
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, 'package.json'), '{}');
      writeFileSync(join(sourceDir, 'package-lock.json'), '{"lockfileVersion":3}');
      writeFileSync(join(sourceDir, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
      writeFileSync(join(sourceDir, 'pnpm-workspace.yaml'), 'allowBuilds:\n  esbuild: true\n');
      let installs = 0;
      const install = (into) => {
        installs += 1;
        for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) copyFileSync(join(sourceDir, name), join(into, name));
        mkdirSync(join(into, 'node_modules'));
        symlinkSync(target, join(into, 'node_modules', 'esbuild'), 'dir');
        writeFileSync(join(into, '.we-deps-marker'), `pnpm:${lockHash(into, 'pnpm', storeDir)}`);
      };
      const violations = [];
      const first = ensureNodeModulesStore({ jobsDir, sourceDir, install });
      const snapshot = join(snapshotsRoot(jobsDir), 'code', 'running-sha');
      mkdirSync(snapshot, { recursive: true });
      const link = linkNodeModules(snapshot, first.dir); // a running job's pinned snapshot
      writeFileSync(join(first.dir, 'running-job-sentinel'), 'in use');
      writeFileSync(join(sourceDir, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\nanother-commit: true\n');
      const second = ensureNodeModulesStore({ jobsDir, sourceDir, install });
      if (!existsSync(join(first.dir, 'running-job-sentinel'))) violations.push('the store a running snapshot links to was deleted');
      if (!existsSync(join(link, 'esbuild'))) violations.push("the running snapshot's node_modules links no longer resolve");
      if (!existsSync(join(second.dir, 'node_modules', 'esbuild'))) violations.push('the second source got no usable store');
      if (installs !== 2) violations.push(`expected exactly 2 installs, saw ${installs}`);
      log?.(`stores: ${first.key} / ${second.key}; ${violations.length} violations`);
      return { violations, first: first.key, second: second.key };
    } finally {
      if (saved === undefined) delete process.env.WE_PNPM_STORE_DIR; else process.env.WE_PNPM_STORE_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations; },
};
