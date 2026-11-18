/**
 * @file scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs
 * @description #4108 — a resident-daemon pass (RECONCILE on: `--label=ready-to-merge`) issued TWO sequential
 *   `gh pr list` round-trips per repo per pass: `collectContext()`'s label/only-blind open-PR context, then
 *   `listOne()`'s (now client-side, #no-label-search) label-filtered candidate listing — identical open-PR set,
 *   fetched twice. The fix widens the candidate listing's `--json` (`SWEEP_LIST_FIELDS`) and reuses its
 *   already-fetched rows to serve the context too, for every repo in the sweep's own `REPOS` set — ONE `gh pr
 *   list` per repo per pass instead of two.
 *
 *   Drives the REAL CLI entrypoint (`main` is imported in-process), with a
 *   fake `gh` function port that LOGS every `pr list` invocation's argv, following the `merge-ai-prs-gh-error-exit-
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
import { daemonAppEnv } from './fixtures/daemon-app-env.mjs';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { runInProcess, childProcessMock } from './fixtures/merge-ai-prs-cli-harness.mjs';
import { listingPorts, FAKE_GH } from './fixtures/merge-ai-prs-fake-ports.mjs';
vi.mock('node:child_process', async () => (await import('./fixtures/merge-ai-prs-cli-harness.mjs')).childProcessMock);
// Allow the CLI's label-lag repolls and fresh imports under Vitest's async test timer.
vi.setConfig({ testTimeout: 120_000 });
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { OPEN_PR_LIST_LIMIT } from '../lib/no-search-backed-pr-list.mjs';
import { collectOpenPrContext, buildLiveListingsByRepo } from '../merge-ai-prs.mjs';

// A `gh` stub: `repo view` → "main"; `pr view ... --json commits` → `{}` (no commits — the PR simply reads as
// not-AI-generated, irrelevant to what this file pins); `pr list` → the first `--limit N` fixture PRs (real gh
// caps its page the same way, so this keeps `listOne`'s own sized→escalate logic exercised faithfully), logging
// its own full argv (one JSON line) to `$GH_CALL_LOG` first, so the test can count + inspect the calls a real
// `gh pr list --limit N --json <fields>` would have made.

const openPr = (num, { labeled = false, baseRefName = 'main' } = {}) => ({
  number: num, title: `t${num}`, body: '', headRefName: `lane/${num}-x`, headRefOid: `sha${num}`,
  baseRefName, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, files: [],
  statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }],
  labels: labeled ? [{ name: 'ready-to-merge' }] : [],
});

describe('collectOpenPrContext — the truncation/degraded check lives in the CALLER, not in listOpenPrs (#4108, converge round 1 v3 security-lens risk)', async () => {
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

describe('buildLiveListingsByRepo — the reused map MUST carry `rows` (RAW), never `prs` (label/base-FILTERED) (#4108, converge round 2 red-team: 5/5 jurors — no prior test would have caught a `rows: prs` mutation)', async () => {
  it('a repo whose candidate set (`prs`) was narrowed by label/base still hands the context the FULL, unfiltered `rows`', async () => {
    const filteredOut = { number: 1, baseRefName: 'develop', labels: [] }; // excluded from `prs` by label AND base
    const candidate = { number: 2, baseRefName: 'main', labels: [{ name: 'ready-to-merge' }] };
    const listings = [{ repo: null, prs: [candidate], rows: [candidate, filteredOut] }];
    const map = buildLiveListingsByRepo(listings);
    expect(map.get(null)).toEqual([candidate, filteredOut]); // NOT [candidate] — that would be `prs`, the bug this pins
    expect(map.get(null)).not.toEqual([candidate]);
  });

  it('a repo with NO candidates at all (`prs: []`) still hands the context every open PR via `rows`', async () => {
    const open = { number: 3, baseRefName: 'main', labels: [] };
    const listings = [{ repo: 'web-everything/web-everything', prs: [], rows: [open] }];
    const map = buildLiveListingsByRepo(listings);
    expect(map.get('web-everything/web-everything')).toEqual([open]);
  });
});

describe('merge-ai-prs CLI — #4108 one `gh pr list` per repo per pass (RECONCILE on)', async () => {
  let shimDir;
  let repoDir;
  let callLog;

  beforeAll(() => {
    shimDir = mkdtempSync(join(tmpdir(), 'merge-ai-prs-dedupe-gh-shim-'));
    writeFileSync(join(shimDir, 'gh'), FAKE_GH);
    chmodSync(join(shimDir, 'gh'), 0o755);
    // The git port models an empty repository with no origin; no real git runs.
    repoDir = mkdtempSync(join(tmpdir(), 'merge-ai-prs-dedupe-repo-'));

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
  const runCli = (extraFlags = [], extraEnv = {}) => runInProcess([ '--this-repo', '--label=ready-to-merge', '--dry-run', '--no-drain-lease', '--no-red-main-freeze', '--json', ...extraFlags,
  ], {
    cwd: repoDir, ports: listingPorts,
    encoding: 'utf8',
    env: { ...process.env, ...daemonAppEnv(repoDir), PATH: `${shimDir}:${process.env.PATH}`, GH_CALL_LOG: callLog, ...extraEnv },
  });

  it('the harness rejects an unported subprocess even when the CLI catches its error, and restores ambient IO', async () => {
    const savedEnv = process.env, savedArgv = process.argv, savedCwd = process.cwd(), savedWrite = process.stderr.write;
    const gh = listingPorts.gh;
    const spy = vi.spyOn(listingPorts, 'gh').mockImplementation((args, env) => {
      try { childProcessMock.execFileSync('unported-fixture-command', []); } catch { /* emulate a best-effort caller */ }
      return gh(args, env);
    });
    try {
      await expect(runCli(['--repoll-delay=0'], { GH_FIXTURE_PRS: '[]' })).rejects.toThrow('Unported CLI subprocess');
      expect(process.env).toBe(savedEnv);
      expect(process.argv).toBe(savedArgv);
      expect(process.cwd()).toBe(savedCwd);
      expect(process.stderr.write).toBe(savedWrite);
    } finally { spy.mockRestore(); }
  });

  const ghPrListCalls = () => {
    let text = '';
    try { text = readFileSync(callLog, 'utf8'); } catch { return []; }
    return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };

  it('a RECONCILE-on pass (--label=ready-to-merge) issues exactly ONE `gh pr list` for the one swept repo', async () => {
    const r = await runCli([], { GH_FIXTURE_PRS: JSON.stringify([openPr(4501, { labeled: true })]) });
    expect(r.status).toBe(0);
    const calls = ghPrListCalls();
    expect(calls).toHaveLength(1); // was 2 before #4108 (collectContext's context call + listOne's candidate call)
  });

  it("that one call's --json widens to a field set covering BOTH the candidate AND the context listing's needs", async () => {
    await runCli([], { GH_FIXTURE_PRS: JSON.stringify([openPr(4502, { labeled: true })]) });
    const [call] = ghPrListCalls();
    const jsonIdx = call.argv.indexOf('--json');
    const fields = call.argv[jsonIdx + 1].split(',');
    // candidate-side certification fields (pre-existing)
    for (const f of ['mergeable', 'mergeStateStatus', 'labels', 'statusCheckRollup']) expect(fields).toContain(f);
    // context-only fields (#4308) — only reachable before #4108 via the SEPARATE context call this fix removes
    for (const f of ['isDraft', 'files']) expect(fields).toContain(f);
  });

  it('the client-side --label match still admits ONLY the labelled PR — an unlabelled sibling never enters `considered` (the critical correctness risk this fix must not regress)', async () => {
    const r = await runCli([], { GH_FIXTURE_PRS: JSON.stringify([openPr(4503, { labeled: true }), openPr(4504, { labeled: false })]) });
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.considered).toBe(1); // #4504 (unlabelled) is invisible to the candidate set, exactly like `gh pr list --label`
    // still exactly one `gh pr list` for the repo, even with 2 open PRs in it (unfiltered page, filtered client-side)
    expect(ghPrListCalls()).toHaveLength(1);
  });

  it('a repo with NO ready-to-merge PR at all: one `gh pr list` PER PASS, never two per pass — #2230\'s label-lag repoll (unrelated to #4108, found:0 always re-polls once) doubles the PASS count, not the per-pass call count', async () => {
    // `--repoll-delay=0` keeps the (pre-existing, #2230) confirm-repoll instant — this scenario's `considered:0`
    // always triggers exactly one repoll, so TWO `sweepOnce()` passes run; the invariant this pins is ONE `gh pr
    // list` per PASS (was two per pass, pre-#4108 — i.e. 4 total here, not 2).
    const r = await runCli(['--repoll-delay=0'], { GH_FIXTURE_PRS: JSON.stringify([openPr(4505, { labeled: false })]) });
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.considered).toBe(0);
    expect(ghPrListCalls()).toHaveLength(2); // 2 passes × 1 call/pass (was 2 passes × 2 calls/pass = 4, pre-#4108)
  });

  it('--base is matched CLIENT-SIDE, never passed to `gh` server-side — the raw fetch stays base-UNFILTERED so it stays safe to reuse for the base-blind context', async () => {
    const r = await runCli(['--base=main'], { GH_FIXTURE_PRS: JSON.stringify([
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

  it('the reused-listing fixture (500+ open PRs) still reaches the escalated OPEN_PR_LIST_LIMIT page and trips the candidate-side DEGRADED warning — sizing/escalation is unaffected by reuse', async () => {
    const all = Array.from({ length: OPEN_PR_LIST_LIMIT + 1 }, (_, i) => openPr(10000 + i, { labeled: i === 0 }));
    // Handed over as a FILE, never the GH_FIXTURE_PRS env var: 501 PRs serialize to ~135 KB, past Linux's
    // 128 KB per-string MAX_ARG_STRLEN, so on the (Linux) CI runner the spawn itself failed E2BIG (status null)
    // while passing on macOS, which has no per-string cap.
    const fixtureFile = join(dirname(callLog), 'fixture-prs.json');
    writeFileSync(fixtureFile, JSON.stringify(all));
    const r = await runCli([], { GH_FIXTURE_PRS_FILE: fixtureFile });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/DEGRADED drain listing/);
    // the sized-then-escalate retry is the SAME single logical listing (not two independent gh pr list
    // "calls" in the #4108 dedupe sense) — 2 `gh` invocations: the initial sized page, then the escalated
    // OPEN_PR_LIST_LIMIT page once it came back full. Never a THIRD invocation for the context.
    expect(ghPrListCalls()).toHaveLength(2);
  });

  const bareSweepListsOncePerRepo = async ({ workflowEditHuman, extraFields }) => {
    const candidateOnlyFields = 'number,title,body,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,labels'.split(',');
    const r = await runInProcess([ '--this-repo', '--dry-run', '--no-drain-lease', '--no-red-main-freeze', '--json'], {
      cwd: repoDir, ports: listingPorts,
      encoding: 'utf8',
      env: { ...process.env, ...daemonAppEnv(repoDir), PATH: `${shimDir}:${process.env.PATH}`, GH_CALL_LOG: callLog, GH_FIXTURE_PRS: JSON.stringify([]), WE_DRAIN_WORKFLOW_EDIT_HUMAN: workflowEditHuman },
    });
    expect(r.status).toBe(0);
    const calls = ghPrListCalls();
    expect(calls).toHaveLength(1);
    const jsonIdx = calls[0].argv.indexOf('--json');
    const fields = calls[0].argv[jsonIdx + 1].split(',');
    // The default workflow-edit gate needs files; disabling it restores the old candidate-only list.
    // Exact equality also rejects unrelated context widening such as isDraft.
    expect(fields).toEqual([...candidateOnlyFields, ...extraFields]);
  };

  it('a bare sweep with NO --label (RECONCILE off), default workflow-edit gate: exactly ONE `gh pr list` per repo per pass, with the candidate fields plus the `files` the gate needs', async () => {
    await bareSweepListsOncePerRepo({ workflowEditHuman: undefined, extraFields: ['files'] });
  });

  it('a bare sweep with NO --label (RECONCILE off), workflow-edit gate off: exactly ONE `gh pr list` per repo per pass, with only the required candidate fields', async () => {
    await bareSweepListsOncePerRepo({ workflowEditHuman: 'off', extraFields: [] });
  });
});
