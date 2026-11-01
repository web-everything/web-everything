/**
 * @file breaks/card-filer-releases-dirty-lane.mjs — R310, live 2026-11-01 03:25 ET: 75 of 90 pool lanes were DIRTY with
 * nothing but leftover backlog card files, so every daemon read "0 acquirable lanes" and stalled (#6044/#6046).
 *
 * `land-prevention-card.mjs` released its lane in `finally` but never cleaned it, so a batched / held filing, or
 * any failed step, left the card in the lane's tree. FIX: the filer's `finally` leaves the lane clean before
 * release (cards saved first unless already durable), and `lane-pool.mjs release` saves and cleans a lane dirty
 * only with card files (`we:scripts/lib/lane-card-salvage.mjs`).
 *
 * Scenario: the REAL filer against a scratch pool through the REAL `lane-pool.mjs` CLI. `file-item` writes the card
 * and then times out (the forced error path). Also releases a clean lane whose status read fails: unknown dirt
 * must not become a known card-save failure that strands its lease. GREEN = clean, card saved, unknown released.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execRead, readGit } from '../../../lib/proc-read.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CARD = 'backlog/xr310ab-prevention-soak.md';

export default {
  id: 'card-filer-releases-dirty-lane',
  title: 'a card filer releases its lane with the card file still in the tree; the pool fills with dirty lanes',
  card: 'R310 (#6044/#6046)',
  fixedBy: { sha: 'HEAD', where: 'lane/card-filer-clean-lanes', paths: ['scripts/operations/land-prevention-card.mjs', 'scripts/lib/lane-card-salvage.mjs', 'scripts/lane-pool.mjs'] },
  fixPresent(root) {
    return existsSync(join(root, 'scripts/lib/lane-card-salvage.mjs'));
  },
  async run() {
    const base = mkdtempSync(join(tmpdir(), 'soak-r310-'));
    const savedSalvage = process.env.WE_LANE_SALVAGE_DIR;
    try {
      const git = (args, cwd) => readGit(args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const origin = join(base, 'origin.git'); const ref = join(base, 'reference');
      git(['init', '-q', '--bare', '--initial-branch=trunk', origin]); git(['clone', '-q', origin, ref]);
      git(['config', 'user.email', 't@t'], ref); git(['config', 'user.name', 't'], ref);
      mkdirSync(join(ref, 'backlog')); writeFileSync(join(ref, 'backlog', '1-seed.md'), 'seed\n');
      git(['add', '.'], ref); git(['commit', '-q', '-m', 'seed'], ref); git(['push', '-q', origin, 'HEAD:trunk'], ref);
      const env = { ...process.env, LANE_POOL_ROOT: join(base, 'pool'), WE_LANE_SALVAGE_DIR: join(base, 'salvage') };
      delete env.LANE_SESSION; delete env.CLAUDE_CODE_SESSION_ID;
      process.env.WE_LANE_SALVAGE_DIR = env.WE_LANE_SALVAGE_DIR;
      const pool = [`--origin=${origin}`, `--reference=${ref}`, '--name=r310pool', '--branch=trunk', '--no-install'];
      const cli = (args) => execRead('node', [join(ROOT, 'scripts/lane-pool.mjs'), ...args, ...pool], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      cli(['provision', '--count=1']);
      const { landPreventionCard } = await import(join(ROOT, 'scripts/operations/land-prevention-card.mjs'));
      let laneDir = null;
      const exec = (cmd, args) => {
        if (cmd === 'node' && /lane-pool\.mjs$/.test(args[0])) {
          const out = cli(args[1] === 'acquire' ? [...args.slice(1), '--no-reset'] : args.slice(1));
          if (args[1] === 'acquire') laneDir = JSON.parse(out).path;
          return out;
        }
        if (cmd === 'node' && args.includes('file-item')) {
          writeFileSync(join(laneDir, CARD), 'soak card\n');
          throw Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' });
        }
        throw new Error(`unexpected exec ${cmd} ${args.join(' ')}`);
      };
      await landPreventionCard({ title: 't', kind: 'story', size: '1', digest: '1. x', scope: 'we:a.mjs', parent: '', queue: 'false', session: 'soak-r310' },
        { exec, write: () => {}, dedupe: () => null, pendingDir: join(base, 'pending') });
      const violations = [];
      const left = laneDir ? git(['status', '--porcelain', '--untracked-files=all'], laneDir) : 'no lane acquired';
      if (left) violations.push({ invariant: 'released-lane-clean', detail: left });
      const index = join(base, 'salvage', 'index.jsonl');
      if (!left && !(existsSync(index) && readFileSync(index, 'utf8').includes(CARD))) violations.push({ invariant: 'card-saved', detail: 'card removed without a salvage record' });
      const unknown = JSON.parse(cli(['acquire', '--no-reset', '--session=soak-unknown', '--json']));
      const hook = join(base, 'unreadable-status.mjs');
      writeFileSync(hook, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.execFileSync;
cp.execFileSync = function(cmd, args, opts) {
  if (cmd === 'git' && opts?.cwd === ${JSON.stringify(unknown.path)} && args.includes('status')) throw new Error('forced unreadable status');
  return original.call(this, cmd, args, opts);
};
syncBuiltinESMExports();\n`);
      const release = JSON.parse(execRead('node', ['--import', hook, join(ROOT, 'scripts/lane-pool.mjs'),
        'release', `--lane=${unknown.lane}`, '--session=soak-unknown', '--json', ...pool], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
      if (release.released !== 1 || existsSync(join(unknown.path, '.git', '.lane-lease'))) {
        violations.push({ invariant: 'unknown-status-release', detail: 'a failed status read with no known cards stranded the lease' });
      }
      const raced = JSON.parse(cli(['acquire', '--no-reset', '--session=soak-old-owner', '--json']));
      writeFileSync(join(raced.path, CARD), 'replacement holder card\n');
      const leasePath = join(raced.path, '.git', '.lane-lease');
      const replacement = { ...JSON.parse(readFileSync(leasePath, 'utf8')), session: 'soak-new-owner' };
      writeFileSync(hook, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
const original = cp.execFileSync;
let reads = 0;
cp.execFileSync = function(cmd, args, opts) {
  const out = original.call(this, cmd, args, opts);
  if (cmd === 'git' && opts?.cwd === ${JSON.stringify(raced.path)} && args.includes('status') && args.includes('--untracked-files=all') && ++reads === 2)
    writeFileSync(${JSON.stringify(leasePath)}, ${JSON.stringify(JSON.stringify(replacement))});
  return out;
};
syncBuiltinESMExports();\n`);
      const raceRelease = JSON.parse(execRead('node', ['--import', hook, join(ROOT, 'scripts/lane-pool.mjs'),
        'release', `--lane=${raced.lane}`, '--session=soak-old-owner', '--json', ...pool], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
      if (raceRelease.released !== 0 || readFileSync(leasePath, 'utf8') !== JSON.stringify(replacement)
        || !existsSync(join(raced.path, CARD)) || readFileSync(join(raced.path, CARD), 'utf8') !== 'replacement holder card\n') {
        violations.push({ invariant: 'ownership-during-salvage', detail: 'a lease swap during the status recheck must preserve the replacement lease and card' });
      }
      return { violations };
    } finally {
      if (savedSalvage === undefined) delete process.env.WE_LANE_SALVAGE_DIR; else process.env.WE_LANE_SALVAGE_DIR = savedSalvage;
      rmSync(base, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations.map((v) => `${v.invariant}: ${v.detail}`); },
};
