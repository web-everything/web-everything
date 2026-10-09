/**
 * Card xs1hdl7 — the merge-queue freshness hook, exercised through the REAL drain CLI with hermetic git/gh shims
 * (the #4389 isolation harness). Proves the merge-site wiring, not just the pure rule: a stale-pass PR is never
 * handed to `gh pr merge`, a fresh one merges unchanged, and with the hook off both merge (today).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs');
const NOW = Date.now();
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();

const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const F = process.env.MQ_FIXTURE;
const prs = JSON.parse(fs.readFileSync(F, 'utf8'));
const landed = n => fs.existsSync(F + '.merged-' + n);
const out = x => { process.stdout.write(JSON.stringify(x)); process.exit(0); };
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('main'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') out(prs.filter(p => !landed(p.number)));
if (a[0] === 'pr' && a[1] === 'view') {
  const p = prs.find(p => String(p.number) === a[2]);
  if (!p) process.exit(1);
  // MQ_UNKNOWN_FIRST: GitHub is still recomputing mergeability — the FIRST fresh read (the one that carries
  // mergeStateStatus) of each PR answers UNKNOWN, every later read answers the fixture's real value.
  const fresh = (a[a.indexOf('--json') + 1] || '').includes('mergeStateStatus');
  const seen = F + '.fresh-reads-' + p.number;
  const n = fs.existsSync(seen) ? Number(fs.readFileSync(seen, 'utf8')) : 0;
  if (fresh) fs.writeFileSync(seen, String(n + 1));
  const unknown = process.env.MQ_UNKNOWN_FIRST && fresh && n === 0;
  out({ ...p, ...(unknown ? { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' } : {}), state: landed(p.number) ? 'MERGED' : 'OPEN', mergedAt: landed(p.number) ? '2026-10-09T00:00:00Z' : null });
}
if (a[0] === 'pr' && a[1] === 'merge') { fs.appendFileSync(F + '.attempts', a[2] + '\\n'); fs.writeFileSync(F + '.merged-' + a[2], ''); process.exit(0); }
if (a[0] === 'run' && a[1] === 'rerun') { fs.appendFileSync(F + '.reruns', a[2] + '\\n'); process.exit(0); }
if (a[0] === 'api') {
  const path = a[1];
  fs.appendFileSync(F + '.api', path + '\\n');
  let m;
  if ((m = /commits\\/(sha-\\d+)\\/check-runs/.exec(path))) {
    const p = prs.find(p => p.headRefOid === m[1]);
    out([{ check_runs: [{ id: 7, name: 'test', head_sha: m[1], status: 'completed', conclusion: 'success',
      started_at: p.passAt, completed_at: p.passAt, details_url: 'https://github.com/o/r/actions/runs/99' + p.number + '/job/1' }] }]);
  }
  if (/\\/branches\\/main$/.test(path)) out({ sha: 'tip' });
  if ((m = /compare\\/(sha-\\d+)\\.\\.\\.tip$/.exec(path))) out({ base: 'base-' + m[1], ahead: 3, files: ['backlog/elsewhere.md'], n: 1 });
  if ((m = /pulls\\/(\\d+)\\/files/.exec(path))) out([[{ filename: 'backlog/leaf-' + m[1] + '.md' }]]);
}
process.exit(0);
`;
const fakeGit = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'remote' && a[1] === 'get-url') process.stdout.write('git@github.com:fixture/drain-mq.git\\n');
if (a[0] === 'diff') process.exit(1);
process.exit(0);
`;

function runCli({ hookOn, seedRefreshed = null, ages = [[3001, 5], [3002, 120]], mainFixPr = null, env: extraEnv = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'drain-mq-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // (the main-fix record names the WE repo by key, so that run's clone must read as WE: the couple shim's `origin`)
    for (const [name, code] of [['gh', fakeGh], ['git', mainFixPr ? fakeGitCouple : fakeGit]]) writeFileSync(join(bin, name), code, { mode: 0o755 });
    const fixture = join(dir, 'prs.json');
    // #3001: pass 5 min old (fresh). #3002: pass 120 min old (stale). Main moved only on a backlog card (non-code).
    writeFileSync(fixture, JSON.stringify(ages.map(([number, age]) => ({
      number, title: `leaf ${number}`, body: 'A real summary.', headRefName: `lane/leaf-${number}`,
      baseRefName: 'main', headRefOid: `sha-${number}`, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' }],
      labels: [{ name: 'ready-to-merge' }], comments: [], passAt: iso(age),
      commits: [{ oid: `sha-${number}`, authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }] }],
      files: [{ path: `backlog/leaf-${number}.md`, additions: 1, deletions: 0 }],
    }))));
    const settings = join(dir, 'merge-queue.json');
    writeFileSync(settings, JSON.stringify({
      mergeQueue: { enabled: hookOn, batchSize: 1 },
      mergeFreshness: { enabled: hookOn, maxAgeMinutes: 30, allowDisjointMainMoves: true },
    }));
    const coord = join(dir, 'coord');
    const statePath = join(coord, 'merge-queue-refreshed.json');
    if (seedRefreshed) { mkdirSync(coord, { recursive: true }); writeFileSync(statePath, JSON.stringify(seedRefreshed)); }
    // A published main-red-priority record in the shape planPriority really writes (`repo` is the constellation KEY,
    // `prs` every fix PR): PR `mainFixPr` owns the fix and must land first.
    const mainFixFile = join(dir, 'main-red-priority.json');
    if (mainFixPr) writeFileSync(mainFixFile, JSON.stringify({ repo: 'we', pr: mainFixPr, prs: [mainFixPr], firstRedSha: 'red', reason: 'owns the red-main fix', setAt: NOW, expiresAt: NOW + 3_600_000 }));
    const preload = 'data:text/javascript,' + encodeURIComponent("import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.MQ_HOME; syncBuiltinESMExports();");
    const r = spawnSync(process.execPath, ['--import', preload, script, '--this-repo', '--label=ready-to-merge',
      '--no-reconcile-labels', '--no-drain-lease', '--no-red-main-freeze', '--json'], {
      cwd: dir, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MQ_FIXTURE: fixture, MQ_HOME: dir,
        // hook OFF = no settings file at all: the built-in default (a test run never reads the live file)
        ...(hookOn ? { WE_MERGE_QUEUE_SETTINGS_FILE: settings } : {}), ...(mainFixPr ? { WE_MERGE_QUEUE_MAIN_FIX_FILE: mainFixFile } : {}),
        WE_COORDINATION_ROOT: coord, ...extraEnv },
    });
    expect(r.error, r.stderr).toBeUndefined();
    const result = JSON.parse(r.stdout.trim().split('\n').at(-1));
    const read = (s) => (existsSync(fixture + s) ? readFileSync(fixture + s, 'utf8').trim().split('\n').filter(Boolean) : []);
    const refreshed = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
    return { result, stderr: r.stderr, attempts: read('.attempts').map(Number), api: read('.api'), refreshed };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('card xs1hdl7 — merge-queue hook wired at the drain merge site', () => {
  it('hook ON: the fresh PR merges, the stale-pass PR never reaches gh pr merge and is refreshed instead', () => {
    const { result, stderr, attempts, api } = runCli({ hookOn: true });
    expect(attempts).toEqual([3001]);
    expect(result.merged.map((p) => p.num)).toEqual([3001]);
    expect(stderr).toMatch(/merge-queue: refresh \(pass-too-old\)/);
    expect(api.some((p) => p.includes('commits/sha-3002/check-runs'))).toBe(true);
  }, 30000);

  it('a refresh that did not go through is NOT recorded, so the next pass retries it', () => {
    // The shim `git ls-remote` prints no tip, so the head pin refuses the refresh (unreadable tip ≠ judged head).
    const { stderr, refreshed } = runCli({ hookOn: true });
    expect(stderr).toMatch(/merge-queue: refresh \(pass-too-old\) → \S+ failed/);
    expect(refreshed).toBeNull();
  }, 30000);

  // The record a refresh writes: the head AND the pass it was requested against (the fixture's check-run id is 7 and
  // its pass completed at `iso(120)`), plus when it was requested.
  const seedFor = (over = {}) => Object.fromEntries(['fixture/drain-mq#3002', 'cwd#3002'].map((k) => [k,
    { head: 'sha-3002', checkRunId: 7, completedAtMs: Date.parse(iso(120)), atMs: NOW, ...over }]));

  it('once per pass: a head refreshed against the pass still in force waits — no second refresh, no merge', () => {
    const { stderr, attempts } = runCli({ hookOn: true, seedRefreshed: seedFor() });
    expect(attempts).toEqual([3001]);
    expect(stderr).toMatch(/merge-queue: wait \(refresh-already-requested\)/);
  }, 30000);

  it('a rerun that finished (a newer pass on the same head) does not strand the head: it is refreshed again', () => {
    // Review of #4619: the record used to be head-only, so the head stayed `wait` after its rerun finished.
    const { stderr, attempts } = runCli({ hookOn: true, seedRefreshed: seedFor({ checkRunId: 6, completedAtMs: Date.parse(iso(300)) }) });
    expect(attempts).toEqual([3001]);
    expect(stderr).not.toMatch(/refresh-already-requested/);
    expect(stderr).toMatch(/merge-queue: refresh \(pass-too-old\)/);
  }, 30000);

  it('a legacy head-only record (key → head) does not park the head either', () => {
    const seed = Object.fromEntries(['fixture/drain-mq#3002', 'cwd#3002'].map((k) => [k, 'sha-3002']));
    const { stderr } = runCli({ hookOn: true, seedRefreshed: seed });
    expect(stderr).not.toMatch(/refresh-already-requested/);
    expect(stderr).toMatch(/merge-queue: refresh \(pass-too-old\)/);
  }, 30000);

  it('main-fix first (through the drain): the published main-fix PR lands before an older-numbered PR', () => {
    const both = [[3001, 5], [3002, 5]]; // both merge-fresh, so only the ORDER differs
    expect(runCli({ hookOn: true, ages: both }).attempts).toEqual([3001, 3002]); // control: no record → number order
    expect(runCli({ hookOn: true, ages: both, mainFixPr: 3002 }).attempts).toEqual([3002, 3001]);
  }, 60000);

  // Review of #4619 (test-coverage): the UNKNOWN-mergeability retry was only unit-tested as a helper. Through the real
  // CLI: the fresh pre-merge re-read answers UNKNOWN once (GitHub recomputing after the cascade's own previous merge),
  // the retry re-reads, and the PR reaches `gh pr merge` instead of being refused on a transient. (3 s retry wait ×1.)
  it('a transient UNKNOWN mergeability on the fresh pre-merge re-read is re-read and the PR still merges', () => {
    const { attempts, stderr } = runCli({ hookOn: true, ages: [[3001, 5]], env: { MQ_UNKNOWN_FIRST: '1', WE_DRAIN_UNKNOWN_MERGEABLE_RETRIES: '1' } });
    expect(attempts).toEqual([3001]);
    expect(stderr).not.toMatch(/mergeable=UNKNOWN/);
  }, 30000);

  it('control: with the retry off (0) the same UNKNOWN is refused — the test above does exercise the retry', () => {
    const { attempts, result } = runCli({ hookOn: true, ages: [[3001, 5]], env: { MQ_UNKNOWN_FIRST: '1', WE_DRAIN_UNKNOWN_MERGEABLE_RETRIES: '0' } });
    expect(attempts).toEqual([]);
    expect(JSON.stringify(result)).toMatch(/mergeable=UNKNOWN/);
  }, 30000);

  it('hook OFF (built-in default): both merge exactly as today, no freshness reads', () => {
    const { attempts, api } = runCli({ hookOn: false });
    expect(attempts.sort()).toEqual([3001, 3002]);
    expect(api.filter((p) => p.includes('check-runs?check_name=test&per_page=100'))).toEqual([]);
  }, 30000);
});

// ── Review of #4619 (correctness): the WE-carrier pre-check had no test. A couple = an impl half in a sibling repo
// plus its WE carrier; the carrier lands AFTER the impl half, so its merge-freshness is judged at the impl half's turn
// (a stale carrier holds the whole couple) and again at its own turn. Driven through the real CLI, two repos, hermetic
// shims — the same harness shape as above, with a repo-aware `gh`.
const LOCAL = 'web-everything/web-everything'; // the clone's own `origin`, so the drain treats it as the local repo
const FUI = 'frontier-ui/frontierui';
const PA = 'plateauapp/plateau-app';
const fakeGitCouple = fakeGit.replace('git@github.com:fixture/drain-mq.git', `git@github.com:${LOCAL}.git`);
const fakeGhCouple = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const F = process.env.MQ_FIXTURE;
const db = JSON.parse(fs.readFileSync(F, 'utf8'));
const ri = a.indexOf('--repo');
const slugOf = () => (ri >= 0 ? a[ri + 1] : db.local);
const prsOf = (slug) => db.repos[slug] || [];
const mark = (slug, n) => F + '.merged-' + slug.replace(/\\//g, '_') + '-' + n;
const out = x => { process.stdout.write(JSON.stringify(x)); process.exit(0); };
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('main'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') { const s = slugOf(); out(prsOf(s).filter(p => !fs.existsSync(mark(s, p.number)))); }
if (a[0] === 'pr' && a[1] === 'view') {
  const s = slugOf(); const p = prsOf(s).find(p => String(p.number) === a[2]);
  if (!p) process.exit(1);
  const landed = fs.existsSync(mark(s, p.number));
  // MQ_UNKNOWN_FIRST: the first fresh read (carries mergeStateStatus) of each PR answers UNKNOWN, as in the single-repo shim
  const fresh = (a[a.indexOf('--json') + 1] || '').includes('mergeStateStatus');
  const seen = F + '.fresh-reads-' + s.replace(/\\//g, '_') + '-' + p.number;
  const n = fs.existsSync(seen) ? Number(fs.readFileSync(seen, 'utf8')) : 0;
  if (fresh) fs.writeFileSync(seen, String(n + 1));
  const unknown = process.env.MQ_UNKNOWN_FIRST && fresh && n === 0;
  out({ ...p, ...(unknown ? { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' } : {}), state: landed ? 'MERGED' : 'OPEN', mergedAt: landed ? '2026-10-09T00:00:00Z' : null });
}
if (a[0] === 'pr' && a[1] === 'merge') { const s = slugOf(); fs.appendFileSync(F + '.attempts', s + '#' + a[2] + '\\n'); fs.writeFileSync(mark(s, a[2]), ''); process.exit(0); }
if (a[0] === 'run' && a[1] === 'rerun') { fs.appendFileSync(F + '.reruns', a[2] + '\\n'); process.exit(0); }
if (a[0] === 'api') {
  const path = a[1];
  fs.appendFileSync(F + '.api', path + '\\n');
  let m;
  if ((m = /repos\\/(.+?)\\/commits\\/([0-9a-f]+)\\/check-runs/.exec(path))) {
    const p = prsOf(m[1]).find(p => p.headRefOid === m[2]);
    // the Nth read of this head's pass sees the Nth age in passAtSeq (the last one repeats): a pass that ages out mid-pass
    const nf = F + '.reads-' + m[2]; const n = fs.existsSync(nf) ? Number(fs.readFileSync(nf, 'utf8')) : 0; fs.writeFileSync(nf, String(n + 1));
    const at = p.passAtSeq[Math.min(n, p.passAtSeq.length - 1)];
    out([{ check_runs: [{ id: 7, name: 'test', head_sha: m[2], status: 'completed', conclusion: 'success',
      started_at: at, completed_at: at, details_url: 'https://github.com/o/r/actions/runs/99' + p.number + '/job/1' }] }]);
  }
  // MQ_PA_MOVES: once the frontierui half has merged, plateau-app main moves (new tip, code changed) — a third-party merge mid-pass
  const moved = !!process.env.MQ_PA_MOVES && /plateauapp\\/plateau-app/.test(path) && fs.existsSync(F + '.attempts') && fs.readFileSync(F + '.attempts', 'utf8').includes('frontier-ui/frontierui#501');
  if (/\\/branches\\/main$/.test(path)) out({ sha: moved ? 'tip2' : 'tip' });
  if ((m = /compare\\/([0-9a-f]+)\\.\\.\\.(tip2?)$/.exec(path))) out({ base: 'base-' + m[1], ahead: 3, files: [m[2] === 'tip2' ? 'scripts/moved.mjs' : 'backlog/elsewhere.md'], n: 1 });
  if ((m = /pulls\\/(\\d+)\\/files/.exec(path))) out([[{ filename: 'backlog/leaf-' + m[1] + '.md' }]]);
}
process.exit(0);
`;

function runCouple({ implPassAges, carrierPassAges, secondImplPassAges = null, env: extraEnv = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'drain-mq-couple-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const [name, code] of [['gh', fakeGhCouple], ['git', fakeGitCouple]]) writeFileSync(join(bin, name), code, { mode: 0o755 });
    const manifest = { item: 'xcarr01', repos: [{ repo: 'we', ref: 'lane/xcarr01-we' }, { repo: 'fui', ref: 'lane/xcarr01-fui' },
      ...(secondImplPassAges ? [{ repo: 'plateau-app', ref: 'lane/xcarr01-pa' }] : [])], blockedBy: [], stackParents: [] };
    const body = `A real summary.\n\n<!-- lane-manifest:begin -->\n\`\`\`json\n${JSON.stringify(manifest)}\n\`\`\`\n<!-- lane-manifest:end -->\n`;
    const sha = (number) => String(number).padStart(12, 'a'); // a hex sha, so a reviewed-sha marker can name it
    // A cross-repo couple is always escalated for review; the carrier carries the human clearance for ITS head
    // (label + a trusted reviewed-sha marker), which is what the real drain requires before it will land it.
    const accepted = (number) => ({ labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }],
      comments: [{ body: `Reviewed.\n<!-- reviewed-sha: ${sha(number)} -->`, viewerDidAuthor: true, author: { login: 'web-everything' }, createdAt: iso(60) }] });
    const pr = (number, headRefName, ages, extra = {}) => ({
      number, title: `couple ${number}`, body: 'A real summary.', headRefName, baseRefName: 'main', headRefOid: sha(number),
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' }],
      labels: [{ name: 'ready-to-merge' }], comments: [], passAtSeq: ages.map(iso),
      commits: [{ oid: sha(number), authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }] }],
      files: [{ path: `backlog/leaf-${number}.md`, additions: 1, deletions: 0 }], ...extra,
    });
    const fixture = join(dir, 'prs.json');
    writeFileSync(fixture, JSON.stringify({ local: LOCAL, repos: {
      [LOCAL]: [pr(4001, 'lane/xcarr01-we', carrierPassAges, { body, ...accepted(4001) })],
      [FUI]: [pr(501, 'lane/xcarr01-fui', implPassAges)],
      ...(secondImplPassAges ? { [PA]: [pr(601, 'lane/xcarr01-pa', secondImplPassAges)] } : {}),
    } }));
    const settings = join(dir, 'merge-queue.json');
    writeFileSync(settings, JSON.stringify({ mergeQueue: { enabled: true, batchSize: 1 }, mergeFreshness: { enabled: true, maxAgeMinutes: 30, allowDisjointMainMoves: true } }));
    const coord = join(dir, 'coord');
    const preload = 'data:text/javascript,' + encodeURIComponent("import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.MQ_HOME; syncBuiltinESMExports();");
    const r = spawnSync(process.execPath, ['--import', preload, script, `--repos=${LOCAL},${FUI}${secondImplPassAges ? `,${PA}` : ''}`, '--label=ready-to-merge',
      '--no-drain-lease', '--no-red-main-freeze', '--json'], { // reconcile ON: a couple's gate needs the complete open-PR context
      cwd: dir, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MQ_FIXTURE: fixture, MQ_HOME: dir, WE_MERGE_QUEUE_SETTINGS_FILE: settings, WE_COORDINATION_ROOT: coord, ...extraEnv },
    });
    expect(r.error, r.stderr).toBeUndefined();
    const read = (s) => (existsSync(fixture + s) ? readFileSync(fixture + s, 'utf8').trim().split('\n').filter(Boolean) : []);
    return { stdout: r.stdout, stderr: r.stderr, attempts: read('.attempts'), api: read('.api') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('review of #4619 — the WE-carrier pre-check keeps a couple together', () => {
  it('a stale WE carrier holds the whole couple: the fresh impl half does not land alone, nothing reaches gh pr merge', () => {
    const { attempts, stderr } = runCouple({ implPassAges: [5], carrierPassAges: [120] });
    // (--json: the drain prints its skip reasons, not the per-line `⛓` notes)
    expect(stderr).toMatch(/"kind":"couple-held"[^\n]*its WE carrier is not merge-fresh \(merge-queue\)/);
    expect(stderr).toMatch(/"num":4001[^\n]*merge-queue: refresh \(pass-too-old\)/);
    expect(attempts).toEqual([]);
  }, 90000);

  it('both halves fresh: the impl half lands, then its carrier (control — the gate does not block a healthy couple)', () => {
    const { attempts, stderr } = runCouple({ implPassAges: [5], carrierPassAges: [5] });
    expect(attempts).toEqual([`${FUI}#501`, `${LOCAL}#4001`]);
  }, 90000);

  it('the carrier pass ages out between the pre-check and its own turn: the couple still lands together, never split', () => {
    // 25 min old when the pre-check reads it (fresh), 31 min old when the carrier is judged again after the impl merged.
    const { attempts, stderr } = runCouple({ implPassAges: [5], carrierPassAges: [25, 31] });
    expect(attempts).toEqual([`${FUI}#501`, `${LOCAL}#4001`]);
    expect(stderr).not.toMatch(/COUPLE SPLIT/);
  }, 90000);

  it('a carrier with TWO impl halves: the second half\'s pre-check honours the first one\'s clearance, so neither lands alone', () => {
    // Pre-check for the first half reads the carrier's pass at 25 min (fresh); by the second half's pre-check it is 31 min old.
    const { attempts, stderr } = runCouple({ implPassAges: [5], secondImplPassAges: [5], carrierPassAges: [25, 31] });
    expect(attempts).toEqual([`${FUI}#501`, `${PA}#601`, `${LOCAL}#4001`]);
    expect(stderr).not.toMatch(/COUPLE SPLIT/);
  }, 90000);

  // The carrier pre-check is the other `revalidateFresh` call site: a transient UNKNOWN on every fresh read in the couple
  // (impl half and carrier) is re-read, and the couple still lands together.
  it('a transient UNKNOWN on the couple\'s fresh reads (impl half and the carrier pre-check) is re-read and the couple lands', () => {
    const { attempts } = runCouple({ implPassAges: [5], carrierPassAges: [5], env: { MQ_UNKNOWN_FIRST: '1', WE_DRAIN_UNKNOWN_MERGEABLE_RETRIES: '1' } });
    expect(attempts).toEqual([`${FUI}#501`, `${LOCAL}#4001`]);
  }, 90000);

  // Residual (review of #4619): a third-party merge moves a sibling's repo between the preflight and its own turn, past the
  // pin. Two repos cannot merge atomically, so the split is REPORTED (JSON coupleSplit), never silent.
  it('a sibling impl half refused at its own turn after the first half landed is reported as a COUPLE SPLIT', () => {
    const { attempts, stdout } = runCouple({ implPassAges: [5], secondImplPassAges: [5], carrierPassAges: [5], env: { MQ_PA_MOVES: '1' } });
    expect(attempts).toEqual([`${FUI}#501`]);
    const split = JSON.parse(stdout.trim().split('\n').at(-1)).coupleSplit;
    expect(split).toHaveLength(1);
    expect(split[0].landedImpls).toEqual([{ num: 501, repo: FUI }]);
    expect(split[0].unlandedImpl).toEqual({ num: 601, repo: PA });
  }, 90000);

  // Review of #4619 (codex-correctness, CONFIRMED): the pre-check judged only the carrier, so with two impl halves the
  // first could merge and the second then be refreshed-and-skipped by its own gate, leaving the couple split. Every
  // member's freshness is now judged before ANY member merges — make each impl half stale in turn: zero merges.
  it.each([
    ['the second impl half (plateau-app)', { implPassAges: [5], secondImplPassAges: [120], carrierPassAges: [5] }],
    ['the first impl half (frontierui)', { implPassAges: [120], secondImplPassAges: [5], carrierPassAges: [5] }],
  ])('a stale %s holds every member before any merge', (_who, ages) => {
    const { attempts, stderr } = runCouple(ages);
    expect(attempts).toEqual([]);
    expect(stderr).toMatch(/merge-queue: refresh \(pass-too-old\)/);
    expect(stderr).not.toMatch(/COUPLE SPLIT/);
  }, 90000);
});
