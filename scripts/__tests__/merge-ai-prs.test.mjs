/**
 * @file scripts/__tests__/merge-ai-prs.test.mjs
 * @description The drain's graduatedTo RESOLUTION BASIS surface (#2447). (The original monolithic file of this
 *   name was split into the `merge-ai-prs-*.test.mjs` siblings; this one covers only the #2447 slice.) A
 *   backlog-only PR that resolves its item via `graduatedTo` must lead its durable park/skip comment with the
 *   "no code change — deliverable already landed" banner, while every other PR's comment — and the dedupe keyed
 *   on its text — stays byte-identical. Also the non-default-base hold (#3674, ruled #3805 Fork 2 (a)): a PR whose
 *   base is not the repo's default branch is skipped with `base is not <default> (<base>)`.
 */
import { describe, it, expect, vi } from 'vitest';
import { withResolutionBasis, buildDrainReasonComment, hasDrainReasonComment, buildDrainVerdicts, classifyPr, isRebaseDropCandidate, buildLiveListingsByRepo } from '../merge-ai-prs.mjs';
import { readFastDrainRoundListing, withFastDrainRoundLock } from '../lib/fast-drain-scope.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { daemonAppEnv } from './fixtures/daemon-app-env.mjs';
import { buildManifest, manifestBodyBlock } from '../readiness/lane-manifest.mjs';
import { deriveResolutionBasis, graduatedToFromBody } from '../lib/review-render.mjs';

describe('withResolutionBasis — the drain park/skip comment (#2447)', () => {
  const reason = 'branch is BEHIND main — rebase needed';

  it('leads the comment with the banner for a backlog-only graduatedTo resolve', () => {
    // Mirrors the drain's own derivation inputs: the body note extracted at verdict-build, the PR's file set.
    const basis = deriveResolutionBasis({
      bodyGraduatedTo: graduatedToFromBody('Resolves #2403.\n\ngraduatedTo: 6b5874f7\n'),
      changedFiles: ['backlog/2403-review-disposition.md'],
    });
    const comment = buildDrainReasonComment('skip', withResolutionBasis(reason, basis), null);
    expect(comment).toContain('`graduatedTo: 6b5874f7` — no code change — deliverable already landed in `6b5874f7`');
    expect(comment.indexOf('Resolution basis')).toBeLessThan(comment.indexOf(reason));
    expect(hasDrainReasonComment([{ body: comment }], 'skip', withResolutionBasis(reason, basis), null)).toBe(true);
  });

  it('returns the reason UNCHANGED for a code resolve, a missing basis, or an empty reason', () => {
    const codeBasis = deriveResolutionBasis({ bodyGraduatedTo: '6b5874f7', changedFiles: ['backlog/2403-x.md', 'scripts/x.mjs'] });
    expect(codeBasis).toBe(null);
    expect(withResolutionBasis(reason, codeBasis)).toBe(reason);
    expect(withResolutionBasis(reason, undefined)).toBe(reason);
    expect(withResolutionBasis('', { graduatedTo: '6b5874f7', ref: '6b5874f7' })).toBe('');
    expect(withResolutionBasis(null, { graduatedTo: '6b5874f7', ref: '6b5874f7' })).toBe(null);
  });
});

describe('buildDrainVerdicts — carries the graduatedTo sources the escalation pass derives the basis from (#2447)', () => {
  const green = [{ name: 'test', conclusion: 'SUCCESS' }];
  const ghPr = (number, body) => ({ number, title: 't', body, headRefName: `lane/${number}-x`, statusCheckRollup: green, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: [{ name: 'ready-to-merge' }] });
  const verdictFor = (pr, manifest) => buildDrainVerdicts({ prsByRepo: new Map([[null, [pr]]]), readOf: () => ({ commits: [{ oid: 'abc' }], manifest }), repos: [null] })[0];

  it('attaches the manifest graduatedTo and the body note, which derive the banner for a backlog-only diff', () => {
    const manifest = buildManifest({ item: 2403, repos: [{ repo: 'we', ref: 'lane/2403-x' }], graduatedTo: '6b5874f7' });
    const v = verdictFor(ghPr(421, 'Dedup-resolve.\n\ngraduatedTo: b54f49a8\n'), manifest);
    expect(v.manifestGraduatedTo).toBe('6b5874f7');
    expect(v.bodyGraduatedTo).toBe('b54f49a8');
    // the escalation pass's exact derivation call, over a backlog-only file set — the manifest wins
    const basis = deriveResolutionBasis({ manifest: { graduatedTo: v.manifestGraduatedTo }, bodyGraduatedTo: v.bodyGraduatedTo, changedFiles: ['backlog/2403-x.md'], crossRepo: v.crossRepo });
    expect(basis).toMatchObject({ ref: '6b5874f7', source: 'manifest' });
  });

  it('a plain PR carries null sources', () => {
    const v = verdictFor(ghPr(422, 'what changed and why'), null);
    expect(v.manifestGraduatedTo).toBe(null);
    expect(v.bodyGraduatedTo).toBe(null);
  });
});

