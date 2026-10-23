/** #4389 — exercise the real drain with hermetic git/gh shims; no real PRs are touched. */
import { daemonAppEnv } from './fixtures/daemon-app-env.mjs';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPrPageFixture } from './fixtures/open-pr-page-fixture.mjs';
import * as drain from '../merge-ai-prs.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs');
const source = readFileSync(script, 'utf8');
const catchStart = source.indexOf('} catch (e) {', source.indexOf('// #2412 Gap 2 — the before-land trace'));
const catchEnd = source.indexOf('\n      }\n        },\n      });', catchStart);
const mergeCatch = source.slice(catchStart, catchEnd);

const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const openPrPageFixture = ${openPrPageFixture};
const prs = JSON.parse(fs.readFileSync(process.env.ISOLATION_FIXTURE, 'utf8'));
const landed = n => fs.existsSync(process.env.ISOLATION_FIXTURE + '.merged-' + n);
const out = x => { process.stdout.write(JSON.stringify(x)); process.exit(0); };
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('main'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') out(prs.filter(p => !landed(p.number)));
// The drain's candidate listing reads small GraphQL pages (pr-list-paged.mjs); the shared fixture serves them.
if (a[0] === 'api' && a[1] === 'graphql') out(openPrPageFixture(prs.filter(p => !landed(p.number)), a.find(v => v.startsWith('query=')) || ''));
if (a[0] === 'pr' && a[1] === 'view') {
  const p = prs.find(p => String(p.number) === a[2]);
  if (!p) process.exit(1);
  out({ ...p, state: landed(p.number) ? 'MERGED' : 'OPEN', mergedAt: landed(p.number) ? '2026-09-30T00:00:00Z' : null });
}
if (a[0] === 'pr' && a[1] === 'merge') {
  fs.appendFileSync(process.env.ISOLATION_FIXTURE + '.attempts', a[2] + '\\n');
  if (a[2] === '2879' || process.env.ISOLATION_FAIL_ALL === '1') {
    process.stderr.write('GraphQL: Pull request is not mergeable\\n'); process.exit(1);
  }
  fs.writeFileSync(process.env.ISOLATION_FIXTURE + '.merged-' + a[2], '');
}
process.exit(0);
`;
const fakeGit = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'remote' && a[1] === 'get-url') process.stdout.write('git@github.com:fixture/drain-isolation.git\\n');
if (a[0] === 'diff') process.exit(1);
process.exit(0);
`;

function runCli({ failAll = false, watch = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'drain-isolation-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const [name, code] of [['gh', fakeGh], ['git', fakeGit]]) writeFileSync(join(bin, name), code, { mode: 0o755 });
    const fixture = join(dir, 'prs.json');
    writeFileSync(fixture, JSON.stringify([2879, 2880].map(number => ({
      number, title: `independent leaf ${number}`, body: 'A real summary.', headRefName: `lane/leaf-${number}`,
      baseRefName: 'main', headRefOid: `sha-${number}`, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' }],
      labels: [{ name: 'ready-to-merge' }], comments: [],
      commits: [{ oid: `sha-${number}`, authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }] }],
      files: [{ path: `backlog/leaf-${number}.md`, additions: 1, deletions: 0, changeType: 'ADDED' }],
    }))));
    // Keep the real lock implementation, but isolate its os.homedir()-based state from the resident drain.
    const preload = 'data:text/javascript,' + encodeURIComponent("import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.ISOLATION_HOME; syncBuiltinESMExports();");
    const r = spawnSync(process.execPath, ['--import', preload, script, '--this-repo', '--label=ready-to-merge',
      '--no-reconcile-labels', '--no-drain-lease', '--no-red-main-freeze', '--json',
      ...(watch ? ['--watch', '--interval=1', '--max-idle=1'] : [])], {
      cwd: dir, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, ...daemonAppEnv(dir), PATH: `${bin}:${process.env.PATH}`, ISOLATION_FIXTURE: fixture,
        ISOLATION_HOME: dir, ISOLATION_FAIL_ALL: failAll ? '1' : '0' },
    });
    expect(r.error, r.stderr).toBeUndefined();
    const result = JSON.parse(r.stdout.trim().split('\n').at(-1));
    const attempts = readFileSync(fixture + '.attempts', 'utf8').trim().split('\n').map(Number);
    if (process.env.DRAIN_ISOLATION_PROOF) console.log(JSON.stringify({ watch, failAll, status: r.status, attempts, result }));
    return { status: r.status, result, attempts };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('#4389 merge failure isolation', () => {
  it('wires stderr extraction into the actual merge catch', () => {
    expect(catchStart).toBeGreaterThan(-1);
    expect(catchEnd).toBeGreaterThan(catchStart);
    expect(mergeCatch).toMatch(/const detail = ghListErrText\(e\);/);
  });

  it('preserves the complete GitHub enqueue diagnostic instead of the wrapper error', () => {
    const githubMessage = `Pull request has merge conflicts\n${'diagnostic detail '.repeat(30)}`;
    const error = Object.assign(new Error('enqueue FAILED — retried next pass'), {
      githubMessage, stderr: 'wrapper stderr',
    });
    expect(drain.ghListErrText(error)).toBe(githubMessage);
  });

  it.each([undefined, null])('keeps the merge stderr cause when githubMessage is %s', (githubMessage) => {
    const error = Object.assign(new Error('Command failed: gh pr merge 2879\nwrapper details'), {
      githubMessage, stderr: Buffer.from('warning\nGraphQL: Pull request is not mergeable\n'),
    });
    expect(drain.ghListErrText(error)).toBe('Command failed: gh pr merge 2879 — gh: GraphQL: Pull request is not mergeable');
  });

  it('preserves an explicitly empty GitHub diagnostic', () => {
    expect(drain.ghListErrText(Object.assign(new Error('wrapper error'), { githubMessage: '' }))).toBe('');
  });

  it('continues after the first failure, keeps its cause, and exits successfully', () => {
    const { status, result, attempts } = runCli();
    expect(attempts).toEqual([2879, 2880]);
    expect(result.merged.map(p => p.num)).toEqual([2880]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ num: 2879, detail: expect.stringContaining('not mergeable') });
    expect(result.ok).toBe(true);
    expect(status).toBe(0);
  }, 30000);

  it('still exits 2 when both merges fail', () => {
    const { status, result, attempts } = runCli({ failAll: true });
    expect(attempts).toEqual([2879, 2880]);
    expect(result.merged).toEqual([]);
    expect(result.failed.map(p => p.num)).toEqual([2879, 2880]);
    expect(status).toBe(2);
  }, 30000);

  it('watch uses all landed PRs even when the final pass only fails', () => {
    const { status, result, attempts } = runCli({ watch: true });
    expect(attempts).toEqual([2879, 2880, 2879]);
    expect(result.passes).toBe(2);
    expect(result.merged.map(p => p.num)).toEqual([2880]);
    expect(result.lastFailed).toHaveLength(1);
    expect(result.lastFailed[0].detail).toContain('not mergeable');
    expect(status).toBe(0);
  }, 30000);

  it.each([
    [{ dup: [1], failed: [], mergedCount: 0 }, 3],
    [{ dup: [1], failed: [{}], mergedCount: 1 }, 3],
    [{ dup: [], failed: [{}], mergedCount: 1 }, 0],
    [{ failed: [{}], mergedCount: 0 }, 2],
    [{ failed: [], mergedCount: 0 }, 0],
    [{}, 0],
  ])('passExitCode(%j) returns %i', (input, expected) => {
    expect(drain.passExitCode(input)).toBe(expected);
  });

  it('the actual rebased failure branch records pendingRebased, not failed', () => {
    // Execute the production catch itself to cover this guard without simulating an unrelated git rebuild.
    const executeCatch = new Function('e', 'c', 'ghListErrText', `
      const remaining = [c], pendingRebased = [], failedMerges = [];
      const AS_JSON = true;
      const isPrAlreadyMerged = () => false;
      const sameCand = (a, b) => a.num === b.num;
      const noteSplit = () => {};
      for (let once = 0; once < 1; once++) {
        try { throw e; ${mergeCatch}
      }
      return { pendingRebased, failedMerges, decision: c.decision };
    `);
    const result = executeCatch(new Error('checks pending'), { num: 2879, rebaseDrop: 'rebased' }, drain.ghListErrText);
    expect(result).toEqual({ pendingRebased: [2879], failedMerges: [], decision: 'skip' });
    expect(drain.passExitCode({ failed: result.failedMerges, mergedCount: 0 })).toBe(0);
  });
});
