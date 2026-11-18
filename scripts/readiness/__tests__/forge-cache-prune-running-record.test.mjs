// @vitest-environment node
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {planPrune, readLiveEvidence, resolveSettings} from '../forge-cache-prune.mjs';
import {createRunner, digestArgv, digestInput, manifestWire} from '../forge-exec-run.mjs';

const HOUR = 3_600_000, GiB = 1024 ** 3, now = Date.UTC(2026, 10, 15);
const MAX_RUNTIME = 3 * 1_740_000 + 15 * 60 * 1000;
const hex = c => c.repeat(64), lock = hex('a');
const inputDigest = hex('b'), manifestDigest = hex('c');
const hash = data => createHash('sha256').update(data).digest('hex');
let tmp, root, receipts;
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR, 'forge-prune-running-')));
  root = join(tmp, 'cache'); receipts = join(tmp, 'receipts');
  await fs.mkdir(root); await fs.mkdir(receipts);
});
afterEach(async () => { if (tmp) await fs.rm(tmp, {recursive: true, force: true}); });

async function json(path, value) {
  await fs.mkdir(join(path, '..'), {recursive: true});
  await fs.writeFile(path, JSON.stringify(value));
  await fs.utimes(path, now / 1000, now / 1000);
}
async function reserve(run = `r-${'1'.repeat(32)}`, worker = 'worker-active', mtime = now, fields = {}) {
  const path = join(receipts, worker, 'reservation.json');
  await json(path, {run, writerGuard: 1, ...fields});
  await fs.utimes(path, mtime / 1000, mtime / 1000);
  return run;
}
const record = siblings => ({lock, inputDigest, manifestDigest,
  manifest: siblings ? {siblings: {frontierui: {sha: 'd'.repeat(40)}}} : {}});
const running = run => ({v: 1, nonce: 'e'.repeat(32), run,
  receiptCapabilities: {taskPressure: 1}, slot: 'forge-exec-1', owner: {pid: 123, start: '456'}});
const receipt = siblings => ({v: 1, phase: 'test', code: 0, lock, inputDigest, manifestDigest,
  ...(siblings ? {siblingShas: {frontierui: 'd'.repeat(40)}} : {})});
const entry = (digest, profileLock = lock) => ({lock: profileLock, name: `dev-v5-${digest}`, path: join(root, profileLock, `dev-v5-${digest}`),
  mtimeMs: now - 20 * HOUR, bytes: 10});
const plan = (entries, live) => planPrune({root, entries, now,
  settings: resolveSettings({FORGE_CACHE_MAX_AGE_HOURS: '12', FORGE_CACHE_MAX_BYTES: String(200 * GiB),
    FORGE_CACHE_HIGH_WATER_PCT: '80'}),
  disk: {usedPct: 20, totalBytes: 1000, usedBytes: 200}, live});
function expectPrecise(live, digest) {
  expect(live.complete).toBe(true);
  expect(live.profiles).toEqual(new Set([`${lock}/dev-v5-${digest}`]));
  expect(live.locks).toEqual(new Set());
}
function expectRefused(live, reason) {
  expect(live.complete).toBe(false);
  expect(live.refused).toMatch(reason);
  expect(live.refused).toMatch(/preserving cache/);
}

