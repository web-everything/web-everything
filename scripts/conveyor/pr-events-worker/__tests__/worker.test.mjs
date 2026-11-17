// @vitest-environment node
import { it, expect } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { signBody } from '../core.mjs';
import { bootstrapRepos } from '../bootstrap.mjs';

const bindings = { GITHUB_WEBHOOK_SECRET: 'local-sign', PR_EVENTS_READ_TOKEN: 'local-read', PR_EVENTS_BOOTSTRAP_TOKEN: 'local-write' };
const directory = resolve('scripts/conveyor/pr-events-worker');
async function runtime(persist, legacy = false) {
  // In-memory bundle: test-only RPCs inject storage faults and seed the old schema.
  const contents = legacy ? `import {DurableObject} from 'cloudflare:workers';
    export class PrEventLog extends DurableObject {
      seed() { const s=this.ctx.storage.sql;
        s.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY, delivery_id TEXT, at INTEGER NOT NULL, body TEXT NOT NULL)');
        s.exec('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)');
        s.exec("INSERT INTO meta VALUES ('head', '8')");
        s.exec('INSERT INTO events VALUES (8, NULL, ?, ?)', Date.now(), JSON.stringify({seq:8,repo:'o/r',prs:[1],type:'pull_request',action:'opened',sha:'old'}));
      }
    }; export default {fetch(){return new Response('legacy')}};` : `
    import worker, {PrEventLog as Base} from './worker.mjs';
    import {createEventLog} from './core.mjs';
    export class PrEventLog extends Base {
      fault(on) { this.ctx.storage.sql.exec(on ? "CREATE TRIGGER fail_projection BEFORE INSERT ON projection BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END" : 'DROP TRIGGER fail_projection'); }
      // Miniflare's Node RPC bridge masks rejected RPCs with a Promise-header
      // assertion. Capture the real append error inside workerd instead.
      async tryAppend(record, now, runtime = false) {
        try { return {result: await (runtime ? this.appendRuntime(record, now) : this.append(record, now))}; }
        catch (error) { return {error: error.message}; }
      }
      retention(maxEvents, retentionMs, options = {}) { this.log = createEventLog(this.storageAdapter, {maxEvents, retentionMs, ...options}); }
      stored() { return this.ctx.storage.sql.exec('SELECT seq, keep FROM events ORDER BY seq').toArray(); }
      pruneRows(rows, limits) {
        return this.storageAdapter.transaction(() => {
          for (const [seq, at, keep] of rows) this.storageAdapter.insert(seq, 'row-' + seq, at, JSON.stringify({seq}), keep);
          const highest = this.storageAdapter.prune(...limits);
          return {highest, rows: this.stored(), again: this.storageAdapter.prune(...limits)};
        });
      }
    }
    export default worker;`;
  const output = await build({ stdin: { contents, resolveDir: directory, sourcefile: 'runtime-test.mjs' }, bundle: true,
    write: false, format: 'esm', external: ['cloudflare:workers'], platform: 'neutral' });
  return new Miniflare({ modules: true, script: output.outputFiles[0].text, compatibilityDate: '2026-06-19',
    durableObjects: { PR_EVENT_LOG: { className: 'PrEventLog', useSQLite: true } }, durableObjectsPersist: persist, bindings });
}
async function stub(mf) {
  const ns = await mf.getDurableObjectNamespace('PR_EVENT_LOG');
  return ns.get(ns.idFromName('global'));
}
async function read(mf, query = '') {
  return (await mf.dispatchFetch(`http://local/prs${query}`, { headers: { authorization: 'Bearer local-read' } })).json();
}
async function deliver(mf, type, payload, id) {
  const body = JSON.stringify({ repository: { full_name: 'o/r' }, ...payload });
  return mf.dispatchFetch('http://local/github/webhook', { method: 'POST', body, headers: {
    'x-github-event': type, 'x-github-delivery': id, 'x-hub-signature-256': await signBody(bindings.GITHUB_WEBHOOK_SECRET, body),
  } });
}

const runtimeEvent = (cause) => ({ class: 'runtime', type: 'action-requested', repo: 'o/r', number: 1,
  head: 'a'.repeat(40), action: 'review', cause, writer: { role: 'decider' } });
const fact = (id) => ({ id, repo: 'o/r', prs: [1], type: 'pull_request', action: 'opened', sha: 'fact' });

