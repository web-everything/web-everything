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
      retention(maxEvents, retentionMs, prRetentionMs) { this.log = createEventLog(this.storageAdapter, {maxEvents, retentionMs, prRetentionMs}); }
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

it('prunes closed SQLite projections on write and forwards independent PR pagination over real RPC', async () => {
  const mf = await runtime();
  try {
    const object = await stub(mf), t = Date.now();
    await object.retention(5000, 7 * 24 * 3600_000, 0);
    await object.append({ repo: 'o/r', prs: [1], sha: 'expired', type: 'pull_request', action: 'closed' }, t);
    await object.append({ repo: 'o/r', prs: [2], sha: 'open', type: 'pull_request', action: 'opened' }, t + 5 * 60_000);
    await object.append({ repo: 'o/r', prs: [3], sha: 'another', type: 'pull_request', action: 'opened' }, t + 5 * 60_000);
    const first = await read(mf, '?prsLimit=1');
    expect(first.prs.map((r) => r.number)).toEqual([2]);
    expect(first).toMatchObject({ prsCursor: 2, prsMore: true });
    const last = await read(mf, '?prsCursor=2&prsLimit=1');
    expect(last.prs.map((r) => r.number)).toEqual([3]);
    expect(last.prsMore).toBe(false);
  } finally { await mf.dispose(); }
});

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
    await expect(object.append({ repo: 'o/r', prs: [1], type: 'pull_request', action: 'synchronize', sha: 'rollback' }, Date.now())).rejects.toThrow();
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