describe('reserved running records with lock evidence in another phase', () => {
  it.each([false, true])('uses a real receipt with siblingShas present=%s for precise age pruning', async siblings => {
    const run = await reserve();
    await json(join(receipts, `${run}.running`), running(run));
    await json(join(receipts, `${run}.receipt`), receipt(siblings));
    const live = await readLiveEvidence({receipts, now});
    const digest = siblings ? manifestDigest : inputDigest;
    expectPrecise(live, digest);
    const active = entry(digest), others = [entry(hex('d')), entry(hex('e'))];
    const result = plan([active, ...others], live);
    expect(result.refused).toBeUndefined();
    expect(result.prune.map(e => e.name).sort()).toEqual(others.map(e => e.name).sort());
    expect(result.keep).toEqual([{...active, reason: 'Protected by live reservation'}]);
  });
  it('protects a live profile when only the prepared record carries the lock and manifest', async () => {
    const run = await reserve();
    await json(join(receipts, `${run}.running`), running(run));
    await json(join(receipts, `${run}.prepared`), record(false));
    const live = await readLiveEvidence({receipts, now});
    expectPrecise(live, inputDigest);
    const active = entry(inputDigest), result = plan([active], live);
    expect(result.prune).toEqual([]);
    expect(result.keep).toEqual([{...active, reason: 'Protected by live reservation'}]);
  });
  it.each([
    {manifestDigest},
    {siblings: false},
    {siblings: true},
  ])('incomplete latest phase preserves every profile under the lock: %j', async incomplete => {
    const run = await reserve();
    await json(join(receipts, `${run}.prepared`), record(false));
    await json(join(receipts, `${run}.running`), {...running(run), ...incomplete});
    const live = await readLiveEvidence({receipts, now});
    expect(live.complete).toBe(true);
    expect(live.locks).toEqual(new Set([lock]));
    const entries = [entry(inputDigest), entry(hex('d'))], result = plan(entries, live);
    expect(result.prune).toEqual([]);
    expect(result.keep).toEqual(entries.map(e => ({...e, reason: 'Protected by live reservation'})));
  });
  it('fails closed and preserves cache when no record carries a lock', async () => {
    const run = await reserve();
    await json(join(receipts, `${run}.running`), running(run));
    expectRefused(await readLiveEvidence({receipts, now}), /Invalid reserved lock evidence/);
  });
  it('fails closed on a corrupt receipt input digest even when running has no lock', async () => {
    const run = await reserve();
    await json(join(receipts, `${run}.running`), running(run));
    await json(join(receipts, `${run}.receipt`), {...receipt(false), inputDigest: 'bad'});
    expectRefused(await readLiveEvidence({receipts, now}), /Invalid reserved profile evidence/);
  });
  it.each(['prepared', 'running', 'receipt'].flatMap(suffix => [false, true].map(siblings => [suffix, siblings])))
  ('rejects an invalid unselected digest in a live %s record with siblings=%s', async (suffix, siblings) => {
    const run = await reserve();
    await json(join(receipts, `${run}.${suffix}`), {
      ...(suffix === 'receipt' ? receipt(siblings) : record(siblings)),
      [siblings ? 'inputDigest' : 'manifestDigest']: 'bad',
    });
    const live = await readLiveEvidence({receipts, now});
    expectRefused(live, /Invalid reserved profile evidence/);
    expect(plan([entry(inputDigest), entry(manifestDigest)], live).prune).toEqual([]);
  });
  it.each(['prepared', 'running', 'receipt'])('fails closed on an explicit non-hex lock in %s', async suffix => {
    const run = await reserve();
    // Other phases are valid so rejection must reach the corrupt record itself.
    for (const phase of ['prepared', 'running', 'receipt']) {
      await json(join(receipts, `${run}.${phase}`), {...record(false), ...(phase === suffix ? {lock: 'bad'} : {})});
    }
    expectRefused(await readLiveEvidence({receipts, now}), /Invalid reserved lock evidence/);
  });
});

describe('leaked reservation lifetime', () => {
  it.each([false, true])('ignores an expired reservation with a final receipt (receipt has lock=%s)', async hasLock => {
    const run = await reserve(undefined, undefined, now - MAX_RUNTIME - 1000);
    await json(join(receipts, `${run}.running`), running(run));
    await json(join(receipts, `${run}.receipt`), hasLock ? {...receipt(false), run} : {v: 1, run, phase: 'test', code: 0});
    const live = await readLiveEvidence({receipts, now});
    expect(live).toMatchObject({complete: true, profiles: new Set(), locks: new Set()});
    expect(plan([entry(inputDigest)], live).prune).toEqual([{...entry(inputDigest), reason: 'Expired age'}]);
  });
  it('keeps protecting an equally old reservation with no final receipt', async () => {
    const run = await reserve(undefined, undefined, now - MAX_RUNTIME - 1000);
    await json(join(receipts, `${run}.running`), record(false));
    expectPrecise(await readLiveEvidence({receipts, now}), inputDigest);
  });
  it('keeps protecting a fresh reservation even after a final receipt exists', async () => {
    const run = await reserve();
    await json(join(receipts, `${run}.running`), running(run));
    await json(join(receipts, `${run}.receipt`), {...receipt(false), run});
    expectPrecise(await readLiveEvidence({receipts, now}), inputDigest);
  });
});

