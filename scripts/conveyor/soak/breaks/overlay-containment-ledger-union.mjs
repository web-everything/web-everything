/** R1048: a strict superset and independent shared-ledger additions must admit automatically. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBareOrigin } from '../../../operations/__tests__/helpers/real-repo.mjs';
import { addOverlay, readOverlays, cloneKey } from '../../../lib/daemon-overlays.mjs';
import { resolveAdvisoryConflicts } from '../../../lib/daemon-rebuild/advisory-merge.mjs';
import { supersededOverlays } from '../../../lib/daemon-rebuild/plan.mjs';
import { REBUILD_IDENTITY_ENV } from '../../../lib/daemon-rebuild/shared.mjs';

const SOURCE = 'scripts/lib/daemon-rebuild/plan.mjs';
const CLI = fileURLToPath(new URL('../../../daemon-overlay.mjs', import.meta.url));
const TESTING = 'docs/agent/testing.md';
const TIMINGS = 'scripts/ci/test-timings.json';
const INDEX = 'scripts/conveyor/soak/breaks/index.mjs';
const ledgers = name => ({
  [TESTING]: `# Tests\n${name ? `- ${name}\n- shared\n` : ''}`,
  [TIMINGS]: JSON.stringify({ unit: name ? { [name]: 1 } : {}, soak: {} }) + '\n',
  [INDEX]: `/**\n * Registry.\n${name ? ` * ${name}\n` : ''} */\nexport const breaks = [];\n`,
});

export default {
  id: 'overlay-containment-ledger-union',
  title: 'contained overlays supersede and additive shared ledgers union without retirement',
  card: 'R1048',
  fixedBy: { sha: 'working-tree', where: 'R1048', paths: [SOURCE, 'scripts/lib/daemon-rebuild/advisory-merge.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes('export function supersededOverlays')
      && readFileSync(join(root, 'scripts/lib/daemon-rebuild/advisory-merge.mjs'), 'utf8').includes("path === 'docs/agent/testing.md'");
  },
  async run() {
    const problems = [];
    await withBareOrigin(async f => {
      const env = { ...process.env, TMPDIR: f.tmp, WE_DAEMON_OVERLAY_DIR: join(f.tmp, 'overlays'),
        WE_DAEMON_OVERLAY_STACK_BASES: '{}', WE_DAEMON_OVERLAY_EDGE_RESOLVE: '1',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
      f.seedOriginBranch('main', ledgers(''));
      f.seedOriginBranch('lane/old', ledgers('ours'));
      f.seedOriginBranch('lane/peer', ledgers('theirs'));
      f.seedOriginBranch('lane/new', { 'new.txt': 'superset\n' }, 'lane/old');
      const sha = ref => f.git(['rev-parse', ref], { cwd: f.origin }).trim();
      // Supersession must not borrow the no-adopted-history audit exemption.
      env.WE_FIX_READY_PATH = join(f.tmp, 'ready.jsonl');
      writeFileSync(env.WE_FIX_READY_PATH, JSON.stringify({ ref: 'lane/old', sha: sha('lane/old'), tests: 'green', audit: 'NOT WEAKENED' }) + '\n');
      addOverlay(f.clone, { ref: 'lane/old' }, { env });
      addOverlay(f.clone, { ref: 'lane/peer' }, { env });
      const result = spawnSync(process.execPath, [CLI, 'add', `--clone=${f.clone}`, '--ref=lane/new', '--pr=7118',
        `--expected-sha=${sha('lane/new')}`, '--json'], {
        cwd: resolve(fileURLToPath(new URL('../../../..', import.meta.url))),
        env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
      });
      if (result.status !== 0) problems.push(`superset/ledger add refused: ${result.stderr}`);
      const refs = readOverlays(f.clone, { env }).map(o => o.ref).sort();
      if (JSON.stringify(refs) !== JSON.stringify(['lane/new', 'lane/peer'])) problems.push('superseded registry still retained the old entry');
      try {
        const events = readFileSync(join(env.WE_DAEMON_OVERLAY_DIR, `${cloneKey(f.clone)}.events.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
        if (!events.some(e => e.kind === 'overlay-superseded' && e.oldTip === sha('lane/old') && e.newTip === sha('lane/new'))) problems.push('missing supersession event and tips');
      } catch { problems.push('missing supersession audit trail'); }

      f.seedOriginBranch('lane/destructive', { [TESTING]: '# Changed\nreplacement\n' });
      const git = (args, opts = {}) => spawnSync('git', args, { ...opts, cwd: f.origin,
        env: { ...env, ...opts.env }, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
      if (resolveAdvisoryConflicts({ git, cur: sha('lane/old'), ovSha: sha('lane/destructive') }) !== null) problems.push('non-additive testing edit resolved');
      for (const [name, line] of [['fence', '```'], ['comment', '<!--'], ['heading', '# Disabled']]) {
        f.seedOriginBranch(`lane/${name}`, { [TESTING]: `# Tests\n${line}\n` });
        if (resolveAdvisoryConflicts({ git, cur: sha('lane/old'), ovSha: sha(`lane/${name}`) }) !== null) problems.push(`unsafe ${name} insertion resolved`);
      }

      // The old head was actually adopted before its registration was force-pushed.
      f.git(['fetch', 'origin']);
      const old = sha('lane/old');
      const build = f.git(['commit-tree', `${old}^{tree}`, '-p', sha('main'), '-p', old,
        '-m', 'daemon-rebuild: merge overlay lane/old onto main'], { env: { ...env, ...REBUILD_IDENTITY_ENV } }).trim();
      f.git(['update-ref', 'HEAD', build]);
      f.seedOriginBranch('lane/old', { 'rewritten.txt': 'rewritten\n' });
      f.seedOriginBranch('lane/new', { 'new.txt': 'superset of current tip only\n' }, 'lane/old');
      f.git(['fetch', 'origin']);
      const cloneGit = args => spawnSync('git', args, { cwd: f.clone, env,
        encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
      if (supersededOverlays(cloneGit, [{ ref: 'lane/old' }], sha('main'), sha('lane/new')).length) problems.push('force-pushed registration lost its adopted head');
    });
    return { problems };
  },
  judge(report) { return report.problems; },
};
