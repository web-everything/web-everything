import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { load, plan } from '../flow-engine/index.mjs';
import { createHotpatchRunner, definition } from '../../hot-patch.mjs';
import { createHotpatchAdapter, hardenedGit, productionAdapter } from '../flow-engine/adapters/hotpatch.mjs';
import { hotpatchFixture, HP_SHA as sha } from './fixtures/hotpatch.mjs';
const pr = { state: 'open', head: { sha, repo: { full_name: 'o/r' } } };
function fixture() {
  const { readers, data } = hotpatchFixture(); let rows = [];
  const io = { repo: 'o/r', readers, pr: vi.fn(() => pr), pin: vi.fn(), pinned: () => true,
    audit: vi.fn(() => 'NOT WEAKENED'), add: vi.fn(() => { rows = [{ ref: `hotpatch/${sha}` }]; }),
    list: () => rows, remove: vi.fn(), live: () => 'pass', now: () => '2026-11-22T12:00:00Z',
    executorCommit: 'c'.repeat(40), netDiff: 'b'.repeat(64) };
  const log = []; const adapter = createHotpatchAdapter(io);
  const runner = createHotpatchRunner({ adapter, read: () => log, append: row => { log.push(structuredClone(row)); io.afterAppend?.(row); } });
  return { io, log, runner, data, adapter };
}
async function waiting(f) { await f.runner.request(7, 'review'); await f.runner.tick(); }
it('load accepts the hotpatch subset; during-ci await.wait -> load is refused', () => {
  expect(load(definition).digest).toMatch(/^[a-f0-9]{64}$/);
  const bad = structuredClone(definition);
  Object.assign(bad.states.await.on.find(t => t.outcome === 'wait'), { route: 'advance', target: 'load' });
  expect(() => load(bad)).toThrow();
});
it('a failed add leaves no loaded record and the next tick retries', async () => {
  const f = fixture(); await waiting(f);
  f.io.add.mockImplementationOnce(() => { throw Error('failed add'); });
  await f.runner.tick(); expect(f.log.some(r => r.phase === 'done' && r.transition?.predicate.guard === 'loaded')).toBe(false);
  await f.runner.tick(); expect(f.io.add).toHaveBeenCalledTimes(2);
  expect(f.log.some(r => r.phase === 'done' && r.transition?.predicate.guard === 'loaded')).toBe(true);
});
it('crash after intent before add re-evaluates ready and does not register on a now-red sha', async () => {
  const f = fixture(); await waiting(f);
  f.io.afterAppend = row => { if (row.phase === 'intent' && row.effect === 'load') { delete f.io.afterAppend; throw Error('crash'); } };
  await f.runner.tick(); expect(f.io.add).not.toHaveBeenCalled();
  f.data.checks.check_runs[0].conclusion = 'failure'; await f.runner.tick();
  expect(f.io.add).not.toHaveBeenCalled();
});
it('refuses to pin the ref when the App token is unavailable', async () => {
  const f = fixture(); f.io.pin.mockImplementation(() => { throw Error('App identity unavailable'); });
  await f.runner.request(7, 'review'); await f.runner.tick();
  expect(f.io.audit).not.toHaveBeenCalled(); expect(f.io.add).not.toHaveBeenCalled();
});
it('audit child output saying NOT WEAKENED without a ledger record does not pass', async () => {
  const f = fixture(); f.data.audits = []; await waiting(f); await f.runner.tick();
  expect(f.io.audit).toHaveBeenCalled(); expect(f.io.add).not.toHaveBeenCalled();
});
it.each(['pr', 'pinned', 'list', 'live'])('reader %s throwing escalates without unloading', async name => {
  const f = fixture(); f.io[name] = () => { throw Error('unreadable'); };
  const result = await f.adapter.read({ pr: 7, sha, daemon: 'review' }, { pr: 'intake', pinned: 'pinned', list: 'loaded', live: 'live' }[name]);
  expect(result.outcome).toBe('unknown'); expect(result.escalate).toBe(true); expect(f.io.remove).not.toHaveBeenCalled();
});
it.each(['closed', 'fork', 'short'])('refuses invalid PR evidence: %s', async kind => {
  const f = fixture(); f.io.pr.mockReturnValue(kind === 'closed' ? { ...pr, state: 'closed' } :
    { ...pr, head: { ...pr.head, ...(kind === 'short' ? { sha: 'abc' } : { repo: { full_name: 'fork/r' } }) } });
  await expect(f.runner.request(7, 'review')).rejects.toThrow(); expect(f.io.pin).not.toHaveBeenCalled();
});
it('CI-definition changes refuse intake and parallel=false starts audit only after receipt', async () => {
  const f = fixture(); f.data.paths = ['.github/workflows/ci.yml'];
  await expect(f.runner.request(7, 'review')).rejects.toThrow();
  f.data.paths = []; f.data.settings = { tool: { parallel: false } };
  f.data.checks.check_runs[0].status = 'queued'; f.data.checks.check_runs[0].conclusion = null;
  await waiting(f); expect(f.io.audit).not.toHaveBeenCalled();
  f.data.checks.check_runs[0].status = 'completed'; f.data.checks.check_runs[0].conclusion = 'success';
  await f.runner.tick(); expect(f.io.audit).toHaveBeenCalledTimes(1);
});
it('a replace object mapping sha to other content refuses and git environment is scrubbed', () => {
  const exec = vi.fn((cmd, args, opts) => {
    expect(opts.env.GIT_DIR).toBeUndefined(); expect(opts.env.GIT_WORK_TREE).toBeUndefined();
    expect(opts.env.GIT_NO_REPLACE_OBJECTS).toBe('1'); expect(opts.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
    return args[0] === 'replace' ? `${sha}\n` : sha;
  });
  const git = hardenedGit({ exec, env: { GIT_DIR: '/evil', GIT_WORK_TREE: '/evil', PATH: '/evil' } });
  expect(() => git.verify(sha)).toThrow(/replace/);
});
it('request is idempotent and metrics are retained after confirmed load', async () => {
  const f = fixture(); await waiting(f); await f.runner.tick();
  await f.runner.request(7, 'review'); expect(f.log.filter(r => r.phase === 'run')).toHaveLength(1);
  expect(f.runner.status(7)[0].metrics).toEqual(expect.objectContaining({ requestAt: expect.any(String), receiptAt: expect.any(String), auditAt: expect.any(String), liveAt: expect.any(String) }));
});
it('forbidden terms are absent from the CLI, guard and definition', () => {
  for (const file of ['scripts/hot-patch.mjs', 'scripts/lib/hotpatch-guards.mjs', 'scripts/conveyor/flows/hotpatch/flow.json'])
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/hotPatchProvenance|hotPatchMode|vetoIgnore|urgent-verify/);
});

