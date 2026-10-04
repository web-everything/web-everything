/**
 * @file scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs
 * @description #4108 — a resident-daemon pass (RECONCILE on: `--label=ready-to-merge`) issued TWO sequential
 *   `gh pr list` round-trips per repo per pass: `collectContext()`'s label/only-blind open-PR context, then
 *   `listOne()`'s (now client-side, #no-label-search) label-filtered candidate listing — identical open-PR set,
 *   fetched twice. The fix widens the candidate listing's `--json` (`SWEEP_LIST_FIELDS`) and reuses its
 *   already-fetched rows to serve the context too, for every repo in the sweep's own `REPOS` set — ONE `gh pr
 *   list` per repo per pass instead of two.
 *
 *   Drives the REAL CLI entrypoint (`runCli` is not exported — it only runs under the `IS_CLI` guard), with a
 *   fake `gh` on PATH that LOGS every `pr list` invocation's argv, following the `merge-ai-prs-gh-error-exit-
 *   code.test.mjs` shim pattern. No network/real `gh` is touched.
 *
 *   Also pins the CRITICAL correctness risks this fix could regress:
 *   - the client-side `--label` match (identical semantics to gh's own server-side `--label`) must still admit
 *     ONLY the labelled PR to the candidate set — widening the listing's fields or reusing its rows for the
 *     context must not leak an unlabelled PR into `considered`/`toMerge`.
 *   - `--base` (converge round 1, 4/5 jurors caught this in review before it shipped): `listOne` used to pass
 *     `--base <branch>` to `gh` SERVER-SIDE, which would have silently narrowed the reused rows to one base
 *     branch — breaking the RECONCILE context's documented base-BLIND, constellation-wide carrier visibility
 *     (a cross-base carrier PR would read as absent, which the couple gate treats as landed). `--base` is now
 *     matched CLIENT-SIDE (`filterOpenPrsByBase`), exactly like `--label`, so the raw fetch stays base-
 *     unfiltered and safe to reuse.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPEN_PR_LIST_LIMIT } from '../lib/no-search-backed-pr-list.mjs';
import { collectOpenPrContext, buildLiveListingsByRepo } from '../merge-ai-prs.mjs';

// A `gh` stub: `repo view` → "main"; `pr view ... --json commits` → `{}` (no commits — the PR simply reads as
// not-AI-generated, irrelevant to what this file pins); `pr list` → the first `--limit N` fixture PRs (real gh
// caps its page the same way, so this keeps `listOne`'s own sized→escalate logic exercised faithfully), logging
// its own full argv (one JSON line) to `$GH_CALL_LOG` first, so the test can count + inspect the calls a real
// `gh pr list --limit N --json <fields>` would have made.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
function log(entry) { if (process.env.GH_CALL_LOG) fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(entry) + '\\n'); }
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('main'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') {
  log({ argv: a });
  const all = JSON.parse(process.env.GH_FIXTURE_PRS_FILE ? fs.readFileSync(process.env.GH_FIXTURE_PRS_FILE, 'utf8') : (process.env.GH_FIXTURE_PRS || '[]'));
  const limitIdx = a.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(a[limitIdx + 1]) : all.length;
  // fs.writeSync (never process.stdout.write + process.exit) — a large payload's async pipe write can be
  // truncated by an immediate process.exit() (a real Node footgun, caught live authoring this fixture: a
  // 501-PR fixture came back "Unterminated string in JSON" at exactly one pipe-buffer's worth of bytes).
  fs.writeSync(1, JSON.stringify(all.slice(0, limit)));
  process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'view') { process.stdout.write('{}'); process.exit(0); }
process.stdout.write('[]');
process.exit(0);
`;

const openPr = (num, { labeled = false, baseRefName = 'main' } = {}) => ({
  number: num, title: `t${num}`, body: '', headRefName: `lane/${num}-x`, headRefOid: `sha${num}`,
  baseRefName, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, files: [],
  statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }],
  labels: labeled ? [{ name: 'ready-to-merge' }] : [],
});

describe('collectOpenPrContext — the truncation/degraded check lives in the CALLER, not in listOpenPrs (#4108, converge round 1 v3 security-lens risk)', () => {
  // The #4108 fix's `listOpenPrs` early-returns pre-fetched rows for a repo already listed live this pass
  // (`liveByRepo.has(repo)`), instead of making its own `gh pr list` call. A round-1 security-lens finding
  // (diff-only, no tools) worried that early return "bypasses" the `--limit OPEN_PR_LIST_LIMIT`
  // truncation/degraded check that feeds `contextComplete:false` (the couple gate's fail-closed signal). It
  // does not: `isDegradedOpenPrListing` is evaluated by `collectOpenPrContext` on WHATEVER `listOpenPrs`
  // returns — it was never inside `listOpenPrs` to begin with, on EITHER branch. This proves it directly,
  // stubbing `listOpenPrs` to return already-fetched rows exactly the way the `#4108` early return does.
  it('a `listOpenPrs` that returns ALREADY-FETCHED rows (no gh call) still trips truncated/contextComplete:false at the cap, identically to a fresh call', async () => {
    const rows = Array.from({ length: OPEN_PR_LIST_LIMIT }, (_, i) => ({ number: i, headRefName: `lane/${i}-x` }));
    let truncatedCall = null;
    const ctx = await collectOpenPrContext({
      contextRepos: [null],
      listOpenPrs: async () => rows, // exactly what the #4108 early return does: hand back pre-fetched rows, no gh call
      fetchReads: async () => new Map(),
      onListingTruncated: (repo, n) => { truncatedCall = { repo, n }; },
    });
    expect(ctx.truncated).toBe(true);
    expect(ctx.contextComplete).toBe(false);
    expect(truncatedCall).toEqual({ repo: null, n: OPEN_PR_LIST_LIMIT });
  });

  it('a fixture safely UNDER the cap is NOT flagged — the check is a real threshold, not a blanket false-positive', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ number: i, headRefName: `lane/${i}-x` }));
    let truncatedCall = null;
    const ctx = await collectOpenPrContext({
      contextRepos: [null],
      listOpenPrs: async () => rows,
      fetchReads: async () => new Map(),
      onListingTruncated: (repo, n) => { truncatedCall = { repo, n }; },
    });
    expect(ctx.truncated).toBe(false);
    expect(ctx.contextComplete).toBe(true);
    expect(truncatedCall).toBe(null);
  });
});

describe('buildLiveListingsByRepo — the reused map MUST carry `rows` (RAW), never `prs` (label/base-FILTERED) (#4108, converge round 2 red-team: 5/5 jurors — no prior test would have caught a `rows: prs` mutation)', () => {
  it('a repo whose candidate set (`prs`) was narrowed by label/base still hands the context the FULL, unfiltered `rows`', () => {
    const filteredOut = { number: 1, baseRefName: 'develop', labels: [] }; // excluded from `prs` by label AND base
    const candidate = { number: 2, baseRefName: 'main', labels: [{ name: 'ready-to-merge' }] };
    const listings = [{ repo: null, prs: [candidate], rows: [candidate, filteredOut] }];
    const map = buildLiveListingsByRepo(listings);
    expect(map.get(null)).toEqual([candidate, filteredOut]); // NOT [candidate] — that would be `prs`, the bug this pins
    expect(map.get(null)).not.toEqual([candidate]);
  });

  it('a repo with NO candidates at all (`prs: []`) still hands the context every open PR via `rows`', () => {
    const open = { number: 3, baseRefName: 'main', labels: [] };
    const listings = [{ repo: 'web-everything/web-everything', prs: [], rows: [open] }];
    const map = buildLiveListingsByRepo(listings);
    expect(map.get('web-everything/web-everything')).toEqual([open]);
  });
});

describe('merge-ai-prs CLI — #4108 one `gh pr list` per repo per pass (RECONCILE on)', () => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs');
  let shimDir;
  let repoDir;
  let callLog;

  beforeAll(() => {
    shimDir = mkdtempSync(join(tmpdir(), 'merge-ai-prs-dedupe-gh-shim-'));
    writeFileSync(join(shimDir, 'gh'), FAKE_GH);
    chmodSync(join(shimDir, 'gh'), 0o755);
    // A throwaway git repo (no real remote reached — localRepoSlug() fails soft to null on a bad/absent
    // origin) so the CLI's own `git remote get-url origin` probe never touches the real webeverything checkout.
    repoDir = mkdtempSync(join(tmpdir(), 'merge-ai-prs-dedupe-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    mkdirSync(join(repoDir, 'backlog'), { recursive: true });
  });
  afterAll(() => {
    try { rmSync(shimDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  beforeEach(() => {
    callLog = join(mkdtempSync(join(tmpdir(), 'merge-ai-prs-dedupe-log-')), 'gh-calls.jsonl');
  });

  // `--this-repo` keeps the sweep to the one (fake) cwd repo — one repo, so exactly one `gh pr list` call is
  // the fixed point this pins (a multi-repo sweep would pin N, one per repo — same invariant). `--dry-run`
  // skips every mutation (merge/label-write) so the fake `gh` needs no write-side support. `--no-drain-lease`
  // + `--no-red-main-freeze` bypass the two unrelated gates that would otherwise touch this machine's real
  // `~/.claude/drain-locks` state ahead of the listing code under test.
  const runCli = (extraFlags = [], extraEnv = {}) => spawnSync('node', [
    script, '--this-repo', '--label=ready-to-merge', '--dry-run', '--no-drain-lease', '--no-red-main-freeze', '--json', ...extraFlags,
  ], {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, GH_CALL_LOG: callLog, ...extraEnv },
  });

  const ghPrListCalls = () => {
    let text = '';
    try { text = readFileSync(callLog, 'utf8'); } catch { return []; }
    return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };

  it('a RECONCILE-on pass (--label=ready-to-merge) issues exactly ONE `gh pr list` for the one swept repo', () => {
    const r = runCli([], { GH_FIXTURE_PRS: JSON.stringify([openPr(4501, { labeled: true })]) });
    expect(r.status).toBe(0);
    const calls = ghPrListCalls();
    expect(calls).toHaveLength(1); // was 2 before #4108 (collectContext's context call + listOne's candidate call)
  });

  it("that one call's --json widens to a field set covering BOTH the candidate AND the context listing's needs", () => {
    runCli([], { GH_FIXTURE_PRS: JSON.stringify([openPr(4502, { labeled: true })]) });
    const [call] = ghPrListCalls();
    const jsonIdx = call.argv.indexOf('--json');
    const fields = call.argv[jsonIdx + 1].split(',');
    // candidate-side certification fields (pre-existing)
    for (const f of ['mergeable', 'mergeStateStatus', 'labels', 'statusCheckRollup']) expect(fields).toContain(f);
    // context-only fields (#4308) — only reachable before #4108 via the SEPARATE context call this fix removes
    for (const f of ['isDraft', 'files']) expect(fields).toContain(f);
  });

  it('the client-side --label match still admits ONLY the labelled PR — an unlabelled sibling never enters `considered` (the critical correctness risk this fix must not regress)', () => {
    const r = runCli([], { GH_FIXTURE_PRS: JSON.stringify([openPr(4503, { labeled: true }), openPr(4504, { labeled: false })]) });
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.considered).toBe(1); // #4504 (unlabelled) is invisible to the candidate set, exactly like `gh pr list --label`
    // still exactly one `gh pr list` for the repo, even with 2 open PRs in it (unfiltered page, filtered client-side)
    expect(ghPrListCalls()).toHaveLength(1);
  });

  it('a repo with NO ready-to-merge PR at all: one `gh pr list` PER PASS, never two per pass — #2230\'s label-lag repoll (unrelated to #4108, found:0 always re-polls once) doubles the PASS count, not the per-pass call count', () => {
    // `--repoll-delay=0` keeps the (pre-existing, #2230) confirm-repoll instant — this scenario's `considered:0`
    // always triggers exactly one repoll, so TWO `sweepOnce()` passes run; the invariant this pins is ONE `gh pr
    // list` per PASS (was two per pass, pre-#4108 — i.e. 4 total here, not 2).
    const r = runCli(['--repoll-delay=0'], { GH_FIXTURE_PRS: JSON.stringify([openPr(4505, { labeled: false })]) });
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.considered).toBe(0);
    expect(ghPrListCalls()).toHaveLength(2); // 2 passes × 1 call/pass (was 2 passes × 2 calls/pass = 4, pre-#4108)
  });

  it('--base is matched CLIENT-SIDE, never passed to `gh` server-side — the raw fetch stays base-UNFILTERED so it stays safe to reuse for the base-blind context', () => {
    const r = runCli(['--base=main'], { GH_FIXTURE_PRS: JSON.stringify([
      openPr(4506, { labeled: true, baseRefName: 'main' }),
      openPr(4507, { labeled: true, baseRefName: 'develop' }),
    ]) });
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.considered).toBe(1); // #4507 (base=develop) is excluded from the candidate set, exactly like `gh pr list --base main`
    const [call] = ghPrListCalls();
    expect(call.argv).not.toContain('--base'); // #4108 regression: this used to be passed server-side, narrowing the reused rows
    expect(ghPrListCalls()).toHaveLength(1);
  });

  it('the reused-listing fixture (500+ open PRs) still reaches the escalated OPEN_PR_LIST_LIMIT page and trips the candidate-side DEGRADED warning — sizing/escalation is unaffected by reuse', () => {
    const all = Array.from({ length: OPEN_PR_LIST_LIMIT + 1 }, (_, i) => openPr(10000 + i, { labeled: i === 0 }));
    // Handed over as a FILE, never the GH_FIXTURE_PRS env var: 501 PRs serialize to ~135 KB, past Linux's
    // 128 KB per-string MAX_ARG_STRLEN, so on the (Linux) CI runner the spawn itself failed E2BIG (status null)
    // while passing on macOS, which has no per-string cap.
    const fixtureFile = join(dirname(callLog), 'fixture-prs.json');
    writeFileSync(fixtureFile, JSON.stringify(all));
    const r = runCli([], { GH_FIXTURE_PRS_FILE: fixtureFile });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/DEGRADED drain listing/);
    // the sized-then-escalate retry is the SAME single logical listing (not two independent gh pr list
    // "calls" in the #4108 dedupe sense) — 2 `gh` invocations: the initial sized page, then the escalated
    // OPEN_PR_LIST_LIMIT page once it came back full. Never a THIRD invocation for the context.
    expect(ghPrListCalls()).toHaveLength(2);
  });

  it('a bare sweep with NO --label (RECONCILE off) is UNCHANGED — still exactly one `gh pr list` (never doubled by this fix), and its --json stays the UNWIDENED candidate-only field list (converge round 2: nothing reuses this call when RECONCILE is off, so it must not pay the extra context fields)', () => {
    const r = spawnSync('node', [script, '--this-repo', '--dry-run', '--no-drain-lease', '--no-red-main-freeze', '--json'], {
      cwd: repoDir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, GH_CALL_LOG: callLog, GH_FIXTURE_PRS: JSON.stringify([]) },
    });
    expect(r.status).toBe(0);
    const calls = ghPrListCalls();
    expect(calls).toHaveLength(1);
    const jsonIdx = calls[0].argv.indexOf('--json');
    const fields = calls[0].argv[jsonIdx + 1].split(',');
    for (const f of ['isDraft', 'files']) expect(fields).not.toContain(f); // context-only fields — never paid for on a call nothing reuses
  });
});
