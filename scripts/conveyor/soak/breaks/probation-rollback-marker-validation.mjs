/** PR #6882: a rollback request must be readable at boot before retiring probation. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneKeyOf } from '../../../lib/daemon-last-good.mjs';
import { alertsFilePath, writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';
import { applyPendingRollback, openProbation, requestRollback, writeProvenGood } from '../../../lib/daemon-rebuild/probation.mjs';

export default {
  id: 'probation-rollback-marker-validation',
  title: 'incomplete rollback requests preserve probation and alert before writing a boot marker',
  card: 'PR #6882 advisory marker validation',
  fixedBy: { sha: 'HEAD', where: 'lane/blue-green-s2-probation-r928',
    paths: ['scripts/lib/daemon-rebuild/probation.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/probation.mjs'), 'utf8')
      .includes('if (!markerOK(marker))');
  },
  async run({ log } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'soak-rollback-marker-'));
    const violations = [];
    try {
      const failed = 'b'.repeat(40), good = 'a'.repeat(40);
      const at = Date.parse('2026-11-15T12:00:00Z');
      for (const [name, identity] of [['absent', undefined], ['malformed', '../other'], ['null-id', null]]) {
        const root = join(base, name);
        mkdirSync(root);
        const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks') };
        let head = failed;
        const opts = { root, env, now: () => at, emit() {}, log: { error() {} }, run: args => {
          if (args[0] !== 'rev-parse' || args.at(-1) !== 'HEAD') throw new Error(`Unexpected Git: ${args[0]}`);
          return { status: 0, stdout: head };
        } };
        const key = cloneKeyOf(root);
        const markerFile = join(env.WE_DAEMON_STATE_DIR, `${key}.rollback-requested.json`);
        const probationFile = join(env.WE_DAEMON_STATE_DIR, `${key}.probation.json`);
        if (!writeProvenGood(root, env, { head: good, inputsKey: 'good', mainSha: good, applied: [],
          provenAt: new Date(at - 1000).toISOString() })
          || !openProbation({ ...opts, sha: failed, prevHead: good, inputsKey: 'failed', mainSha: good, applied: [] })) {
          throw new Error('Failed to persist fixture evidence');
        }
        writeRebuildState(root, { adopted: { head: failed } }, env);
        const valid = readFileSync(probationFile, 'utf8');
        writeFileSync(probationFile, JSON.stringify({ ...JSON.parse(valid), adoptionId: identity }));
        const before = readFileSync(probationFile, 'utf8');
        const result = await requestRollback(opts);
        if (result.ok !== false || result.reason !== 'probation-unreadable') violations.push(`${name}: accepted incomplete request`);
        if (existsSync(markerFile)) violations.push(`${name}: wrote an unreadable boot marker`);
        if (!existsSync(probationFile) || readFileSync(probationFile, 'utf8') !== before) violations.push(`${name}: lost probation evidence`);
        const alerts = existsSync(alertsFilePath(root, env))
          ? readFileSync(alertsFilePath(root, env), 'utf8').trim().split('\n').map(JSON.parse) : [];
        if (!alerts.some(alert => alert.kind === 'probation-needs-you' && alert.detail?.reason === 'probation-unreadable')) {
          violations.push(`${name}: no operator alert`);
        }
        log?.(`${name}: refused=${result.ok === false}, marker=${existsSync(markerFile)}`);
        // An operator repairs the missing input evidence; a retried request must
        // produce a marker the real boot reader can consume without intervention.
        writeFileSync(probationFile, valid);
        writeRebuildState(root, { adopted: { head: failed, inputsKey: 'failed' } }, env);
        if (!(await requestRollback(opts)).ok) violations.push(`${name}: repaired request refused`);
        head = good; // A sibling has already restored disk; no reset is needed.
        if (!(await applyPendingRollback(opts)).ok || existsSync(markerFile)) violations.push(`${name}: repaired request not consumable at boot`);
      }
    } catch (error) { violations.push(error.message); }
    finally { rmSync(base, { recursive: true, force: true }); }
    return { violations };
  },
  judge: report => report.violations,
};