// These cases run worker.mjs's SQL verbatim inside a SQLite Durable Object. The
// test RPCs expose observations/retention controls; they do not implement SQL pruning.
it.each([false, true])('SQLite keep schema: legacy=%s, mixed rows survive migration and restart', async (legacy) => {
  const persist = await mkdtemp(join(tmpdir(), 'pr-keep-migration-'));
  let mf;
  try {
    if (legacy) {
      mf = await runtime(persist, true);
      await (await stub(mf)).seed();
      await mf.dispose();
    }
    mf = await runtime(persist);
    const object = await stub(mf);
    const head = legacy ? 8 : 0;
    expect(await object.stored()).toEqual(legacy ? [{ seq: 8, keep: 0 }] : []);
    const response = await mf.dispatchFetch('http://local/runtime-events', { method: 'POST',
      headers: { authorization: 'Bearer local-write', 'content-type': 'application/json' },
      body: JSON.stringify(runtimeEvent(1)) });
    expect(response.status).toBe(202);
    expect(await object.append(fact('new-fact'))).toEqual({ seq: head + 2, duplicate: false });
    const expected = [...(legacy ? [{ seq: 8, keep: 0 }] : []),
      { seq: head + 1, keep: 1 }, { seq: head + 2, keep: 0 }];
    expect(await object.stored()).toEqual(expected);
    await mf.dispose();
    mf = await runtime(persist);
    const restarted = await stub(mf);
    expect(await restarted.stored()).toEqual(expected);
    expect(await restarted.appendRuntime(runtimeEvent(1))).toEqual({ seq: null, duplicate: true });
    expect(await restarted.read(head)).toMatchObject({ head: head + 2, gap: false,
      events: [{ seq: head + 1, class: 'runtime' }, { seq: head + 2, id: 'new-fact' }] });
  } finally { if (mf) await mf.dispose(); await rm(persist, { recursive: true, force: true }); }
}, 60000);

it.each([
  { name: 'empty table', rows: [], limits: [2, 0, 2, 0], kept: [], highest: 0 },
  { name: 'exact class caps', rows: [[1, 100, false], [2, 100, true], [3, 100, false], [4, 100, true]],
    limits: [2, 0, 2, 0], kept: [[1, 0], [2, 1], [3, 0], [4, 1]], highest: 0 },
  { name: 'independent OFFSET caps with interleaved classes',
    rows: [[1, 100, true], [2, 100, false], [3, 100, true], [4, 100, false], [5, 100, true], [6, 100, false]],
    limits: [1, 0, 2, 0], kept: [[3, 1], [5, 1], [6, 0]], highest: 4 },
  { name: 'zero runtime cap preserves facts', rows: [[1, 100, false], [2, 100, true], [3, 100, false], [4, 100, true]],
    limits: [2, 0, 0, 0], kept: [[1, 0], [3, 0]], highest: 4 },
  { name: 'age cutoffs are strict and class specific even with unordered timestamps',
    rows: [[1, 200, false], [2, 100, true], [3, 199, false], [4, 100, false], [5, 99, true], [6, 200, true]],
    limits: [10, 200, 10, 100], kept: [[1, 0], [2, 1], [6, 1]], highest: 5 },
  { name: 'age and count predicates combine across both classes',
    rows: [[1, 300, true], [2, 300, false], [3, 99, true], [4, 199, false], [5, 300, true], [6, 300, false]],
    limits: [2, 200, 2, 100], kept: [[5, 1], [6, 0]], highest: 4 },
])('SQLite prune: $name', async ({ rows, limits, kept, highest }) => {
  const mf = await runtime(false);
  try {
    expect(await (await stub(mf)).pruneRows(rows, limits)).toEqual({ highest,
      rows: kept.map(([seq, keep]) => ({ seq, keep })), again: 0 });
  } finally { await mf.dispose(); }
}, 60000);

