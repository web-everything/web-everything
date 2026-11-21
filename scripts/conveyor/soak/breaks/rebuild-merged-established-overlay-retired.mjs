/** A pr:null snapshot already carried by the live build conflicts after its PR lands on main.
 * Reuse the real-git shape of daemon-rebuild-auto-retire-merged.test.mjs: the snapshot and
 * squash have different identities, and main subsequently rewrites the same file.
 * Unknown proof must hold; guarded pr-merged retirement must clear the only lost overlay.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const REBUILD = 'scripts/lib/daemon-rebuild.mjs';
const PREPARE = 'scripts/lib/daemon-rebuild/prepare.mjs';
// fixPresent is synchronous. The child runs this exact scenario against the requested tree,
// including prepareRebuild through rebuildClone, rather than inspecting source markers.
const PROBE = `
const { default: b } = await import(process.argv[1]);
const report = await b.run({ sourceRoot: process.argv[2] });
process.stdout.write(JSON.stringify(b.judge(report)));
`;

export default {
  id: 'rebuild-merged-established-overlay-retired',
  title: 'a merged pr:null established overlay retires instead of holding the rebuild on conflict',
  card: 'merged established-overlay retirement before conflict hold',
  fixedBy: { sha: '49cc87912e3', where: 'main', paths: [PREPARE] },
  fixPresent(root) {
    const result = spawnSync(process.execPath,
      ['--input-type=module', '-e', PROBE, import.meta.url, resolve(root)],
      { env: process.env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    return result.status === 0 && result.stdout.trim() === '[]';
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const violations = [];
    let scratch;
    const check = (ok, invariant, detail) => {
      if (!ok) violations.push({ invariant, detail });
    };
    try {
      const { rebuildClone, readRebuildState } = await import(pathToFileURL(resolve(sourceRoot, REBUILD)).href);
      const { addOverlay, readOverlays } = await import(pathToFileURL(resolve(sourceRoot, 'scripts/lib/daemon-overlays.mjs')).href);
      const { retireRegistration } = await import(pathToFileURL(resolve(sourceRoot, 'scripts/daemon-overlay.mjs')).href);
      if (!process.env.TMPDIR) throw new Error('TMPDIR is required for the soak fixture');
      scratch = mkdtempSync(join(process.env.TMPDIR, 'we-merged-established-soak-'));
      const author = join(scratch, 'author'), root = join(scratch, 'clone');
      const env = { ...process.env,
        WE_DAEMON_STATE_DIR: join(scratch, 'state'),
        WE_DAEMON_CLONE_LOCK_ROOT: join(scratch, 'locks'),
        WE_DAEMON_OVERLAY_DIR: join(scratch, 'overlays'),
        WE_DAEMON_REBUILD_SKIP_UNRELATED: '0', WE_DAEMON_AUTO_REBASE: '0', WE_OVERLAY_STALE: '0',
      };
      const git = (cwd, args) => {
        const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t',
          '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
        { cwd, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
        if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${result.stderr}`);
        return result.stdout.trim();
      };
      // A local author repository is origin, so fixture setup needs no network or push.
      mkdirSync(author);
      git(author, ['init', '-q', '-b', 'main']);
      const commit = (files, message) => {
        for (const [file, content] of Object.entries(files)) writeFileSync(join(author, file), content);
        git(author, ['add', '.']);
        git(author, ['commit', '-qm', message]);
        return git(author, ['rev-parse', 'HEAD']);
      };
      const initial = commit({ 'worker.txt': 'initial\n' }, 'initial');
      git(scratch, ['clone', '-q', '-b', 'main', author, root]);
      const ref = 'lane/worker-m1';
      git(author, ['checkout', '-qb', ref]);
      const tip = commit({ 'worker.txt': 'PR change\n', 'snapshot.txt': 'baseline change\n' }, 'snapshot');
      addOverlay(root, { ref, pr: null }, { env });
      let smokeCalls = 0;
      const options = { root, env, asJob: false, prState: async () => 'OPEN',
        prBaseChain: () => [], log: { error() {} },
        runSmoke: async () => { smokeCalls++; return { verdict: 'pass', attempts: 1, smoke: { results: [] } }; },
      };
      const established = await rebuildClone(options);
      if (established.adopted !== true) throw new Error(`fixture did not establish overlay: ${JSON.stringify(established)}`);
      const liveHead = git(root, ['rev-parse', 'HEAD']);
      git(author, ['checkout', '-qB', 'main', initial]);
      commit({ 'worker.txt': 'PR change\n' }, 'squash merged PR');
      commit({ 'snapshot.txt': 'baseline change\n' }, 'baseline catches up');
      commit({ 'worker.txt': 'main subsequent rewrite\n' }, 'rewrite after merge');
      smokeCalls = 0;

      let refusedProofCalls = 0;
      const refused = await rebuildClone({ ...options, deps: {
        prove: () => { refusedProofCalls++; return { action: 'keep', reason: 'not-proved', tip }; },
      } });
      check(refused.reason === 'established-overlay-conflict', 'unknown-proof-holds', JSON.stringify(refused));
      check(refusedProofCalls === 1 && readOverlays(root, { env }).length === 1,
        'unknown-proof-keeps-registration', `proof calls=${refusedProofCalls}`);
      check(readRebuildState(root, env).held?.reason === 'established-overlay-conflict',
        'unknown-proof-persists-hold', 'unproved lost overlay must keep the live-build hold');

      let retirementCalls = 0, proofCalls = 0;
      const retired = await rebuildClone({ ...options, deps: {
        retireRegistration: async (args) => { retirementCalls++; return retireRegistration(args); },
        tip: () => tip,
        prove: (entry) => {
          proofCalls++;
          check(entry.ref === ref && entry.pr === null, 'snapshot-proof-input', JSON.stringify(entry));
          return { action: 'retire', reason: 'pr-merged', tip,
            evidence: { prState: 'MERGED', prVia: 'merge-ref-base', contentInMain: true } };
        },
      } });
      log?.(`merged snapshot rebuild -> ${retired.reason}`);
      check(retired.reason === 'established-overlay-retired' && retired.moved === false
        && JSON.stringify(retired.refs) === JSON.stringify([ref]), 'merged-overlay-retires', JSON.stringify(retired));
      check(retirementCalls === 1 && proofCalls === 1, 'guarded-retirement-used',
        `retirement calls=${retirementCalls}, proof calls=${proofCalls}`);
      check(readOverlays(root, { env }).length === 0, 'merged-registration-removed', 'merged snapshot must be unregistered');
      check((readRebuildState(root, env).held ?? null) === null, 'merged-hold-cleared', 'retirement must clear the previous conflict hold');
      check(smokeCalls === 0 && git(root, ['rev-parse', 'HEAD']) === liveHead,
        'stale-plan-not-applied', `smoke calls=${smokeCalls}; live HEAD must remain unchanged`);
      const next = await rebuildClone(options);
      check(next.adopted === true, 'next-rebuild-adopts', JSON.stringify(next));
    } catch (error) {
      violations.push({ invariant: 'scenario-error', detail: String(error?.message ?? error) });
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
    return { violations };
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
