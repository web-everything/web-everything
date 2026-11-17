/** PR #6882: a released reader must let boot recovery retry without an operator restart. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSelfSync } from '../../../lib/daemon-self-sync.mjs';
import { applyPendingRollback } from '../../../lib/daemon-rebuild/probation.mjs';
import { acquireRead, inspectCloneLock, releaseRead } from '../../../lib/daemon-clone-lock.mjs';
import { cloneKeyOf } from '../../../lib/daemon-last-good.mjs';
import { alertsFilePath, rebuildStatePath, readRebuildState, writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';

export default {
  id: 'probation-boot-rollback-retry',
  title: 'reader contention clears without an operator restart',
  card: 'PR #6882 / xpr688a',
  fixedBy: { sha: 'HEAD', where: 'lane/blue-green-s2-probation-r928', paths: ['scripts/lib/daemon-self-sync.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-self-sync.mjs'), 'utf8').includes('bootRollbackRetryAt');
  },
  async run({ log, phases = ['recover', 'new-adoption'] } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'soak-boot-rollback-retry-'));
    const violations = [];
    const good = 'a'.repeat(40), failed = 'b'.repeat(40), newer = 'c'.repeat(40);
    try {
      for (const phase of phases) {
        const root = join(base, phase);
        mkdirSync(root);
        const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks') };
        mkdirSync(env.WE_DAEMON_STATE_DIR);
        const key = cloneKeyOf(root);
        const marker = join(env.WE_DAEMON_STATE_DIR, `${key}.rollback-requested.json`);
        const probation = join(env.WE_DAEMON_STATE_DIR, `${key}.probation.json`);
        const stateFile = rebuildStatePath(root, env);
        let at = 100_000, head = failed, attempts = 0, resets = 0;
        const events = [];
        const write = (file, value) => writeFileSync(file, JSON.stringify(value));
        write(marker, { adoptionId: '11111111-1111-4111-8111-111111111111', from: failed, to: good,
          inputsKey: 'good', mainSha: good, applied: [], rejectInputsKey: 'failed',
          reason: 'no-tick-progress', at: new Date(at).toISOString() });
        write(join(env.WE_DAEMON_STATE_DIR, `${key}.proven-good.json`), {
          head: good, inputsKey: 'good', mainSha: good, applied: [], provenAt: new Date(at - 1000).toISOString() });
        writeRebuildState(root, { adopted: { head: failed } }, env);
        const markerBytes = readFileSync(marker, 'utf8');
        const stateBytes = readFileSync(stateFile, 'utf8');
        const reader = { owner: `${hostname()}:${process.pid}`, pid: process.pid, nowMs: at,
          lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT };
        if (!acquireRead(root, reader).ok) throw new Error('reader fixture acquisition failed');
        const readerBefore = JSON.stringify(inspectCloneLock(root, reader).readers);
        // Real recovery and file locks, with modeled Git operations: this probe never writes .git.
        const run = args => {
          if (args[0] === 'rev-parse') {
            if (args.at(-1) === 'HEAD') return { status: 0, stdout: head };
            if (args.at(-1) === `${good}^{tree}`) return { status: 0, stdout: good };
            if (args.at(-1) === 'MERGE_HEAD') return { status: 1, stdout: '' };
          }
          if (args[0] === 'reset' && args[1] === '--hard' && args[2] === good) {
            if (readRebuildState(root, env).rejected?.inputsKey !== 'failed') violations.push('reset before rejection persisted');
            resets++;
            head = good;
            return { status: 0, stdout: '' };
          }
          if (['ls-files', 'status', 'cat-file', 'rev-list'].includes(args[0])) return { status: 0, stdout: '' };
          throw new Error(`unexpected Git operation: ${args.join(' ')}`);
        };
        const wrapped = withSelfSync({ tickOnce() { events.push('tick'); } }, {
          root, env, now: () => at, readHead: () => head, versions: null, background: false,
          log: { error() {} }, readState: () => ({ adopted: null }),
          rebuild: async () => { events.push('rebuild'); return { moved: false }; },
          acquireRead() { events.push('read'); return { ok: true }; }, releaseRead() {},
          applyPendingRollback: opts => { attempts++; return applyPendingRollback({ ...opts, run, lockWaitMs: 0, emit() {} }); },
          async onRestart() { events.push('drain'); await Promise.resolve(); events.push('restart'); return 'restarted'; },
        });
        for (const advance of [0, 0, 999]) {
          at += advance;
          const result = await wrapped.tickOnce();
          if (!result?.skipped || result.reason !== 'rollback-lock-timeout') violations.push(`${phase}: contention admitted work`);
        }
        if (attempts !== 1 || resets || head !== failed || events.length) violations.push(`${phase}: retry was unbounded or contention ran work`);
        if (readFileSync(marker, 'utf8') !== markerBytes || readFileSync(stateFile, 'utf8') !== stateBytes
          || JSON.stringify(inspectCloneLock(root, reader).readers) !== readerBefore) violations.push(`${phase}: timeout changed evidence or reader`);
        const alerts = readFileSync(alertsFilePath(root, env), 'utf8').trim().split('\n').map(JSON.parse);
        if (alerts.filter(a => a.detail.reason === 'rollback-lock-timeout').length !== 1) violations.push(`${phase}: missing bounded timeout alert`);
        releaseRead(root, reader);
        let newerProbation, newerState;
        if (phase === 'new-adoption') {
          head = newer;
          newerProbation = JSON.stringify({ adoptionId: '22222222-2222-4222-8222-222222222222', sha: newer });
          writeFileSync(probation, newerProbation);
          writeRebuildState(root, { adopted: { head: newer } }, env);
          newerState = readFileSync(stateFile, 'utf8');
        }
        at++;
        const result = await wrapped.tickOnce();
        await wrapped.tickOnce();
        if (result !== 'restarted' || attempts !== 2 || events.join(',') !== 'drain,restart') violations.push(`${phase}: release did not recover with one drained restart (attempts=${attempts})`);
        if (phase === 'recover') {
          const state = readRebuildState(root, env);
          if (resets !== 1 || head !== good || existsSync(marker) || state.adopted?.head !== good
            || state.rejected?.inputsKey !== 'failed') violations.push('rollback did not complete exactly once');
        } else if (resets || head !== newer || readFileSync(probation, 'utf8') !== newerProbation
          || readFileSync(stateFile, 'utf8') !== newerState) violations.push('retry overwrote a newer adoption');
        log?.(`${phase}: attempts=${attempts}, resets=${resets}, events=${events.join(',')}`);
      }
    } catch (error) { violations.push(error.message); }
    finally { rmSync(base, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations,
};
