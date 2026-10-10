/**
 * Card x4y74wj (#5671) — the drain's post-merge follow-up handed to a detached `drain-followup` job.
 * A1: through the REAL drain CLI (hermetic gh/git shims, the merge-queue-hook wiring harness shape): with the switch
 * on (built-in default) a pass that lands a local PR records exactly ONE job carrying the pass's landed set, and the
 * inline numbering / derived regen never run; with the switch off the inline path is unchanged and no job exists.
 * Plus the hook's own contract (fallback to inline, setting cascade, the deps link).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DRAIN_FOLLOWUP_KIND, ensureDepsLink, followupWorktreeLayout, handOffDrainFollowup, resolveDrainFollowupSetting,
} from '../drain-followup-job.mjs';
import { createJobStore, launchJob, reattachTick } from '../daemon-jobs-runtime.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'merge-ai-prs.mjs');

const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const F = process.env.FU_FIXTURE;
const prs = JSON.parse(fs.readFileSync(F, 'utf8'));
const landed = n => fs.existsSync(F + '.merged-' + n);
const out = x => { process.stdout.write(JSON.stringify(x)); process.exit(0); };
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('main'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') out(prs.filter(p => !landed(p.number)));
if (a[0] === 'pr' && a[1] === 'view') {
  const p = prs.find(p => String(p.number) === a[2]);
  if (!p) process.exit(1);
  out({ ...p, state: landed(p.number) ? 'MERGED' : 'OPEN', mergedAt: landed(p.number) ? '2026-10-10T00:00:00Z' : null });
}
if (a[0] === 'pr' && a[1] === 'merge') { fs.appendFileSync(F + '.attempts', a[2] + '\\n'); fs.writeFileSync(F + '.merged-' + a[2], ''); process.exit(0); }
if (a[0] === 'api') {
  let m;
  if (/\\/branches\\/main$/.test(a[1])) out({ sha: 'tip' });
  if ((m = /pulls\\/(\\d+)\\/files/.exec(a[1]))) out([[{ filename: 'backlog/leaf-' + m[1] + '.md' }]]);
}
process.exit(0);
`;
// Beyond the drain's own reads, the shim answers what the follow-up job's worktree preparer asks: \`worktree add\`
// makes a stub linked worktree (the stub entry exits at once — the job is never run to completion here), and
// \`rev-parse --git-dir / --git-common-dir\` differ so it passes the linked-worktree check. FU_BREAK_WORKTREE makes
// \`worktree add\` fail, which is the launch failure the inline fallback must cover.
const fakeGit = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const a = process.argv.slice(2);
if (a[0] === 'remote' && a[1] === 'get-url') process.stdout.write('git@github.com:fixture/drain-fu.git\\n');
if (a[0] === 'diff') process.exit(1);
if (a[0] === 'rev-parse' && a[1] === '--git-dir') process.stdout.write('.git\\n');
if (a[0] === 'rev-parse' && a[1] === '--git-common-dir') process.stdout.write('/fake-common/.git\\n');
if (a[0] === 'worktree' && a[1] === 'add') {
  if (process.env.FU_BREAK_WORKTREE) { process.stderr.write('fatal: simulated worktree add failure\\n'); process.exit(128); }
  const dir = a[a.length - 2];
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /fake-common/.git/worktrees/x\\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'drain-followup-job.mjs'), 'process.exit(0);\\n');
}
process.exit(0);
`;

function runCli({ env: extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'drain-fu-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const [name, code] of [['gh', fakeGh], ['git', fakeGit]]) writeFileSync(join(bin, name), code, { mode: 0o755 });
    const fixture = join(dir, 'prs.json');
    writeFileSync(fixture, JSON.stringify([3001].map((number) => ({
      number, title: `leaf ${number}`, body: 'A real summary.', headRefName: `lane/leaf-${number}`,
      baseRefName: 'main', headRefOid: `sha-${number}`, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' }],
      labels: [{ name: 'ready-to-merge' }], comments: [],
      commits: [{ oid: `sha-${number}`, authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }] }],
      files: [{ path: `backlog/leaf-${number}.md`, additions: 1, deletions: 0 }],
    }))));
    const preload = 'data:text/javascript,' + encodeURIComponent("import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.FU_HOME; syncBuiltinESMExports();");
    const jobsRoot = join(dir, 'jobs');
    const r = spawnSync(process.execPath, ['--import', preload, script, '--this-repo', '--label=ready-to-merge',
      '--no-reconcile-labels', '--no-drain-lease', '--no-red-main-freeze', '--json'], {
      cwd: dir, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FU_FIXTURE: fixture, FU_HOME: dir, HOME: dir,
        WE_DAEMON_JOBS_ROOT: jobsRoot, WE_COORDINATION_ROOT: join(dir, 'coord'), ...extraEnv },
    });
    expect(r.error, r.stderr).toBeUndefined();
    const result = JSON.parse(r.stdout.trim().split('\n').at(-1));
    const jobsDir = join(jobsRoot, DRAIN_FOLLOWUP_KIND);
    const jobs = existsSync(jobsDir) ? createJobStore(jobsDir).list().records : [];
    return { result, stderr: r.stderr, jobs };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('x4y74wj — the drain hands its post-merge follow-up to a detached job', () => {
  it('switch ON (built-in default): one drain-followup job carrying the landed set; no inline numbering or regen', () => {
    const { result, stderr, jobs } = runCli();
    expect(result.merged.map((m) => m.num)).toEqual([3001]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].job.kind).toBe(DRAIN_FOLLOWUP_KIND);
    expect(jobs[0].input).toMatchObject({ landedLocal: true, merged: [{ num: 3001 }] });
    expect(Array.isArray(jobs[0].input.landedItems)).toBe(true);
    expect(Array.isArray(jobs[0].input.openHeadRefs)).toBe(true);
    expect(result.followupJob).toMatchObject({ handedOff: true, job: { id: jobs[0].id } });
    // The job really started: a record that FAILED at launch (worktree could not be prepared) is not a hand-off.
    expect(jobs[0].job.status).not.toBe('failed');
    expect(result.followupJob.job.status).not.toBe('failed');
    // The pass still fast-forwards its OWN checkout inline (the duplicate-id tripwire reads it); the job only
    // syncs a separate primary.
    expect(result.localSynced).toBe(true);
    // The inline derived regen never ran (inline, its two generators are attempted — and fail in this bare dir).
    expect(result.derivedFailed).toEqual([]);
    expect(result.timings.jitNumbering).toBeUndefined();
    expect(result.timings.derivedRegen).toBeUndefined();
    expect(stderr).toMatch(/follow-up handed to job job-drain-followup-/);
  }, 30000);

  it('the job fails at launch (worktree cannot be prepared): the pass keeps its inline follow-up — numbering is not dropped', () => {
    const { result, stderr, jobs } = runCli({ env: { FU_BREAK_WORKTREE: '1' } });
    expect(result.merged.map((m) => m.num)).toEqual([3001]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].job.status).toBe('failed');
    expect(result.followupJob).toMatchObject({ handedOff: false, job: { id: jobs[0].id, status: 'failed' } });
    expect(result.followupJob.reason).toMatch(/^launch-failed: .*could not prepare code/);
    // The inline path ran: its two derived generators are attempted (and fail in this bare dir), as with the switch off.
    expect(result.derivedFailed.map((f) => f.cmd)).toEqual(['npm run gen:inventory', 'npm run gen:reference-index']);
    expect(stderr).not.toMatch(/follow-up handed to job/);
    expect(stderr).toMatch(/the job did not start .* running the follow-up inline/);
  }, 30000);

  it('switch OFF (tool override): the inline path runs as before and no job is recorded', () => {
    const { result, jobs } = runCli({ env: { WE_DRAIN_FOLLOWUP_JOB: 'off' } });
    expect(result.merged.map((m) => m.num)).toEqual([3001]);
    expect(jobs).toEqual([]);
    expect(result.followupJob).toBeUndefined();
    expect(result.derivedFailed.map((f) => f.cmd)).toEqual(['npm run gen:inventory', 'npm run gen:reference-index']);
  }, 30000);
});

describe('handOffDrainFollowup', () => {
  const on = { value: 'on', source: 'default' };
  const fresh = () => createJobStore(mkdtempSync(join(tmpdir(), 'fu-store-')));
  const noTick = async () => ({ actions: [] });

  it('off → inline, nothing recorded', async () => {
    const store = fresh();
    const out = await handOffDrainFollowup({ landed: true, buildInput: () => ({ landedLocal: true }), setting: { value: 'off', source: 'env' }, store, reattach: noTick });
    expect(out).toMatchObject({ handedOff: false, mode: 'inline' });
    expect(store.list().records).toEqual([]);
  });

  it('nothing landed → no job, but the reattach tick still runs (resumes a job a dead daemon left)', async () => {
    const store = fresh();
    let ticks = 0;
    const out = await handOffDrainFollowup({ landed: false, buildInput: () => { throw new Error('not called'); }, setting: on, store, reattach: async () => { ticks += 1; return { actions: [] }; }, prepareWorktree: () => '/x' });
    expect(out).toMatchObject({ handedOff: false, mode: 'job', job: null });
    expect(ticks).toBe(1);
    expect(store.list().records).toEqual([]);
  });

  it('landed → exactly one queued record, handed off', async () => {
    const store = fresh();
    const out = await handOffDrainFollowup({ landed: true, buildInput: () => ({ landedLocal: true, landedItems: ['7'] }), setting: on, store, reattach: noTick, prepareWorktree: () => '/x' });
    expect(out.handedOff).toBe(true);
    const recs = store.list().records;
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ input: { landedItems: ['7'] }, job: { kind: DRAIN_FOLLOWUP_KIND, status: 'queued' } });
  });

  it('an enqueue failure falls back to inline — the numbering is never dropped', async () => {
    const out = await handOffDrainFollowup({ landed: true, buildInput: () => { throw new Error('boom'); }, setting: on, store: fresh(), reattach: noTick, prepareWorktree: () => '/x' });
    expect(out).toMatchObject({ handedOff: false, mode: 'inline' });
    expect(out.reason).toMatch(/enqueue-failed: boom/);
  });

  it('a job the tick failed at launch (prepareWorktree throws) is NOT a hand-off: inline fallback, the failed record is reported', async () => {
    const store = fresh();
    const out = await handOffDrainFollowup({
      landed: true, buildInput: () => ({ landedLocal: true }), setting: on, store, reattach: reattachTick,
      prepareWorktree: () => { throw new Error('git fetch: network blip'); },
    });
    expect(out).toMatchObject({ handedOff: false, mode: 'inline', job: { status: 'failed' } });
    expect(out.reason).toMatch(/^launch-failed: could not prepare code: git fetch: network blip/);
    expect(store.list().records).toHaveLength(1); // terminal — nothing will run it, so no duplicate of the inline run
  });

  it('a launched job (spawned by the tick) stays handed off', async () => {
    const store = fresh();
    const worktree = mkdtempSync(join(tmpdir(), 'fu-wt-'));
    mkdirSync(join(worktree, 'scripts'));
    writeFileSync(join(worktree, 'scripts', 'drain-followup-job.mjs'), 'process.exit(0);\n');
    const out = await handOffDrainFollowup({
      landed: true, buildInput: () => ({ landedLocal: true }), setting: on, store, prepareWorktree: () => worktree,
      reattach: (o) => reattachTick({ ...o, launch: (l) => launchJob({ ...l, spawnFn: () => 4242 }) }),
    });
    expect(out.handedOff).toBe(true);
    expect(out.job.status).not.toBe('failed');
  });

  it('a reattach failure keeps the hand-off (the job stays queued for the next pass)', async () => {
    const out = await handOffDrainFollowup({ landed: true, buildInput: () => ({ landedLocal: true }), setting: on, store: fresh(), reattach: async () => { throw new Error('tick'); }, prepareWorktree: () => '/x' });
    expect(out).toMatchObject({ handedOff: true, job: { status: 'queued' } });
  });
});

describe('resolveDrainFollowupSetting — policy cascade', () => {
  const file = (v) => { const d = mkdtempSync(join(tmpdir(), 'fu-set-')); const f = join(d, 's.json'); writeFileSync(f, JSON.stringify({ drainFollowupJob: v })); return f; };
  it('built-in on; settings file over it; env over both; junk falls through', () => {
    expect(resolveDrainFollowupSetting({ env: {}, file: '/nope.json' })).toEqual({ value: 'on', source: 'default' });
    expect(resolveDrainFollowupSetting({ env: {}, file: file('off') })).toEqual({ value: 'off', source: 'settings' });
    expect(resolveDrainFollowupSetting({ env: { WE_DRAIN_FOLLOWUP_JOB: 'on' }, file: file('off') })).toEqual({ value: 'on', source: 'env' });
    expect(resolveDrainFollowupSetting({ env: { WE_DRAIN_FOLLOWUP_JOB: 'maybe' }, file: file('nah') })).toEqual({ value: 'on', source: 'default' });
  });
  it('the shipped platform preference is on', () => {
    expect(resolveDrainFollowupSetting({ env: {} }).value).toBe('on');
  });
});

describe('the job worktree finds the clone deps through a parent-directory link', () => {
  it('layout keeps the worktree and its deps link outside the clone, keyed by the clone', () => {
    const env = { WE_DAEMON_JOBS_ROOT: '/jobs' };
    const a = followupWorktreeLayout({ repoDir: '/nope/a', env });
    const b = followupWorktreeLayout({ repoDir: '/nope/b', env });
    expect(a.worktreeDir).toBe(join(a.base, 'main'));
    expect(a.depsLink).toBe(join(a.base, 'node_modules'));
    expect(a.depsTarget).toBe('/nope/a/node_modules');
    expect(a.base.startsWith('/jobs/drain-followup-worktrees/')).toBe(true);
    expect(a.base).not.toBe(b.base);
  });
  it('ensureDepsLink creates, keeps, and re-points the link; no target → no link', () => {
    const d = mkdtempSync(join(tmpdir(), 'fu-link-'));
    const t1 = join(d, 'c1', 'node_modules');
    const t2 = join(d, 'c2', 'node_modules');
    mkdirSync(t1, { recursive: true });
    mkdirSync(t2, { recursive: true });
    const link = join(d, 'wt', 'node_modules');
    expect(ensureDepsLink({ link, target: join(d, 'absent') })).toBe(false);
    expect(existsSync(link)).toBe(false);
    expect(ensureDepsLink({ link, target: t1 })).toBe(true);
    expect(readlinkSync(link)).toBe(t1);
    expect(ensureDepsLink({ link, target: t2 })).toBe(true);
    expect(readlinkSync(link)).toBe(t2);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(join(d, 'wt'))).toEqual(['node_modules']);
  });
});