describe('leaked reservation proof guards', () => {
  it.each([
    {phase: undefined}, {code: undefined}, {v: undefined},
    {phase: 1}, {code: 0.5}, {v: 2}, {phase: ''}, {phase: '  '}, {code: -1}, {code: 256},
  ])('keeps protection with an incomplete final receipt: %j', async incomplete => {
    const run = await reserve(undefined, undefined, now - MAX_RUNTIME - 1000);
    await json(join(receipts, `${run}.running`), record(false));
    await json(join(receipts, `${run}.receipt`), {...receipt(false), run, ...incomplete});
    const live = await readLiveEvidence({receipts, now});
    expectPrecise(live, inputDigest);
    expect(plan([entry(inputDigest)], live).prune).toEqual([]);
  });
  it.each(['prepared', 'running'])('keeps protection when the receipt is older than the .%s record', async suffix => {
    const run = await reserve(undefined, undefined, now - MAX_RUNTIME - 1000);
    await json(join(receipts, `${run}.${suffix}`), record(false));
    const final = join(receipts, `${run}.receipt`);
    await json(final, {...receipt(false), run});
    await fs.utimes(final, (now - 1000) / 1000, (now - 1000) / 1000);
    const live = await readLiveEvidence({receipts, now});
    expectPrecise(live, inputDigest);
    expect(plan([entry(inputDigest)], live).prune).toEqual([]);
  });
  it('keeps protection when the complete receipt is newer than now', async () => {
    const run = await reserve(undefined, undefined, now - MAX_RUNTIME - 1000);
    const final = join(receipts, `${run}.receipt`);
    await json(final, {...receipt(false), run});
    await fs.utimes(final, (now + 1000) / 1000, (now + 1000) / 1000);
    const live = await readLiveEvidence({receipts, now});
    expectPrecise(live, inputDigest);
    expect(plan([entry(inputDigest)], live).prune).toEqual([]);
  });
  it('ignores an expired reservation with a complete receipt newer than every other phase', async () => {
    const run = await reserve(undefined, undefined, now - MAX_RUNTIME - 1000);
    for (const suffix of ['prepared', 'running']) {
      const file = join(receipts, `${run}.${suffix}`);
      await json(file, record(false));
      await fs.utimes(file, (now - 1000) / 1000, (now - 1000) / 1000);
    }
    await json(join(receipts, `${run}.receipt`), {...receipt(false), run});
    const live = await readLiveEvidence({receipts, now});
    expect(live).toMatchObject({complete: true, profiles: new Set(), locks: new Set()});
    expect(plan([entry(inputDigest)], live).prune).toEqual([{...entry(inputDigest), reason: 'Expired age'}]);
  });
  it.each([undefined, 0, 2, '1', true, null])
  ('requires a leased writer: writerGuard=%s protects the whole lock despite an expired matching receipt', async writerGuard => {
    const run = await reserve(undefined, undefined, now - MAX_RUNTIME - 1000, {writerGuard});
    await json(join(receipts, `${run}.receipt`), {...receipt(false), run});
    const live = await readLiveEvidence({receipts, now});
    expect(live).toMatchObject({complete: true, profiles: new Set([`${lock}/dev-v5-${inputDigest}`]), locks: new Set([lock])});
    const entries = [entry(inputDigest), entry(hex('d'))], result = plan(entries, live);
    expect(result.refused).toBeUndefined();
    expect(result.prune).toEqual([]);
    expect(result.keep).toEqual(entries.map(e => ({...e, reason: 'Protected by live reservation'})));
  });
  it.each([undefined, `r-${'2'.repeat(32)}`])
  ('requires the final receipt to name the reserved run: receipt.run=%s keeps an expired leased profile protected', async receiptRun => {
    const run = await reserve(undefined, undefined, now - MAX_RUNTIME - 1000);
    await json(join(receipts, `${run}.receipt`), {...receipt(false), run: receiptRun});
    const live = await readLiveEvidence({receipts, now});
    expectPrecise(live, inputDigest);
    const result = plan([entry(inputDigest), entry(hex('d'))], live);
    expect(result.refused).toBeUndefined();
    expect(result.keep).toEqual([{...entry(inputDigest), reason: 'Protected by live reservation'}]);
    expect(result.prune).toEqual([{...entry(hex('d')), reason: 'Expired age'}]);
  });
  it.each([-1000, 0])('requires maximum runtime before bypass: age offset=%s ms with every other proof valid', async offset => {
    const run = await reserve(undefined, undefined, now - MAX_RUNTIME - offset);
    await json(join(receipts, `${run}.receipt`), {...receipt(false), run});
    const live = await readLiveEvidence({receipts, now});
    const result = plan([entry(inputDigest)], live);
    expect(result.refused).toBeUndefined();
    if (offset < 0) {
      expectPrecise(live, inputDigest);
      expect(result.prune).toEqual([]);
      expect(result.keep).toEqual([{...entry(inputDigest), reason: 'Protected by live reservation'}]);
    } else {
      expect(live).toMatchObject({complete: true, profiles: new Set(), locks: new Set()});
      expect(result.keep).toEqual([]);
      expect(result.prune).toEqual([{...entry(inputDigest), reason: 'Expired age'}]);
    }
  });
  it.each(['prepared', 'running', 'receipt'].flatMap(suffix =>
    [false, true].flatMap(siblings => ['inputDigest', 'manifestDigest'].flatMap(digest =>
      ['bad', null, 42, hex('b') + '\n'].map(value => [suffix, digest, siblings, value])))))
  ('validates %s %s with siblings=%s value=%j before leaked-reservation bypass', async (suffix, digest, siblings, value) => {
    const run = await reserve(undefined, undefined, now - MAX_RUNTIME - 1000);
    for (const phase of ['prepared', 'running', 'receipt']) {
      await json(join(receipts, `${run}.${phase}`), {
        ...(phase === 'receipt' ? receipt(siblings) : record(siblings)), run,
        ...(phase === suffix ? {[digest]: value} : {}),
      });
    }
    const live = await readLiveEvidence({receipts, now});
    expectRefused(live, /Invalid reserved profile evidence/);
    const result = plan([entry(siblings ? manifestDigest : inputDigest)], live);
    expect(result.refused).toMatch(/Incomplete live evidence/);
    expect(result.prune).toEqual([]);
    expect(result.keep).toHaveLength(1);
  });
  it.each(['prepared', 'running', 'receipt'].flatMap(suffix => ['bad', hex('f')].map(value => [suffix, value])))
  ('validates %s lock=%s before bypassing an expired leased reservation with a matching final receipt', async (suffix, value) => {
    const run = await reserve(undefined, undefined, now - MAX_RUNTIME - 1000);
    for (const phase of ['prepared', 'running', 'receipt']) {
      await json(join(receipts, `${run}.${phase}`), {
        ...(phase === 'receipt' ? receipt(false) : record(false)), run,
        ...(phase === suffix ? {lock: value} : {}),
      });
    }
    const live = await readLiveEvidence({receipts, now});
    expectRefused(live, value === 'bad' ? /Invalid reserved lock evidence/ : /Conflicting reserved lock evidence/);
    const result = plan([entry(inputDigest)], live);
    expect(result.refused).toMatch(/Incomplete live evidence/);
    expect(result.prune).toEqual([]);
    expect(result.keep).toHaveLength(1);
  });
});

