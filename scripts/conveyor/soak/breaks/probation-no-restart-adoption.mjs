/** PR #6882: a documentation adoption kept ticking but probation demanded a fresh boot and rolled it back.
 * Exercise the real self-sync restart gate, persisted probation and synchronous tick boundary without Git IO.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSelfSync } from '../../../lib/daemon-self-sync.mjs';
import { cloneKeyOf } from '../../../lib/daemon-last-good.mjs';
import { writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';
import { checkProbationAtTick, openProbation, readProvenGood, writeProvenGood } from '../../../lib/daemon-rebuild/probation.mjs';

export default {
  id: 'probation-no-restart-adoption',
  title: 'documentation-only adoptions prove continued liveness without demanding a restart',
  card: '5726 / PR #6882 send-back item 1',
  fixedBy: { sha: 'HEAD', where: 'lane/blue-green-s2-probation-r928',
    paths: ['scripts/lib/daemon-self-sync.mjs', 'scripts/lib/daemon-rebuild/probation.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-self-sync.mjs'), 'utf8')
      .includes("if (d.reason === 'no-imported-change') noRestartSha =");
  },
  async run({ log } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'soak-probation-no-restart-'));
    const violations = [];
    try {
      for (const sibling of [false, true]) {
        const root = join(base, sibling ? 'sibling' : 'adopter');
        mkdirSync(root);
        const state = join(root, 'state');
        const env = { ...process.env, WE_DAEMON_STATE_DIR: state, WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'),
          WE_DAEMON_PROBATION_MS: '1000', WE_DAEMON_EVENTS: join(root, 'events.jsonl') };
        const before = 'a'.repeat(40), after = 'b'.repeat(40);
        const adoption = Date.parse('2026-11-15T12:00:00Z');
        let now = adoption, head = before, restarts = 0;
        const opts = { root, env, now: () => now, readHead: () => head,
          run: () => ({ status: 0, stdout: head }), emit: () => {}, log: { error() {} } };
        const key = cloneKeyOf(root);
        const tickFile = join(state, `${key}.ticks.worker.json`);
        const marker = join(state, `${key}.rollback-requested.json`);
        const wrapped = withSelfSync({ tickOnce() {
          writeFileSync(tickFile, JSON.stringify({ pid: process.pid, head, lastTickDoneAt: new Date(++now).toISOString() }));
          return 'ticked';
        } }, {
          ...opts, checkProbation: options => checkProbationAtTick({ ...options, run: opts.run }), versions: null, background: false, applyPendingRollback: async () => ({ action: 'none' }),
          onRestart: () => { restarts++; }, readState: () => ({ adopted: null }),
          acquireRead: () => ({ ok: true }), releaseRead() {},
          importClosure: () => ({ files: new Set(['scripts/daemon.mjs']), complete: true, bareDeps: false, jsonNames: new Set() }),
          diffFiles: () => ['docs/example.md'],
          rebuild: async () => {
            if (head === before) {
              writeProvenGood(root, env, { head: before, inputsKey: 'before', mainSha: before, applied: [], provenAt: new Date(now - 1).toISOString() });
              head = after;
              const opened = openProbation({ ...opts, sha: after, prevHead: before, inputsKey: 'docs', mainSha: after, applied: [] });
              if (!opened) throw new Error('Failed to open fixture probation');
              head = after;
              writeRebuildState(root, { adopted: { head, inputsKey: 'docs', mainSha: after, applied: [] } }, env);
            }
            return { moved: !sibling, adopted: true, head, reason: sibling ? 'up-to-date' : 'skipped-unrelated' };
          },
        });
        const tick = await wrapped.tickOnce();
        ++now;
        await wrapped.tickOnce();
        const proof = { action: readProvenGood(root, env)?.head === after ? 'pass' : 'pending' };
        if (tick !== 'ticked' || proof.action !== 'pass' || readProvenGood(root, env)?.head !== after) {
          violations.push(`${sibling ? 'sibling' : 'adopter'} continued tick did not prove adoption: ${proof.action}`);
        }
        now = adoption + 2001;
        const capped = checkProbationAtTick({ ...opts, bootSha: before, bootAt: adoption, noRestartSha: after });
        if (capped.action !== 'none' || existsSync(marker) || restarts) violations.push('healthy documentation adoption requested rollback or restart');
        log?.(`${sibling ? 'sibling' : 'adopter'}: proof=${proof.action}, beyond cap=${capped.action}, restarts=${restarts}`);
      }
    } catch (error) { violations.push(error.message); }
    finally { rmSync(base, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations,
};
