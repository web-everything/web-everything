/** PR #6882 / x1b8hlo: four healthy processes sharing a clone are not a crash loop. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cloneKeyOf } from '../../../lib/daemon-last-good.mjs';
import { writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';
import { readProvenGood, writeProvenGood } from '../../../lib/daemon-rebuild/probation.mjs';

// Resolve through filesystem paths so Vitest's browser asset transform cannot
// replace the native child process's file import with an http: URL.
const probationModuleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../../lib/daemon-rebuild/probation.mjs')).href;
const worker = `
  import { bootProbation, readProbation, checkProbationAtTick } from ${JSON.stringify(probationModuleUrl)};
  const { root, env, at, head } = JSON.parse(process.env.PROBATION_SIBLING_FIXTURE);
  let rollbacks = 0, restarts = 0;
  const options = { root, env, now: () => at + 10, bootAt: at, bootSha: head,
    readHead: () => head, run: () => ({ status: 0, stdout: head }), emit() {},
    rollback: async () => { rollbacks++; return { ok: true }; } };
  await bootProbation(options);
  process.on('message', async () => {
    const result = checkProbationAtTick(options);
    process.send({ result, rollbacks, restarts });
  });
  process.on('disconnect', () => process.exit(0));
  process.send({ pid: process.pid, probation: readProbation(root, env) });
`;

function response(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('sibling fixture timed out')), 5000);
    const message = value => finish(null, value);
    const error = err => finish(err);
    const exit = code => finish(new Error(`sibling exited early: ${code}`));
    function finish(err, value) {
      clearTimeout(timer);
      child.off('message', message); child.off('error', error); child.off('exit', exit);
      if (err) reject(err); else resolve(value);
    }
    child.once('message', message); child.once('error', error); child.once('exit', exit);
  });
}

export default {
  id: 'probation-sibling-startups',
  title: 'four healthy sibling startups do not trigger probation rollback',
  card: '5726 / PR #6882 send-back item 1',
  fixedBy: { sha: 'HEAD', where: 'lane/blue-green-s2-probation-r928', paths: ['scripts/lib/daemon-rebuild/probation.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/probation.mjs'), 'utf8').includes('concurrentBoots');
  },
  async run({ log } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'soak-probation-siblings-'));
    const children = [], violations = [];
    try {
      const root = join(base, 'clone'); mkdirSync(root);
      const env = { WE_DAEMON_STATE_DIR: join(base, 'state') };
      mkdirSync(env.WE_DAEMON_STATE_DIR);
      const key = cloneKeyOf(root), head = 'b'.repeat(40), good = 'a'.repeat(40), at = Date.now();
      const file = kind => join(env.WE_DAEMON_STATE_DIR, `${key}.${kind}.json`);
      const write = (path, record) => writeFileSync(path, JSON.stringify(record));
      write(file('probation'), { adoptionId: '11111111-1111-4111-8111-111111111111', sha: head, prevHead: good, inputsKey: 'healthy-B', mainSha: good, applied: [],
        adoptedAt: new Date(at).toISOString(), probationMs: 1000, boots: 0, baseline: {}, version: 1 });
      write(file('proven-good'), { head: good, inputsKey: 'proven-A', mainSha: good, applied: [], provenAt: new Date(at - 1).toISOString() });
      writeRebuildState(root, { adopted: { head, inputsKey: 'healthy-B', mainSha: good, applied: [] } }, env);
      let last;
      for (let i = 0; i < 4; i++) {
        const child = spawn(process.execPath, ['--input-type=module', '-e', worker], {
          env: { ...process.env, PROBATION_SIBLING_FIXTURE: JSON.stringify({ root, env, at, head }) },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          timeout: 30_000,
        });
        children.push(child);
        last = await response(child);
      }
      if (last.probation.boots !== 1) violations.push(`healthy siblings counted as ${last.probation.boots} crash-loop boots`);
      write(file('ticks.fourth'), { pid: last.pid, head, lastTickDoneAt: new Date(at + 1).toISOString() });
      let rollbacks = 0, restarts = 0;
      for (const child of children) {
        const reply = response(child); child.send('check');
        const result = await reply;
        rollbacks += result.rollbacks; restarts += result.restarts;
      }
      if (rollbacks || restarts) violations.push(`healthy siblings requested ${rollbacks} rollbacks and ${restarts} restarts`);
      if (readProvenGood(root, env)?.head !== head) violations.push('fourth sibling tick did not promote healthy B');
      if (existsSync(file('rollback-requested'))) violations.push('healthy B has a rollback marker');
      log?.(`four live siblings: boots=${last.probation.boots}, rollbacks=${rollbacks}, restarts=${restarts}`);
    } catch (error) { violations.push(error.message); }
    finally {
      await Promise.all(children.map(child => new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve();
        child.once('exit', resolve);
        if (child.connected) child.disconnect();
      })));
      rmSync(base, { recursive: true, force: true });
    }
    return { violations };
  },
  judge: report => report.violations,
};