// Bind the exact snapshot, as in forge-exec-run.test.mjs.
async function snapshotBinding(base) {
  const entries = [];
  async function walk(prefix = Buffer.alloc(0)) {
    const absolute = prefix.length ? Buffer.concat([Buffer.from(base + '/'), prefix]) : Buffer.from(base);
    for (const name of await fs.readdir(absolute, {encoding: 'buffer'})) {
      const path = prefix.length ? Buffer.concat([prefix, Buffer.from('/'), name]) : name;
      const full = Buffer.concat([Buffer.from(base + '/'), path]);
      const info = await fs.stat(full);
      if (info.isDirectory()) await walk(path);
      else entries.push({path, sha256: hash(await fs.readFile(full)), executable: !!(info.mode & 0o111)});
    }
  }
  await walk();
  entries.sort((a, b) => Buffer.compare(a.path, b.path));
  const manifest = manifestWire({entries, excluded: []});
  return {manifest, manifestDigest: hash(JSON.stringify(manifest))};
}

async function observeRunningDuringCleanup(siblings = false) {
  const testRoot = join(tmp, 'runner'), bin = join(testRoot, 'bin');
  await fs.mkdir(bin, {recursive: true});
  await fs.symlink(process.execPath, join(bin, 'node'));
  await fs.writeFile(join(bin, 'npm'), `#!/bin/bash
if [ "$1" = ci ]; then
  mkdir -p node_modules packages/deep/node_modules
  echo dev > node_modules/vitest
  echo nested > packages/deep/node_modules/dependency
  exit 0
fi
[ -f node_modules/vitest ] || exit 98
[ -f packages/deep/node_modules/dependency ] || exit 99
exit 3
`, {mode: 0o755});
  let observed;
  const cleanup = vi.fn(async ({args}) => {
    observed = JSON.parse(await fs.readFile(join(testRoot, 'receipts', `${request.run}.running`), 'utf8'));
    await fs.rm(args.at(-1), {recursive: true, force: true});
    return {code: 0};
  });
  const runner = createRunner({testRoot, testPath: bin + ':/usr/bin:/bin', testCleanupExec: cleanup});
  const nonce = 'b'.repeat(32), prepared = await runner.prepare({nonce, label: 'abcdef-1'});
  const work = join(testRoot, 'runs', prepared.run, 'work');
  await fs.writeFile(join(work, 'package-lock.json'), 'lock');
  const argv = ['npm', 'run', 'test:unit'];
  const request = {nonce, run: prepared.run, argv, env: {NODE_ENV: 'production', CI: 'true'}, lock: hash('lock'),
    ...await snapshotBinding(work), inputDigest: await digestInput(work), argvDigest: digestArgv(argv)};
  if (siblings) {
    const sibling = join(testRoot, 'runs', prepared.run, 'frontierui');
    await fs.mkdir(join(sibling, 'plugs'), {recursive: true});
    await fs.writeFile(join(sibling, 'plugs/index.js'), 'sibling fixture');
    request.manifest.siblings = {frontierui: {sha: 'd'.repeat(40), ...manifestWire({entries: [
      {path: Buffer.from('plugs/index.js'), sha256: hash('sibling fixture'), executable: false},
    ], excluded: []})}};
    request.manifestDigest = hash(JSON.stringify(request.manifest));
    request.siblingShas = {frontierui: 'd'.repeat(40)};
  }
  expect((await runner.run(request)).code).toBe(3);
  expect(await runner.finish(request)).toMatchObject({phase: 'test', code: 3});
  expect(cleanup).toHaveBeenCalledTimes(1);
  return {observed, request};
}

