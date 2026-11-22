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
  const state = r => records(r).reduce((s, v) => v.predicate.route === 'advance' ? v.predicate.to : s, 'intake');
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
  const tick = async (r = read().findLast(v => v.phase === 'run')?.run) => {
    if (!r) return;
    try {
      const policy = await a.policy(), current = state(r);
      if (flow.definition.states[current].kind === 'final') return;
      if (current === 'pin') { await intent(r, 'pin'); await a.perform(r, 'pin'); }
      if (current === 'await') {
        if ((await a.read(r, 'receipt')).outcome === 'pass') {
          await metric(r, 'receiptAt'); if (!policy.parallel) await audit(r);
        }
        if (policy.parallel) await audit(r);
        if ((await a.read(r, 'audit')).outcome === 'pass') await metric(r, 'auditAt');
      }
      if (current === 'load') {
        const ready = await a.read(r, 'ready');
        if (ready.outcome !== 'pass') {
          await write(r, { phase: 'escalation', detail: ready }); return;
        }
        const loaded = await a.read(r, 'loaded');
        if (loaded.outcome === 'unknown') { await write(r, { phase: 'escalation', detail: loaded }); return; }
        if (loaded.outcome !== 'pass') { await intent(r, 'load'); await a.perform(r, 'load'); }
      }
      const guard = flow.definition.states[current].on[0].guard;
      const verdict = await a.read(r, guard);
      if (verdict.outcome === 'unknown') {
        await write(r, { phase: 'escalation', detail: verdict }); await done(r, 'unknown'); return;
      }
      if (current === 'live' && verdict.outcome === 'fail') {
        await intent(r, 'unload'); await a.perform(r, 'unload');
      }
      if (current === 'load' && verdict.outcome !== 'pass') return;
      await done(r, verdict.outcome);
      if (current === 'load') await metric(r, 'liveAt');
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