it('production App authentication failure refuses before any pin API or child is invoked', async () => {
  const exec = vi.fn(), env = { GH_TOKEN: 'personal', GITHUB_TOKEN: 'personal' };
  const authenticate = vi.fn(({ env }) => { expect(env.GH_TOKEN).toBeUndefined(); expect(env.GITHUB_TOKEN).toBeUndefined(); return { applied: false }; });
  await expect(productionAdapter({ env, exec, authenticate })).rejects.toThrow(/App identity unavailable/);
  expect(exec).not.toHaveBeenCalled();
});
it.each(['checks', 'workflows', 'ciPlan', 'fullSuite', 'audits', 'ruledWeakened', 'auditOptions', 'covers', 'paths'])(
  'ready reader %s throwing yields unknown with operator escalation', async name => {
    const f = fixture(); f.io.readers[name] = () => { throw Error('unreadable'); };
    expect(await f.adapter.read({ pr: 7, sha, daemon: 'review' }, 'ready')).toEqual(expect.objectContaining({ outcome: 'unknown', escalate: true }));
    expect(f.io.add).not.toHaveBeenCalled(); expect(f.io.remove).not.toHaveBeenCalled();
  });
it('an interrupted successful add re-reads the list and records completion without adding twice', async () => {
  const f = fixture(); await waiting(f);
  const append = row => {
    if (row.phase === 'done' && row.transition.predicate.guard === 'loaded') throw Error('crash after add');
    f.log.push(structuredClone(row));
  };
  await createHotpatchRunner({ adapter: f.adapter, read: () => f.log, append }).tick();
  expect(f.io.add).toHaveBeenCalledTimes(1); await f.runner.tick();
  expect(f.io.add).toHaveBeenCalledTimes(1); expect(f.runner.status(7)[0].state).toBe('live');
});
it('unknown live evidence records escalation and never unloads', async () => {
  const f = fixture(); await waiting(f); await f.runner.tick();
  f.io.live = () => { throw Error('unreadable live evidence'); }; await f.runner.tick();
  expect(f.io.remove).not.toHaveBeenCalled(); expect(f.runner.status(7)[0].state).toBe('live');
  expect(f.runner.status(7)[0].escalation).toEqual(expect.objectContaining({ outcome: 'unknown' }));
});
it('real Git replace mapping to different commit content is refused', () => {
  const cwd = fs.mkdtempSync(join(process.env.TMPDIR, 'hp-replace-'));
  const git = (args, input) => String(execFileSync('git', ['-C', cwd, ...args], { input, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })).trim();
  try {
    git(['init', '-q']); const tree = git(['mktree'], '');
    const commit = message => git(['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nauthor Test <test@example.org> 1 +0000\ncommitter Test <test@example.org> 1 +0000\n\n${message}\n`);
    const original = commit('original'), replacement = commit('other content');
    git(['replace', original, replacement]);
    expect(git(['cat-file', '-p', original])).toContain('other content');
    expect(() => hardenedGit({ cwd, env: { ...process.env, GIT_DIR: '/wrong', GIT_WORK_TREE: '/wrong' } }).verify(original)).toThrow(/replace/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
it('oversized evidence fails closed and names the operator escalation', async () => {
  const f = fixture(); f.data.checks.total_count = 101;
  const verdict = await f.adapter.read({ pr: 7, sha, daemon: 'review' }, 'ready');
  expect(verdict).toEqual(expect.objectContaining({ outcome: 'unknown', fallback: expect.stringContaining('operator') }));
  expect(f.io.add).not.toHaveBeenCalled();
});

it('unknown never advances and intents never claim a successful loaded guard', async () => {
  const flow = load(definition);
  const [next] = plan(flow, { flowDigest: flow.digest, seq: 0, records: [], event: 'done', outcome: 'unknown',
    parts: { Subject: 'o/r#7', Sha: sha, Daemon: 'review', Visit: 1 } });
  expect(next.route).toBe('escalate');
  for (const state of Object.values(definition.states).filter(s => s.kind === 'judge'))
    expect(state.on.find(t => t.outcome === 'unknown').route).toBe('escalate');
  const f = fixture(); await waiting(f); await f.runner.tick();
  const intent = f.log.find(r => r.phase === 'intent' && r.effect === 'load');
  expect(intent.transition.predicate.outcome).toBe('unknown');
  expect(intent.idempotencyKey).toBe(`hp:o/r#7:${sha}:review:load`);
  const completed = f.log.find(r => r.phase === 'done' && r.transition.predicate.guard === 'loaded');
  expect(completed.transition.predicate.outcome).toBe('pass');
  expect(f.log.indexOf(intent)).toBeLessThan(f.log.indexOf(completed));
});

async function productionFixture() {
  const { readers, data } = hotpatchFixture();
  const transport = { ref: `${sha}\trefs/heads/hotpatch/${sha}`, refusal: false };
  const exec = vi.fn((cmd, args) => {
    if (cmd === 'git' && args[0] === 'rev-parse') return 'c'.repeat(40);
    if (cmd === 'git' && args[0] === 'ls-remote') {
      if (transport.ref instanceof Error) throw transport.ref;
      return transport.ref;
    }
    if (cmd === 'node') {
      if (transport.refusal) throw Error('prototype-load admission refused');
      return JSON.stringify({ ok: true, registered: true });
    }
    throw Error(`Unexpected fixture child: ${cmd} ${args[0]}`);
  });
  const adapter = await productionAdapter({ env: { HOME: process.env.HOME }, exec,
    authenticate: async () => ({ applied: true }),
    originResolver: () => ({ repo: 'o/r', gh: () => ({ code: 0, stdout: JSON.stringify(pr) }) }) });
  Object.assign(adapter.io.readers, readers);
  return { adapter, data, transport, exec, run: { pr: 7, sha, daemon: 'review' } };
}
it('production load uses non-urgent SHA-bound prototype-load and propagates its admission refusal', async () => {
  const f = await productionFixture();
  f.transport.refusal = true;
  await expect(f.adapter.perform(f.run, 'load')).rejects.toThrow(/admission refused/);
  f.transport.refusal = false; await f.adapter.perform(f.run, 'load');
  const calls = f.exec.mock.calls.filter(([cmd]) => cmd === 'node');
  expect(calls).toHaveLength(2);
  for (const [, args, opts] of calls) {
    expect(args[0]).toMatch(/scripts\/operations\/run\.mjs$/);
    expect(args.slice(1)).toEqual(['prototype-load', '--daemon=review', `--branch=hotpatch/${sha}`, `--sha=${sha}`, '--json']);
    expect(opts).toEqual(expect.objectContaining({ timeout: expect.any(Number), maxBuffer: 2097152 }));
  }
});
it('live rereads the canonical audit: a new WEAKENED verdict cannot pass', async () => {
  const f = await productionFixture(); expect((await f.adapter.read(f.run, 'live')).outcome).toBe('pass');
  f.data.audits[0].verdict = 'WEAKENED'; f.data.audits[0].findings = ['new security finding'];
  expect((await f.adapter.read(f.run, 'live')).outcome).toBe('fail');
});
it.each(['moved', 'deleted', 'unreadable', 'malformed'])('live ref %s escalates and cannot authorize unload', async kind => {
  const f = await productionFixture();
  f.transport.ref = { moved: `${'d'.repeat(40)}\trefs/heads/hotpatch/${sha}`, deleted: '',
    unreadable: Error('remote unavailable'), malformed: `${sha}\trefs/heads/other` }[kind];
  expect(await f.adapter.read(f.run, 'live')).toEqual(expect.objectContaining({ outcome: 'unknown', escalate: true }));
  await expect(f.adapter.perform(f.run, 'unload')).rejects.toThrow(/unload not authorized/);
  expect(f.exec.mock.calls.some(([cmd]) => cmd === 'node')).toBe(false);
  expect(f.exec.mock.calls.find(([cmd, args]) => cmd === 'git' && args[0] === 'ls-remote')[1])
    .toEqual(['ls-remote', '--exit-code', 'origin', `refs/heads/hotpatch/${sha}`]);
});
it.each(['missing', 'unreadable'])('live canonical audit %s is unknown and cannot authorize unload', async kind => {
  const f = await productionFixture();
  if (kind === 'missing') f.data.audits = [];
  else f.adapter.io.readers.audits = () => { throw Error('ledger unreadable'); };
  expect(await f.adapter.read(f.run, 'live')).toEqual(expect.objectContaining({ outcome: 'unknown', escalate: true }));
  await expect(f.adapter.perform(f.run, 'unload')).rejects.toThrow(/unload not authorized/);
  expect(f.exec.mock.calls.some(([cmd]) => cmd === 'node')).toBe(false);
});
it('malformed terminal journal completion escalates before monitoring can stop', async () => {
  const f = fixture(); await waiting(f); await f.runner.tick();
  const runKey = f.log.find(r => r.phase === 'run').runKey;
  f.log.push({ runKey, phase: 'done', transition: { predicate: { route: 'advance', to: 'refused' } } });
  const before = f.log.length; await f.runner.tick();
  expect(f.log.slice(before)).toEqual([expect.objectContaining({ phase: 'escalation' })]);
  expect(f.io.remove).not.toHaveBeenCalled();
  expect(() => f.runner.status(7)).toThrow();
});

async function twoLiveRuns() {
  const f = fixture(); await waiting(f); await f.runner.tick();
  const second = await f.runner.request(7, 'fix'); await f.runner.tick(second); await f.runner.tick(second);
  expect(f.runner.status(7).map(r => r.state)).toEqual(['live', 'live']); return f;
}
it('one default tick unloads both live daemon runs after evidence fails', async () => {
  const f = await twoLiveRuns(); f.io.live = () => 'fail'; await f.runner.tick();
  expect(f.io.remove.mock.calls.map(([r]) => r.daemon).sort()).toEqual(['fix', 'review']);
  expect(f.runner.status(7).map(r => r.state)).toEqual(['refused', 'refused']);
  await f.runner.tick(); expect(f.io.remove).toHaveBeenCalledTimes(2);
});
it('a throwing run does not prevent another live run from being processed', async () => {
  const f = await twoLiveRuns(); f.io.live = () => 'fail';
  f.io.remove.mockImplementation(r => { if (r.daemon === 'review') throw Error('remove unavailable'); });
  await f.runner.tick();
  expect(f.io.remove.mock.calls.map(([r]) => r.daemon)).toEqual(['review', 'fix']);
  expect(f.runner.status(7).map(r => r.state)).toEqual(['live', 'refused']);
});
it('malformed replay in one run escalates without abandoning the other live run', async () => {
  const f = await twoLiveRuns(), first = f.log.find(v => v.phase === 'run');
  f.log.push({ runKey: first.runKey, phase: 'done', transition: { predicate: { route: 'advance', to: 'refused' } } });
  f.io.live = () => 'fail'; await f.runner.tick();
  expect(f.io.remove.mock.calls.map(([r]) => r.daemon)).toEqual(['fix']);
  expect(f.log).toContainEqual(expect.objectContaining({ runKey: first.runKey, phase: 'escalation' }));
});

it('an escalation write throwing in one run cannot stop the other live run', async () => {
  const f = await twoLiveRuns(); f.io.live = () => 'fail';
  f.io.remove.mockImplementation(r => { if (r.daemon === 'review') throw Error('remove failed'); });
  f.io.afterAppend = row => { if (row.phase === 'escalation' && row.runKey.includes(':review:')) throw Error('journal sink failed'); };
  await f.runner.tick();
  expect(f.io.remove.mock.calls.map(([r]) => r.daemon)).toEqual(['review', 'fix']);
});