describe('running record producer', () => {
  it.each([false, true])('writes lock, digests and siblings=%s while retaining nonce and run', async siblings => {
    const {observed, request} = await observeRunningDuringCleanup(siblings);
    expect(observed).toMatchObject({lock: request.lock, inputDigest: request.inputDigest,
      manifestDigest: request.manifestDigest, siblings, nonce: request.nonce, run: request.run});
  });
  it.each([false, true])('selects the actual running profile with siblings=%s without another phase record', async siblings => {
    const {observed, request} = await observeRunningDuringCleanup(siblings);
    await reserve(request.run);
    await json(join(receipts, `${request.run}.running`), observed);
    const live = await readLiveEvidence({receipts, now});
    expect(live.complete).toBe(true);
    const digest = siblings ? request.manifestDigest : request.inputDigest;
    expect(request.manifestDigest).not.toBe(request.inputDigest);
    expect(live.profiles).toEqual(new Set([`${request.lock}/dev-v5-${digest}`]));
    expect(live.locks).toEqual(new Set());
    const active = entry(digest, request.lock);
    const other = entry(siblings ? request.inputDigest : request.manifestDigest, request.lock);
    const result = plan([active, other], live);
    expect(result.keep).toEqual([{...active, reason: 'Protected by live reservation'}]);
    expect(result.prune).toEqual([{...other, reason: 'Expired age'}]);
  });
});