describe('classifyPr — base is not the default branch: held with a named reason (#3674)', () => {
  const green = [{ name: 'test', conclusion: 'SUCCESS' }];
  const ghPr = (number, baseRefName, extra = {}) => ({ number, title: 't', body: 'what changed and why', headRefName: `lane/${number}-x`, baseRefName, statusCheckRollup: green, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: [{ name: 'ready-to-merge' }], ...extra });
  // The drain's real wiring: runCli resolves each repo's default branch and threads it as `defaultBranchOf`.
  const verdictFor = (pr, defaultBranchOf) => buildDrainVerdicts({ prsByRepo: new Map([[null, [pr]]]), readOf: () => ({ commits: [{ oid: 'abc' }], manifest: null }), repos: [null], defaultBranchOf })[0];

  it('base is not main (lane/mechanical-dispatcher): skipped with the exact reason, even with `test` green', () => {
    const v = verdictFor(ghPr(2198, 'lane/mechanical-dispatcher'), () => 'main');
    expect(v.testGreen).toBe(true);
    expect(v.decision).toBe('skip');
    expect(v.reason).toBe('base is not main (lane/mechanical-dispatcher)');
    expect(v.reviewHeld).toBe(false);
  });

  it('base is not <default>: the arm sits ahead of the required-check arm (a red `test` still names the base)', () => {
    const v = classifyPr(ghPr(2156, 'lane/mechanical-dispatcher', { statusCheckRollup: [] }), { defaultBranch: 'main' });
    expect(v.testGreen).toBe(false);
    expect(v.reason).toBe('base is not main (lane/mechanical-dispatcher)');
  });

  it('base is not <default> compares against the INJECTED default branch, never a literal main', () => {
    const onTrunk = verdictFor(ghPr(10, 'trunk'), () => 'trunk');
    expect(onTrunk.decision).toBe('merge');
    const onMain = verdictFor(ghPr(11, 'main'), () => 'trunk');
    expect(onMain.decision).toBe('skip');
    expect(onMain.reason).toBe('base is not trunk (main)');
  });

  it('base is not <default>: a PR on the default branch is unaffected; an unresolved default still holds a lane/* base', () => {
    const onDefault = verdictFor(ghPr(12, 'main'), () => 'main');
    expect(onDefault.decision).toBe('merge');
    expect(onDefault.reason).toBe(classifyPr(ghPr(12, 'main')).reason);
    // stack.reviewWhileBaseOpen (2026-10-10): a stacked lane PR now runs CI, so its `test` can be green. A failed
    // default-branch read must not let it land into its lane base: a lane/* base is held fail-closed.
    const stacked = verdictFor(ghPr(13, 'lane/mechanical-dispatcher'), () => null);
    expect(stacked.decision).toBe('skip');
    expect(stacked.reason).toBe('base is not the default branch (lane/mechanical-dispatcher)');
  });

  it('base is not <default>: the held PR is never a rebase-drop candidate (the rebase pass would re-flip it to merge)', () => {
    const behind = ghPr(14, 'lane/mechanical-dispatcher', { mergeStateStatus: 'BEHIND' });
    const v = verdictFor(behind, () => 'main');
    expect(v.reason).toBe('base is not main (lane/mechanical-dispatcher)');
    expect(isRebaseDropCandidate(v)).toBe(false);
    expect(isRebaseDropCandidate(verdictFor(ghPr(15, 'main', { mergeStateStatus: 'BEHIND' }), () => 'main'))).toBe(true);
  });
});


