/** PR #6882: one-shot rebuild callers must not register themselves as daemon boots. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rebuildClone } from '../../../lib/daemon-rebuild/rebuild.mjs';
import { openProbation, readProbation } from '../../../lib/daemon-rebuild/probation.mjs';
import { writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';

export default {
  id: 'probation-caller-ownership',
  title: 'one-shot rebuilds preserve boot evidence until an opted-in daemon starts',
  card: 'PR #6882 send-back items 1 and 2',
  fixedBy: { sha: 'HEAD', where: 'lane/blue-green-s2-probation-r928',
    paths: ['scripts/lib/daemon-rebuild/rebuild.mjs', 'scripts/lib/daemon-rebuild.mjs', 'scripts/lib/daemon-self-sync.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/rebuild.mjs'), 'utf8').includes('options.probation === true');
  },
  async run({ log } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'soak-probation-callers-'));
    const violations = [];
    try {
      const sha = 'b'.repeat(40), prevHead = 'a'.repeat(40), at = Date.now();
      for (const [name, shape] of [
        ['builder', { entries: ['scripts/worker.mjs'], mainOnly: false }],
        ['overlay-cli', { mainOnly: false, admissionWaitMs: 20 }],
        ['daemon', { probation: true }],
      ]) {
        const root = join(base, name);
        mkdirSync(root);
        const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'),
          WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'), WE_DAEMON_EVENTS: join(root, 'events.jsonl'),
          WE_DAEMON_AUTO_REBASE: '0' };
        const options = { root, env, versions: null, asJob: false, skipCheck: null,
          now: () => at + 1000, processStartMs: at + 500, readHead: () => sha, intervalMs: 5,
          log: { error() {} }, emitEvent() {}, lockOpts: { waitMs: 20, pollMs: 1 },
          // An unreadable repository is a real terminal rebuild path. No Git or network IO
          // is needed to prove that the wrapper must preserve boot ownership.
          run(args) {
            if (['symbolic-ref', 'rev-parse', 'status', 'show-ref'].includes(args[0])) return { status: 1, stdout: '', stderr: '' };
            throw new Error(`Unexpected Git operation: ${args[0]}`);
          } };
        writeRebuildState(root, {}, env);
        if (!openProbation({ root, env, sha, prevHead, inputsKey: 'candidate', mainSha: sha, applied: [], now: () => at })) {
          throw new Error('Could not seed probation');
        }
        const before = readProbation(root, env);
        const result = await rebuildClone({ ...options, ...shape });
        if (result.reason !== 'not-on-main') violations.push(`${name}: unexpected rebuild result ${result.reason}`);
        const after = readProbation(root, env);
        if (name === 'daemon') {
          if (after?.boots !== 1 || after?.bootPid !== process.pid || after?.bootedAt !== new Date(at + 500).toISOString()) {
            violations.push('opted-in daemon did not register its boot');
          }
        } else if (JSON.stringify(after) !== JSON.stringify(before)) {
          violations.push(`${name} changed probation boot evidence: boots=${after?.boots}, bootPid=${after?.bootPid}`);
        }
        log?.(`${name}: boots=${after?.boots}, bootPid=${after?.bootPid ?? 'absent'}`);
      }
    } catch (error) { violations.push(error.message); }
    finally {
      rmSync(base, { recursive: true, force: true });
      // A real armed watch retires on the next interval after its fixture disappears.
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return { violations };
  },
  judge: report => report.violations,
};
