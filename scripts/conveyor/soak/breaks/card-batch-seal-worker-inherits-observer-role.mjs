/**
 * Live 2026-10-21: health-watch runs as the read-only `observer` GitHub App role (WE_GITHUB_APP_ROLE=observer in its
 * process env). It launches the detached card-batch seal worker on every tick (`sealDueBatches`), and card filing
 * launches it at admission time (`launchSealJob`). Both spawned the worker with no explicit env, so the worker
 * inherited `observer`, and every PR write it owns (body, hold label, ready/undo) failed "Resource not accessible by
 * integration". #5790 sat draft-withdrawn and #5794 sat at record-sealed from 07:30 ET until an overlay fix.
 *
 * Replay: the caller's env is observer; a due prevention batch sits in a temp state dir. The real `sealDueBatches`
 * scan and the real `launchSealJob` run; only the OS spawn is injected (no real worker, no write outside a temp dir).
 * The role each worker would really run as (its explicit spawn env, else the inherited process env) must be
 * `worker`, and the caller's own process.env must stay `observer`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROLE = 'WE_GITHUB_APP_ROLE';

export default {
  id: 'card-batch-seal-worker-inherits-observer-role',
  title: 'card-batch seal worker launched by health-watch inherited the read-only observer App role and could not write to its PR',
  card: 'graduates the lane/seal-stuck-role overlay (#5790/#5794 stuck)',
  fixedBy: { sha: '2c656d5eb', where: 'lane/grad-seal-role-2', paths: ['scripts/operations/card-batch-io.mjs', 'scripts/operations/card-batch-seal-io.mjs', 'scripts/operations/card-batch-file.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/operations/card-batch-io.mjs'), 'utf8').includes('export const sealJobEnv'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const load = (p) => import(pathToFileURL(join(root, p)).href);
    const sealIo = await load('scripts/operations/card-batch-seal-io.mjs');
    const fileIo = await load('scripts/operations/card-batch-file.mjs');
    const { loadCardBatchPolicy } = await load('scripts/lib/card-batch-policy.mjs');
    const tmp = mkdtempSync(join(tmpdir(), 'soak-seal-role-'));
    const statePath = join(tmp, 'org-repo-prevention.json');
    writeFileSync(statePath, JSON.stringify({ batchRef: 'lane/card-batch-prevention-1', seq: 1, headSha: 'a'.repeat(40), openedAt: 0,
      members: [{ cardId: '123', source: { repo: 'org/repo', pr: 42 } }] }));
    const prior = Object.prototype.hasOwnProperty.call(process.env, ROLE) ? process.env[ROLE] : undefined;
    process.env[ROLE] = 'observer';
    const launches = []; const violations = [];
    // The role the detached worker really runs as: node uses the explicit env when given, else inherits process.env.
    const record = (via) => (_cmd, _args, options = {}) => {
      launches.push({ via, role: (options.env ?? process.env)[ROLE] });
      return { once: (event, cb) => { if (event === 'spawn') queueMicrotask(cb); }, on: () => {}, unref: () => {} };
    };
    try {
      const policy = loadCardBatchPolicy({ prevention: { maxCards: 2, maxAgeMinutes: 1 } });
      const due = await sealIo.sealDueBatches({ now: 60000, stateDir: tmp, policy, spawn: record('sealDueBatches') });
      if (due.length !== 1) violations.push(`expected the due batch to launch once, launched ${due.length}`);
      fileIo.launchSealJob(statePath, { spawn: record('launchSealJob'), open: () => { throw Error('no log'); } });
      if (launches.length !== 2) violations.push(`expected 2 seal-worker launches, saw ${launches.length}`);
      for (const l of launches) if (l.role !== 'worker') violations.push(`${l.via} seal worker runs as ${l.role}, not worker`);
      if (process.env[ROLE] !== 'observer') violations.push(`caller process.env left as ${process.env[ROLE]}`);
    } finally {
      if (prior === undefined) delete process.env[ROLE]; else process.env[ROLE] = prior;
      rmSync(tmp, { recursive: true, force: true });
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