it('SQLite append persists highest pruned seq and reports holes behind retained runtime rows', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'pr-runtime-gap-'));
  let mf;
  try {
    mf = await runtime(persist);
    let object = await stub(mf);
    await object.retention(1, 1000, { maxRuntimeEvents: 2, runtimeRetentionMs: 1000 });
    await object.append(fact('one'), 100);
    await object.appendRuntime(runtimeEvent(2), 101);
    await object.append(fact('three'), 102);
    await object.appendRuntime(runtimeEvent(4), 103);
    await object.append(fact('five'), 104);
    expect(await object.stored()).toEqual([{ seq: 2, keep: 1 }, { seq: 4, keep: 1 }, { seq: 5, keep: 0 }]);
    // MIN(seq)=2 cannot reveal the missing fact at 3 to a reader at cursor 2.
    expect(await object.read(2)).toMatchObject({ head: 5, gap: true, events: [{ seq: 4 }, { seq: 5 }] });
    expect(await object.read(3)).toMatchObject({ gap: false });
    await object.retention(1, 1000, { maxRuntimeEvents: 0 });
    await object.appendRuntime(runtimeEvent(6), 105);
    expect(await object.stored()).toEqual([{ seq: 5, keep: 0 }]);
    expect(await object.read(5)).toMatchObject({ head: 6, cursor: 6, gap: true, events: [] });
    await mf.dispose();
    mf = await runtime(persist);
    object = await stub(mf);
    expect(await object.read(5)).toMatchObject({ head: 6, cursor: 6, gap: true, events: [] });
    expect(await object.read(6)).toMatchObject({ head: 6, gap: false, events: [] });
    expect(await object.appendRuntime(runtimeEvent(6), 106)).toEqual({ seq: null, duplicate: true });
    // A subsequent prune returning zero must not erase the persisted watermark.
    expect(await object.appendRuntime(runtimeEvent(7), 107)).toEqual({ seq: 7, duplicate: false });
    expect(await object.read(5)).toMatchObject({ head: 7, gap: true, events: [{ seq: 7 }] });
  } finally { if (mf) await mf.dispose(); await rm(persist, { recursive: true, force: true }); }
}, 60000);

it('SQLite runtime rollback restores pruned rows, watermark, head and idempotency before retry', async () => {
  const mf = await runtime(false);
  try {
    const object = await stub(mf);
    await object.retention(1, 1000, { maxRuntimeEvents: 1, runtimeRetentionMs: 1000 });
    expect(await object.tryAppend(fact('one'), 100)).toEqual({ result: { seq: 1, duplicate: false } });
    await object.appendRuntime(runtimeEvent(2), 101);
    await object.append(fact('three'), 102);
    const before = await object.read(1);
    expect(before).toMatchObject({ head: 3, gap: false, events: [{ seq: 2 }, { seq: 3 }] });
    const retained = [{ seq: 2, keep: 1 }, { seq: 3, keep: 0 }];
    expect(await object.stored()).toEqual(retained);

    // Runtime projection writes happen AFTER insert/prune/watermark. Failing the
    // idempotency write must roll back the actual SQL DELETE as well as the INSERT.
    await object.fault(true);
    expect(await object.tryAppend(runtimeEvent(4), 103, true))
      .toEqual({ error: expect.stringContaining('injected projection failure') });
    expect(await object.stored()).toEqual(retained);
    expect(await object.read(1)).toEqual(before);
    await object.fault(false);

    expect(await object.appendRuntime(runtimeEvent(4), 103)).toEqual({ seq: 4, duplicate: false });
    expect(await object.stored()).toEqual([{ seq: 3, keep: 0 }, { seq: 4, keep: 1 }]);
    expect(await object.read(1)).toMatchObject({ head: 4, gap: true, events: [{ seq: 3 }, { seq: 4 }] });
    expect(await object.read(2)).toMatchObject({ gap: false });
    expect(await object.appendRuntime(runtimeEvent(4), 104)).toEqual({ seq: null, duplicate: true });
  } finally { await mf.dispose(); }
}, 60000);

