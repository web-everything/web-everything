/** PR #5805: symbolic aliases and direct remaps of excluded ops tips must never authorize a lane reset.
 * Runs the real acquire and reclaim CLIs against disposable repositories; no network or host lanes are used.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'lane-reset-symbolic-ops-proof',
  title: 'symbolic aliases and direct remaps of excluded ops refs cannot authorize destruction of unique lane work',
  card: 'we:PR#5805',
  // The launcher creates the repair commit; later replays can supply --revert=<repair-sha>.
  fixedBy: { sha: 'HEAD', where: 'lane/lane-git-diet-fetch', paths: ['scripts/lane-pool.mjs'] },
  fixPresent(root) {
    const source = readFileSync(join(root, 'scripts/lane-pool.mjs'), 'utf8');
    const proof = /function localRemoteShas\([^]*?\n\}/.exec(source)?.[0] ?? '';
    const reclaim = /function laneReclaimPreservationProof\([^]*?\n\}/.exec(source)?.[0] ?? '';
    return proof.includes('%(symref)') && proof.includes('remote.origin.fetch') && reclaim.includes('liveRemoteShas(repo)');
  },
  async run({ root = REPO_ROOT } = {}) {
    const violations = [];
    for (const alias of ['symbolic', 'mapped', 'wildcard-mapped']) {
      const report = await runAliasCase(root, alias, { change: alias === 'symbolic' ? 'deleted' : 'moved' });
      violations.push(...report.violations.map((message) => `${alias}: ${message}`));
    }
    for (const options of [
      {}, { alias: 'symbolic', change: 'deleted', containment: 'ancestor' },
      { alias: 'mapped' }, { alias: 'wildcard-mapped', kind: 'dirty' },
      { dryRun: true }, { race: true }, { live: true },
      { live: true, containment: 'ancestor' }, { live: true, kind: 'dirty' },
      { dryRun: true, hostileRemote: 'origin' },
      { dryRun: true, hostileRemote: 'rewrite' },
      { dryRun: true, hostileRemote: 'worktree-rewrite' },
      { dryRun: true, live: true, hostileRemote: 'origin' },
      { dryRun: true, live: true, hostileRemote: 'rewrite' },
      { dryRun: true, live: true, missingOrigin: true },
    ]) {
      const report = await runReclaimCase(root, options);
      violations.push(...report.violations.map((message) => `reclaim ${JSON.stringify(options)}: ${message}`));
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};

export function runReclaimCase(root = REPO_ROOT, options = {}) {
  return runAliasCase(root, options.alias ?? 'none', { ...options, command: 'reclaim' });
}

async function runAliasCase(root, alias, { command = 'acquire', kind = 'commit', change = 'moved', containment = 'exact', dryRun = false, live = false, race = false, hostileRemote = null, missingOrigin = false } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'soak-symbolic-ops-'));
    const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      const origin = join(base, 'origin.git'), reference = join(base, 'reference'), pool = join(base, 'pool');
      git(['init', '--quiet', '--bare', '--initial-branch=trunk', origin]);
      git(['clone', '--quiet', origin, reference]);
      git(['config', 'user.email', 'test@example.com'], reference);
      git(['config', 'user.name', 'Test'], reference);
      writeFileSync(join(reference, 'work.txt'), 'seed\n');
      git(['add', 'work.txt'], reference);
      git(['commit', '--quiet', '-m', 'seed'], reference);
      git(['push', '--quiet', 'origin', 'HEAD:refs/heads/trunk'], reference);
      const bin = join(base, 'bin');
      mkdirSync(bin);
      for (const [name, source] of [['claude', '#!/bin/sh\necho "[]"\n'], ['lsof', '#!/bin/sh\nexit 0\n']]) {
        writeFileSync(join(bin, name), source);
        chmodSync(join(bin, name), 0o755);
      }
      const cli = (args, canonicalOrigin = true) => spawnSync(process.execPath, [join(root, 'scripts/lane-pool.mjs'), ...args,
        ...(canonicalOrigin ? [`--origin=${origin}`] : ['--pool=symbolic-ops']),
        `--reference=${reference}`, '--name=symbolic-ops', '--branch=trunk', '--no-install'], {
        encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: pool, PATH: `${bin}:${process.env.PATH}`, WE_LANE_SALVAGE_QUIET_MIN: '0' }, timeout: 30000, maxBuffer: 1024 * 1024,
      });
      const provision = cli(['provision', '--count=1']);
      if (provision.status !== 0) throw Error(`fixture provision failed: ${provision.stderr}`);
      const lane = join(pool, 'symbolic-ops', 'lane-1');
      git(['config', 'user.email', 'test@example.com'], lane);
      git(['config', 'user.name', 'Test'], lane);
      // The shared blob predicate trims Git output; avoid a trailing newline so the positive
      // dirty-file control exercises a preservation match rather than that conservative mismatch.
      const content = 'unique lane work';
      writeFileSync(join(lane, 'work.txt'), content);
      git(['add', 'work.txt'], lane);
      git(['commit', '--quiet', '-m', 'unique work'], lane);
      const head = git(['rev-parse', 'HEAD'], lane);
      const ops = 'refs/heads/ops/review-requests';
      const tracking = 'refs/remotes/origin/ops/review-requests';
      if (containment === 'ancestor') git(['commit', '--quiet', '--allow-empty', '-m', 'descendant'], lane);
      git(['push', '--quiet', 'origin', `HEAD:${ops}`], lane);
      git(['fetch', '--quiet', 'origin', `+${ops}:${tracking}`], lane);
      if (alias === 'symbolic') {
        git(['symbolic-ref', 'refs/remotes/origin/saved', tracking], lane);
      } else if (alias === 'mapped' || alias === 'wildcard-mapped') {
        const mapping = alias === 'mapped'
          ? `+${ops}:refs/remotes/origin/saved`
          : '+refs/heads/ops/*:refs/remotes/origin/archive/*';
        git(['config', '--add', 'remote.origin.fetch', mapping], lane);
        git(['fetch', '--quiet', 'origin', mapping], lane);
      }
      if (containment === 'ancestor') git(['reset', '--hard', '--quiet', head], lane);
      if (live) git(['push', '--quiet', 'origin', `${tracking}:refs/heads/lane/landed`], lane);
      const mutation = change === 'deleted' ? ['update-ref', '-d', ops] : ['update-ref', ops, 'refs/heads/trunk'];
      if (!race) git(mutation, origin);
      if (!live && !race && git(['for-each-ref', `--contains=${head}`, '--format=%(refname)', 'refs/heads/'], origin)) {
        throw Error('fixture work is still contained by a remote branch');
      }
      if (command === 'reclaim') {
        if (kind === 'dirty') git(['reset', '--mixed', '--quiet', 'origin/trunk'], lane);
        const beforeHead = git(['rev-parse', 'HEAD'], lane);
        const refresh = cli(['refresh', '--count=1']);
        if (refresh.status !== 0 || !refresh.stderr.includes('SKIPPED')) throw Error(`fixture refresh failed: ${refresh.stderr}`);
        const helperMarker = join(base, 'remote-helper-ran');
        const probeMarker = join(base, 'probed');
        if (hostileRemote) {
          const helper = join(base, 'remote-helper.sh');
          writeFileSync(helper, `#!/bin/sh\ntouch '${helperMarker}'\nexit 1\n`);
          const remote = `ext::sh ${helper}`;
          git(['config', 'protocol.ext.allow', 'always'], lane);
          if (hostileRemote === 'origin') git(['config', 'remote.origin.url', remote], lane);
          else {
            if (hostileRemote === 'worktree-rewrite') git(['config', 'extensions.worktreeConfig', 'true'], lane);
            git(['config', hostileRemote === 'worktree-rewrite' ? '--worktree' : '--local', `url.${remote}.insteadOf`, origin], lane);
          }
        }
        // Mutate the remote between the initial proof and the under-claim reproof.
        if (race) {
          const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
          writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
// Inspect the subcommand after transport-hardening config options, preserving argv for the real Git.
const commandArgs = args.slice();
while (commandArgs[0] === '-c') commandArgs.splice(0, 2);
if (commandArgs[0] === 'ls-remote') {
  const count = existsSync(${JSON.stringify(probeMarker)}) ? Number(readFileSync(${JSON.stringify(probeMarker)}, 'utf8')) : 0;
  writeFileSync(${JSON.stringify(probeMarker)}, String(count + 1));
  if (count > 0) {
    const changed = spawnSync(${JSON.stringify(realGit)}, ${JSON.stringify(mutation)}, { cwd: ${JSON.stringify(origin)} });
    if (changed.status !== 0) process.exit(1);
  }
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
          chmodSync(join(bin, 'git'), 0o755);
        }
        const violations = [];
        if (missingOrigin) {
          // An existing lane has an origin, but that agent-owned URL cannot supply the pool's trust anchor.
          git(['remote', 'remove', 'origin'], reference);
          const refused = cli(['reclaim', '--lane=1', '--dry-run', '--json'], false);
          if (refused.status === 0 || !/canonical origin.*--origin=/.test(refused.stderr)) {
            violations.push('origin-less pool did not report the actionable startup invariant');
          }
        }
        // Supplying the canonical origin must recover even when the reference has no origin.
        const reclaim = cli(['reclaim', '--lane=1', '--json', ...(dryRun ? ['--dry-run'] : [])]);
        if (reclaim.status !== 0) throw Error(`fixture reclaim failed: ${reclaim.stderr}`);
        const report = JSON.parse(reclaim.stdout);
        if (race && (!existsSync(probeMarker) || Number(readFileSync(probeMarker, 'utf8')) < 2)) {
          violations.push('race fixture did not observe both live preservation probes');
        }
        if (existsSync(helperMarker)) violations.push('reclaim dry-run executed a lane-controlled remote helper');
        if (live) {
          if (!(dryRun ? report.wouldReclaim : report.reclaimed)) violations.push('live non-ops proof no longer permits reclaim');
          if (readFileSync(join(lane, 'work.txt'), 'utf8') !== (dryRun ? content : 'seed\n')) violations.push('live control changed the wrong work');
        } else {
          if (report.reclaimed || report.wouldReclaim || report.preserved) violations.push('stale ops proof authorized reclaim');
          if (git(['rev-parse', 'HEAD'], lane) !== beforeHead || readFileSync(join(lane, 'work.txt'), 'utf8') !== content) violations.push('reclaim destroyed unique work');
          if (!dryRun) {
            const journal = readFileSync(join(pool, 'symbolic-ops', '.lane-journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
            const last = journal.at(-1);
            if (last.action !== 'reclaim-refused' || last.unpushed !== true) violations.push('refusal did not journal unpushed work');
          }
        }
        if (existsSync(join(lane, '.git', '.lane-lease'))) violations.push('reclaim retained its temporary claim');
        return { violations };
      }
      const acquire = cli(['acquire', '--lane=1', '--session=symbolic-ops-proof', '--hard-max=1']);
      const violations = [];
      if (acquire.status === 0 || !/would destroy that work/.test(acquire.stderr)) {
        violations.push('acquire did not refuse the stale alias proof');
      }
      if (git(['rev-parse', 'HEAD'], lane) !== head || readFileSync(join(lane, 'work.txt'), 'utf8') !== content) {
        violations.push('acquire reset unique lane work using an excluded ops alias');
      }
      return { violations };
    } finally { rmSync(base, { recursive: true, force: true }); }
}
