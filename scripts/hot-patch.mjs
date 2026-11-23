#!/usr/bin/env node
/** Durable hotpatch actor. FlowEngine only plans; the adapter owns named effects. */
import fs from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, plan, transitionRecord } from './lib/flow-engine/index.mjs';
import { productionAdapter } from './lib/flow-engine/adapters/hotpatch.mjs';
export const definition = JSON.parse(fs.readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'conveyor/flows/hotpatch/flow.json'), 'utf8'));
const flow = load(definition);
const key = (r, state) => `hp:${r.repo}#${r.pr}:${r.sha}:${r.daemon}:${state}`;
export function createHotpatchRunner({ adapter: a, read, append }) {
  const rows = r => read().filter(v => v.runKey === key(r, 'run'));
  const records = r => rows(r).filter(v => v.phase === 'done').map(v => v.transition);
  const state = r => {
    const history = records(r);
    plan(flow, { flowDigest: flow.digest, seq: history.length, records: history,
      repo: r.repo, pr: r.pr, head: r.sha, netDiff: r.netDiff });
    return history.reduce((s, v) => v.predicate.route === 'advance' ? v.predicate.to : s, 'intake');
  };
  const write = async (r, row) => append({ runKey: key(r, 'run'), ...row });
  const step = (r, outcome) => {
    const history = records(r);
    return plan(flow, { flowDigest: flow.digest, seq: history.length, records: history, event: 'done', outcome,
      parts: { Subject: `${r.repo}#${r.pr}`, Sha: r.sha, Daemon: r.daemon, Visit: history.length + 1 } })[0];
  };
  const record = (r, s) => transitionRecord(flow, s, { repo: r.repo, pr: r.pr, head: r.sha,
    netDiff: r.netDiff, executorCommit: a.io.executorCommit, seq: records(r).length + 1, at: a.io.now(),
    inputs: [`https://github.com/${r.repo}/pull/${r.pr}`] });
  const intent = async (r, effect) => write(r, { phase: 'intent', effect, idempotencyKey: key(r, effect), transition: record(r, step(r, 'unknown')) });
  const done = async (r, outcome) => write(r, { phase: 'done', transition: record(r, step(r, outcome)) });
  const metric = async (r, name) => {
    if (!rows(r).some(v => v.metric === name)) await write(r, { phase: 'metric', metric: name, at: a.io.now() });
  };
  const audit = async r => {
    if (rows(r).some(v => v.phase === 'effect-done' && v.effect === 'audit')) return;
    await intent(r, 'audit'); await a.perform(r, 'audit');
    await write(r, { phase: 'effect-done', effect: 'audit', idempotencyKey: key(r, 'audit') });
  };
  const tick = async r => {
    if (!r) {
      for (const { run } of read().filter(v => v.phase === 'run')) {
        try { if (run) await tick(run); } catch { /* A broken run or escalation sink cannot abandon its siblings. */ }
      }
      return;
    }
    try {
      const current = state(r);
      if (flow.definition.states[current].kind === 'final') return;
      const policy = await a.policy();
      if (current === 'pin') { await intent(r, 'pin'); await a.perform(r, 'pin'); }
      if (current === 'await') {
        if ((await a.read(r, 'receipt')).outcome === 'pass') {
          await metric(r, 'receiptAt'); if (!policy.parallel) await audit(r);
        }
        if (policy.parallel) await audit(r);
        if ((await a.read(r, 'audit')).outcome === 'pass') await metric(r, 'auditAt');
      }
      let recovered = false;
      if (current === 'load') {
        // Read the registration first: this run's add whose completion row was lost is already live, so it
        // must reach live monitoring (and verified withdrawal on CI/audit revocation) even after readiness
        // is revoked. A registration with no load intent of ours is never adopted on revoked readiness.
        const loaded = await a.read(r, 'loaded');
        if (loaded.outcome === 'unknown') { await write(r, { phase: 'escalation', detail: loaded }); return; }
        const ready = await a.read(r, 'ready');
        const ownAdd = rows(r).some(v => v.phase === 'intent' && v.effect === 'load');
        if (loaded.outcome === 'pass' && (ready.outcome === 'pass' || ownAdd)) recovered = ready.outcome !== 'pass';
        else if (ready.outcome !== 'pass') { await write(r, { phase: 'escalation', detail: ready }); return; }
        else { await intent(r, 'load'); await a.perform(r, 'load'); }
      }
      const guard = flow.definition.states[current].on[0].guard;
      // An unfinished withdrawal survives replay and cannot be cleared by later live evidence.
      const unloading = current === 'live' && rows(r).some(v => v.phase === 'intent' && v.effect === 'unload');
      const verdict = unloading ? { outcome: 'fail' } : await a.read(r, guard);
      if (verdict.outcome === 'unknown') {
        await write(r, { phase: 'escalation', detail: verdict }); await done(r, 'unknown'); return;
      }
      const listed = async () => (await a.io.list(r)).some(v => v.ref === `hotpatch/${r.sha}`);
      // Replaying an unfinished withdrawal re-reads the registration: a remove whose completion row was
      // lost is settled without a second remove (which would be refused once live evidence changes).
      if (current === 'live' && verdict.outcome === 'fail' && (!unloading || await listed())) {
        await intent(r, 'unload');
        const removed = await a.perform(r, 'unload');
        if (removed?.removed !== true || await listed())
          throw Error('Unload unproved; retain monitoring and retry after operator inspection');
      }
      if (current === 'load' && verdict.outcome !== 'pass') return;
      await done(r, verdict.outcome);
      if (current === 'load') await metric(r, 'liveAt');
      // Revoked readiness on a recovered registration: run the live check (CI/audit) now, not a tick later.
      if (current === 'load' && recovered && verdict.outcome === 'pass') return tick(r);
      if (current === 'pin' && verdict.outcome === 'pass' && policy.parallel) await audit(r);
    } catch {
      await write(r, { phase: 'escalation', detail: 'Effect or evidence unavailable; operator must inspect and retry. No completion recorded.' });
    }
  };
  return { tick, async request(pr, daemon) {
    if (!Number.isSafeInteger(pr) || pr < 1 || !/^[a-z][a-z0-9-]*$/.test(daemon)) throw Error('invalid PR or daemon');
    await a.policy(); const p = await a.io.pr(pr);
    const r = { repo: a.io.repo, pr, sha: p.head?.sha, daemon, requestAt: a.io.now() };
    if ((await a.read(r, 'intake')).outcome !== 'pass') throw Error('intake refused; use normal merge path or restore readable evidence');
    if (rows(r).some(v => v.phase === 'run')) return r;
    r.netDiff = typeof a.io.netDiff === 'function' ? await a.io.netDiff(r.sha) : a.io.netDiff;
    if (!/^[a-f0-9]{64}$/.test(r.netDiff ?? '')) throw Error('net diff unavailable; restore complete evidence');
    await write(r, { phase: 'run', run: r }); await done(r, 'pass'); await tick(r); return r;
  }, status(pr) {
    return read().filter(v => v.phase === 'run' && v.run.pr === pr).map(({ run: r }) => ({ ...r, state: state(r),
      metrics: Object.fromEntries([['requestAt', r.requestAt], ...rows(r).filter(v => v.phase === 'metric').map(v => [v.metric, v.at])]),
      escalation: rows(r).findLast(v => v.phase === 'escalation')?.detail }));
  } };
}
async function main(args) {
  const [command, number, ...flags] = args, pr = Number(number);
  if (!['request', 'status'].includes(command) || !Number.isSafeInteger(pr) || pr < 1) throw Error('usage: hot-patch.mjs request <pr> --daemon=<key> | status <pr>');
  const path = join(process.env.HOME, '.claude/daemon-overlays/hotpatch-runs.jsonl');
  const read = () => {
    try {
      if (fs.statSync(path).size > 2097152) throw Error('Run log exceeds 2 MiB; operator must archive settled runs before retrying');
      return fs.readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };
  fs.mkdirSync(dirname(path), { recursive: true });
  if (command === 'status') {
    const r = createHotpatchRunner({ adapter: null, read, append: null }); console.log(JSON.stringify(r.status(pr))); return;
  }
  const lock = `${path}.lock`;
  try { fs.mkdirSync(lock); } catch { throw Error('Hotpatch writer busy or interrupted; operator must verify ownership and retry'); }
  try {
    const adapter = await productionAdapter();
    const append = row => {
      const fd = fs.openSync(path, 'a', 0o600);
      try { fs.writeSync(fd, `${JSON.stringify(row)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    };
    const runner = createHotpatchRunner({ adapter, read, append });
    if (flags.length !== 1 || !flags[0].startsWith('--daemon=')) throw Error('--daemon=<key> required');
    await runner.request(pr, flags[0].slice(9)); console.log(JSON.stringify(runner.status(pr)));
  } finally { fs.rmdirSync(lock); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(() => {
  console.error('Hotpatch refused; inspect App identity, evidence and the run log; restore them or use the normal merge path.'); process.exitCode = 1;
});