describe('fast-drain round listing snapshot', () => {
  const repo = 'owner/repo';
  const now = 1_000_000;
  const old = { number: 42, headRefOid: 'old', labels: [{ name: 'ready-to-merge' }], baseRefName: 'main', body: 'Ready change', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  const snap = (extra = {}) => JSON.stringify({ repo, writtenAt: now - 1000, rows: [old], ...extra });
  const probe = async (raw, extra = {}) => {
    const live = vi.fn(async () => [old]);
    const target = vi.fn(async () => ({ ...old, state: 'OPEN', headRefOid: 'new', labels: [...old.labels, { name: 'review:changes' }] }));
    const write = vi.fn();
    const log = vi.fn();
    const result = await readFastDrainRoundListing({ path: 'round.json', repo, onlyPr: '42', now, env: {},
      read: () => raw, write, listLive: live, readTarget: target, log, lock: async fn => ({ ok: true, value: await fn() }), ...extra });
    return { result, live, target, write, log };
  };
  it('uses fresh same-repo rows and still re-reads and reclassifies the moved target', async () => {
    const { result, live, target, log } = await probe(snap());
    expect(live).not.toHaveBeenCalled();
    expect(target).toHaveBeenCalledOnce();
    expect(result[0].headRefOid).toBe('new');
    expect(classifyPr(old).decision).toBe('merge');
    expect(classifyPr(result[0])).toMatchObject({ decision: 'skip', reviewHeld: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('served-from-snapshot'));
  });
  it.each([
    ['stale', () => snap({ writtenAt: now - 180_001 })],
    ['other repo', () => snap({ repo: 'other/repo' })],
    ['malformed JSON', () => '{'],
    ['malformed rows', () => snap({ rows: [null] })],
    ['missing fields', () => snap({ rows: [{ number: 42 }] })],
    ['future date', () => snap({ writtenAt: now + 1000 })],
    ['missing date', () => snap({ writtenAt: null })],
  ])('falls back live for %s and refreshes the snapshot', async (_reason, raw) => {
    const { live, target, write, log } = await probe(raw());
    expect(live).toHaveBeenCalledOnce();
    expect(target).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('round.json', expect.objectContaining({ repo, writtenAt: now, rows: [old] }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('listed-live'));
  });
  it('falls back live when unreadable and honors the TTL override', async () => {
    expect((await probe(null, { read: () => { throw new Error('EACCES'); } })).live).toHaveBeenCalledOnce();
    expect((await probe(snap(), { env: { WE_FAST_DRAIN_LISTING_SNAPSHOT_TTL_SEC: '0' } })).live).toHaveBeenCalledOnce();
  });
  it('never serves the cached target when its live read fails', async () => {
    await expect(probe(snap(), { readTarget: async () => { throw new Error('target unreadable'); } })).rejects.toThrow('target unreadable');
  });
  it('uses a longer TTL override and logs the effective fallback for an invalid TTL', async () => {
    expect((await probe(snap({ writtenAt: now - 200_000 }), { env: { WE_FAST_DRAIN_LISTING_SNAPSHOT_TTL_SEC: '300' } })).live).not.toHaveBeenCalled();
    const { live, log } = await probe(snap(), { env: { WE_FAST_DRAIN_LISTING_SNAPSHOT_TTL_SEC: 'NaN' } });
    expect(live).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('TTL=180s, source=standard'));
  });
  it('falls back live for an oversized snapshot', async () => {
    expect((await probe(' '.repeat(64 * 1024 * 1024 + 1))).live).toHaveBeenCalledOnce();
  });
  it('falls back to a live listing on population-lock timeout', async () => {
    const { live, log } = await probe(null, { lock: async () => ({ ok: false, reason: 'timeout' }) });
    expect(live).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cache lock unavailable, live fallback'));
  });
  it('falls back live when the lock directory is unwritable', async () => {
    expect((await probe(null, { lock: async () => { throw new Error('EACCES'); } })).live).toHaveBeenCalledOnce();
  });
  it('re-evaluates new-head failed checks instead of the cached green checks', async () => {
    const { result } = await probe(snap(), { readTarget: async () => ({ ...old, state: 'OPEN', headRefOid: 'moved',
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
    }) });
    expect(classifyPr(old).decision).toBe('merge');
    expect(classifyPr(result[0])).toMatchObject({ decision: 'skip', reason: 'required check "test" is not green' });
  });
  it('continues with live rows when the snapshot cannot be written', async () => {
    const { result, live, target } = await probe(null, { write: () => { throw new Error('EACCES'); } });
    expect(live).toHaveBeenCalledOnce();
    expect(target).toHaveBeenCalledOnce();
    expect(result[0].headRefOid).toBe('new');
  });
  it('atomically populates one real round file under concurrent readers and re-reads every target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fast-drain-round-'));
    const path = join(dir, 'round.json');
    const live = vi.fn(async () => [old]);
    const target = vi.fn(async () => ({ ...old, state: 'OPEN', headRefOid: 'fresh' }));
    try {
      const run = owner => readFastDrainRoundListing({ path, repo, onlyPr: 42, listLive: live,
        readTarget: target, defaultBranch: () => 'main', log: () => {},
        lock: fn => withFastDrainRoundLock(path, fn, { owner, pollMs: 1, waitMs: 1000 }),
      });
      const rows = await Promise.all([run('first-child'), run('second-child')]);
      expect(live).toHaveBeenCalledOnce();
      expect(target).toHaveBeenCalledTimes(2);
      expect(rows.map(r => r[0].headRefOid)).toEqual(['fresh', 'fresh']);
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      expect(saved).toMatchObject({ repo, rows: [old], defaultBranch: 'main' });
      expect(saved.writtenAt).toEqual(expect.any(Number));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});


describe('round listing freshness at the CLI boundary', () => {
  it('never places round snapshot rows in the live context cache', () => {
    expect(buildLiveListingsByRepo([{ repo: 'fixture/repo', rows: [{ number: 42 }], listing: 'snapshot' }]).has('fixture/repo')).toBe(false);
  });

  const run = (listing) => {
    const dir = mkdtempSync(join(tmpdir(), 'drain-round-cli-'));
    try {
      const row = (number, item, blockedBy = []) => ({ number, title: `PR ${number}`, state: 'OPEN',
        headRefName: `lane/${number}`, headRefOid: `sha${number}`, baseRefName: 'main', updatedAt: '2026-01-01T00:00:00Z',
        isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', files: [],
        labels: [{ name: 'ready-to-merge' }], statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', checkSuite: { workflowRun: { workflow: { name: 'test' } } } }],
        body: manifestBodyBlock(buildManifest({ item, blockedBy, repos: [{ repo: 'we', ref: `lane/${number}` }] })) });
      const target = row(42, 42, ['43']);
      const sibling = row(43, 43);
      const snapshot = join(dir, 'round.json');
      writeFileSync(snapshot, JSON.stringify({ repo: 'fixture/repo', writtenAt: Date.now(), defaultBranch: 'main', rows: [target] }));
      writeFileSync(join(dir, 'rows.json'), JSON.stringify([target, sibling]));
      writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(a) + '\\n');
const rows = JSON.parse(fs.readFileSync(process.env.ROWS_FILE, 'utf8'));
let out = [];
if (a[0] === 'repo') out = 'main';
else if (a[0] === 'pr' && a[1] === 'view') out = { ...rows.find(r => r.number === Number(a[2])), commits: [] };
else if (a[0] === 'api' && a[1] === 'graphql') {
  const local = a.some(v => v.includes('owner:"fixture"'));
  const nodes = (local ? rows : []).map(r => ({ ...r, labels: { nodes: r.labels }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: r.statusCheckRollup } } } }] } }));
  out = { data: { repository: { pullRequests: { nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } } } } };
}
fs.writeSync(1, typeof out === 'string' ? out : JSON.stringify(out));
`);
      // All git operations are local fixture responses, including the CLI's identity probe.
      writeFileSync(join(dir, 'git'), '#!/bin/sh\nif [ "$1" = remote ]; then echo https://github.com/fixture/repo.git; exit 0; fi\nexit 1\n');
      for (const name of ['gh', 'git']) chmodSync(join(dir, name), 0o755);
      const result = spawnSync(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'),
        '--only=42', '--this-repo', '--label=ready-to-merge', '--dry-run', '--no-drain-lease', '--no-red-main-freeze', '--json', `--listing-snapshot=${snapshot}`], {
        cwd: dir, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...daemonAppEnv(dir), PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir,
          WE_FAST_DRAIN_LISTING: listing, WE_SHARED_SNAPSHOT: 'off', ROWS_FILE: join(dir, 'rows.json'), CALL_LOG: join(dir, 'calls.jsonl') },
      });
      expect(result.status, result.stderr).toBe(0);
      return { payload: JSON.parse(result.stdout.trim()), stderr: result.stderr,
        calls: readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  it('sees a blockedBy sibling opened after --listing-snapshot via live context collection', () => {
    const { payload, stderr, calls } = run('snapshot');
    expect(stderr).toContain('served-from-snapshot');
    expect(calls.some(a => a[0] === 'api' && a[1] === 'graphql' && a.some(v => v.includes('pullRequests(states:OPEN')))).toBe(true);
    expect(calls.some(a => a[0] === 'pr' && a[1] === 'view' && a[2] === '43' && a.includes('fixture/repo'))).toBe(true);
    expect(payload.deferred).toEqual(expect.arrayContaining([expect.objectContaining({ num: 42, waitOn: expect.arrayContaining([43]) })]));
  });
  it('ignores --listing-snapshot when WE_FAST_DRAIN_LISTING=live', () => {
    const { stderr, calls } = run('live');
    expect(stderr).not.toContain('served-from-snapshot');
    expect(calls.some(a => a[0] === 'api' && a[1] === 'graphql' && a.some(v => v.includes('pullRequests(states:OPEN')))).toBe(true);
    expect(calls.some(a => a[0] === 'repo' && a[1] === 'view')).toBe(true);
  });
});