it('SQLite upgrade, rollback, signed observations, restart, count/age pruning and bootstrap race soak', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'pr-ledger-'));
  let mf;
  try {
    mf = await runtime(persist, true);
    await (await stub(mf)).seed();
    await mf.dispose();
    mf = await runtime(persist);
    expect(await read(mf)).toMatchObject({ stateCursor: 8, prs: [{ number: 1, sha: 'old', draft: null, labels: null }],
      coverage: { partial: true, retainedReplayBoundary: 8, observedSince: 8, bootstrap: [] } });
    const object = await stub(mf);
    await object.fault(true);
    expect(await object.tryAppend({ repo: 'o/r', prs: [1], type: 'pull_request', action: 'synchronize', sha: 'rollback' }, Date.now()))
      .toEqual({ error: expect.stringContaining('injected projection failure') });
    expect(await read(mf, '?cursor=8')).toMatchObject({ stateCursor: 8, events: [], lastEventAt: null, prs: [{ sha: 'old', seq: 8 }] });
    await object.fault(false);
    await object.retention(3, 1000);
    for (let i = 0; i < 30; i++) {
      expect((await deliver(mf, 'pull_request', { number: 1, action: 'synchronize', pull_request: { head: { sha: `h${i}` }, draft: false, labels: [{ name: 'new' }] } }, `d${i}`)).status).toBe(202);
    }
    await deliver(mf, 'check_run', { action: 'completed', check_run: { head_sha: 'h0', name: 'ci', conclusion: 'success', pull_requests: [] } }, 'check');
    await deliver(mf, 'pull_request_review', { action: 'submitted', pull_request: { number: 1 }, review: { commit_id: 'h0', state: 'APPROVED' } }, 'review');
    const paged = await read(mf, '?cursor=8&limit=1');
    expect(paged).toMatchObject({ gap: true, more: true, stateCursor: 40, cursor: 38, prs: [{ sha: 'h29', review: { sha: 'h0' }, checks: [{ sha: 'h0' }] }] });
    // An old event timestamp forces age pruning independently of the count cap.
    await object.retention(1000, 1);
    await object.append({ repo: 'o/r', prs: [], type: 'check_suite', sha: 'unknown', app: 'ci' }, Date.now() + 10000);
    expect(await read(mf, '?cursor=40')).toMatchObject({ stateCursor: 41, events: [{ seq: 41 }] });
    expect(await read(mf, '?cursor=8')).toMatchObject({ gap: true, prs: [{ sha: 'h29' }] });
    const beforeRestart = await read(mf);
    await mf.dispose();
    mf = await runtime(persist);
    const afterRestart = await read(mf);
    delete beforeRestart.now; delete afterRestart.now;
    expect(afterRestart).toEqual(beforeRestart);
    let calls = 0;
    const results = await bootstrapRepos({ url: String(await mf.ready), repos: ['o/r'], importId: 'local-baseline', readToken: 'local-read', bootstrapToken: 'local-write',
      run: async (command, args) => {
        calls++; expect(command).toBe('gh'); expect(args).toContain('--repo');
        await deliver(mf, 'pull_request', { number: 1, action: 'closed', pull_request: { merged: true, head: { sha: 'final' }, labels: [{ name: 'closed' }] } }, 'close');
        return JSON.stringify([{ number: 1, headRefOid: 'stale', isDraft: true, state: 'OPEN', labels: [] }]);
      } });
    expect(calls).toBe(1);
    expect(results[0].status).toBe('complete');
    expect(await read(mf)).toMatchObject({ prs: [{ state: 'closed', merged: true, sha: 'final', labels: ['closed'] }], coverage: { bootstrap: [{ status: 'complete' }] } });
    const input = { repo: 'o/r', importId: 'retry', baseCursor: 0, status: 'truncated', prs: [] };
    const obj = await stub(mf);
    expect(await obj.bootstrap(input)).toMatchObject({ duplicate: false });
    expect(await obj.bootstrap(input)).toMatchObject({ duplicate: true });
    await obj.retention(1, 1000);
    await obj.append({ repo: 'o/r', prs: [1], type: 'pull_request_review', sha: 'final', state: 'approved', action: 'submitted' }, Date.now());
    await mf.dispose();
    mf = await runtime(persist);
    expect(await (await stub(mf)).bootstrap(input)).toMatchObject({ duplicate: true });
    expect((await read(mf)).coverage.bootstrap).toMatchObject([{ status: 'truncated' }]);
    // Run the actual CLI as a child process against the listening Worker. An inline
    // preload replaces only gh with a fake executable (Node printing fixture JSON),
    // so no helper executable/file or operator GitHub credentials are needed.
    const preload = `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
      const original = cp.execFileSync;
      cp.execFileSync = (command, args, options) => {
        if (command !== 'gh') throw new Error('unexpected executable');
        if (JSON.stringify(args) !== JSON.stringify(['pr','list','--repo','o/r','--state','open','--limit','1','--json','number,headRefOid,isDraft,labels,state'])) throw new Error('unexpected gh argv');
        console.error('fake-gh: o/r');
        return original(process.execPath, ['-e', 'console.log(JSON.stringify([{number:2,headRefOid:"cli",isDraft:false,labels:[],state:"OPEN"}]))'], options);
      }; syncBuiltinESMExports();`;
    const cli = await promisify(execFile)(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      join(directory, 'bootstrap.mjs'), `--url=${await mf.ready}`, '--repos=o/r', '--import-id=cli', '--limit=1'],
      { env: { ...process.env, PR_EVENTS_READ_TOKEN: 'local-read', PR_EVENTS_BOOTSTRAP_TOKEN: 'local-write' } });
    expect(cli.stderr.trim()).toBe('fake-gh: o/r');
    expect(JSON.parse(cli.stdout)).toMatchObject([{ status: 'truncated', duplicate: false }]);
    expect((await read(mf)).prs).toContainEqual(expect.objectContaining({ number: 2, sha: 'cli', draft: false }));
    console.log('SQLite proof: upgrade=8, paged cursor=38/stateCursor=40, restart identical, 30-event soak, rollback/pruning/race/retry and actual CLI/fake executable passed');
  } finally { if (mf) await mf.dispose(); await rm(persist, { recursive: true, force: true }); }
}, 60000);
