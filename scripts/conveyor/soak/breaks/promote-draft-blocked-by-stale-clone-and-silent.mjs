/**
 * @file breaks/promote-draft-blocked-by-stale-clone-and-silent.mjs — live incident 2026-10-03 (~17:55Z): PR #3806,
 * the fix for main's red CI, sat green-but-draft for 15+ minutes and was never promoted, so it was never reviewed.
 *
 * ROOT CAUSE (two defects, both reproduced here):
 *  1. The fix-dispatch daemon's promote half (`promote-draft-pr-dispatch.mjs`) called `assertMainNotStale` with no
 *     dispatch path, so a MANAGED daemon clone that was merely 2 commits behind `origin/main` made the guard
 *     throw for the WHOLE pass, every tick. The clone was held behind by a slow rebuild smoke and its tree was
 *     dirty, so the last-good fallback did not apply either. Neither commit touched any file the promote pass
 *     imports (only `scripts/operations/cli-adapter.mjs`), and the pass's only write is `gh pr ready` after a
 *     fresh per-sha re-check. A green draft stayed draft; since main was red, nothing could land to unblock it.
 *  2. The failure was invisible. `onTick` skipped every `tick-failed` refusal as "already printed by the per-repo
 *     loop", but that loop reads only the FIX half's repo errors. Promote outcomes had no log line at all.
 *
 * FIX: `isPromoteCodePath` (the pass's own import closure) is passed as `dispatchPath`, so lag outside it is
 * tolerated; the promote half's tick failure is named and printed; promoted drafts are logged.
 *
 * SCENARIO (no simulator; real git, real modules from `sourceRoot`):
 *   A. a managed clone (WE_DAEMON_MANAGED_CLONE=1) is 1 commit behind its origin, the commit touching only
 *      `scripts/operations/cli-adapter.mjs`; the promote pass runs from it with a planned green draft and a fake
 *      `gh pr ready` — the draft must be promoted when a complete fixture graph proves the file unrelated.
 *      The default graph's unwalked CommonJS dependencies must refuse before any ready call;
 *   B. a daemon tick whose promote half throws must produce a log line naming the promote half and its reason.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const PR = 3806;

const CHILD = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const src = process.env.SOAK_SOURCE_ROOT;
const promote = await import(pathToFileURL(join(src, 'scripts/operations/promote-draft-pr-dispatch.mjs')).href);
const { collectImportClosure } = await import(pathToFileURL(join(src, 'scripts/lib/import-closure.mjs')).href);
const daemon = await import(pathToFileURL(join(src, 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs')).href);
const out = { ready: [], threw: null, lines: [], defaultReady: [], defaultRefusal: null };
const options = {
  root: process.env.SOAK_CLONE, repo: null,
  reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: ${PR}, headRefOid: 'a'.repeat(40) }], refusals: [] }),
  readHeadCheckState: () => ({ state: 'green', why: 'all required checks succeeded', counts: {} }),
  readPrLabels: () => [], clearAwaitingCi: () => {},
};
out.defaultComplete = promote.promoteCodeClosure()?.complete;
try {
  promote.runReconcilePromoteDraftDispatch({ ...options, provider: { ready: n => out.defaultReady.push(n) } });
} catch (e) { out.defaultRefusal = String(e.message).split('\\n')[0]; }
const closure = collectImportClosure({ root: process.env.SOAK_CLONE, entries: ['scripts/operations/promote-draft-pr-dispatch.mjs'] });
out.fixtureComplete = closure?.complete;
out.fixtureFiles = [...(closure?.files ?? [])].sort();
try {
  promote.runReconcilePromoteDraftDispatch({
    ...options,
    promoteCodePath: path => promote.isPromoteCodePath(path, { closure }),
    provider: { ready: (n) => out.ready.push(n) },
  });
} catch (e) { out.threw = String(e.message).split('\\n')[0]; }
const empty = () => ({ dispatched: [], refusals: [] });
const tick = await daemon.runTickAllRepos({
  repos: ['soak-owner/soak-repo'], fixTick: empty, ciHealTick: empty,
  hungCiTick: () => ({ dispatch: [], refusals: [], applied: [] }),
  mainRedRebaseTick: () => ({ dispatch: [], refusals: [], applied: [] }),
  missingRunTick: () => ({ dispatch: [], refusals: [], applied: [] }),
  notesTick: () => ({ notes: [], prsByNumber: new Map() }),
  promoteDraftTick: () => { throw new Error('the dispatching checkout is 2 commit(s) behind origin/main'); },
});
daemon.buildCliDaemonEffects({ owner: 'soak', log: { error: (l) => out.lines.push(String(l)) } }).onTick(tick);
process.stdout.write(JSON.stringify(out));
`;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export default {
  id: 'promote-draft-blocked-by-stale-clone-and-silent',
  title: 'a green draft is never promoted when the daemon clone lags main in files the promote pass never imports, and the failure logs nothing (live: PR #3806)',
  card: 'live incident 2026-10-03: PR #3806 (main-red fix) green but draft for 15+ min; conveyor fix-promote-draft',
  fixedBy: {
    sha: '0c03ce904',
    where: 'lane/fix-promote-draft-stale-clone',
    paths: ['scripts/operations/promote-draft-pr-dispatch.mjs', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'],
  },
  fixPresent(root) {
    const p = join(root, 'scripts/operations/promote-draft-pr-dispatch.mjs');
    return existsSync(p) && /export function isPromoteCodePath/.test(readFileSync(p, 'utf8'));
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-promote-stale-'));
    const violations = [];
    try {
      const origin = join(dir, 'origin.git');
      const seed = join(dir, 'seed');
      const clone = join(dir, 'clone');
      mkdirSync(origin);
      git(origin, 'init', '--bare', '-q', '-b', 'main');
      git(dir, 'clone', '-q', origin, seed);
      git(seed, 'config', 'user.email', 'soak@example.invalid');
      git(seed, 'config', 'user.name', 'soak');
      mkdirSync(join(seed, 'scripts/operations'), { recursive: true });
      mkdirSync(join(seed, 'scripts/lib'), { recursive: true });
      writeFileSync(join(seed, 'scripts/operations/promote-draft-pr-dispatch.mjs'), "import '../lib/fixture-sandbox.mjs';\n");
      writeFileSync(join(seed, 'scripts/lib/fixture-sandbox.mjs'), 'export {};\n');
      writeFileSync(join(seed, 'scripts/operations/cli-adapter.mjs'), '// v1\n');
      git(seed, 'add', 'scripts/operations/cli-adapter.mjs', 'scripts/operations/promote-draft-pr-dispatch.mjs', 'scripts/lib/fixture-sandbox.mjs');
      git(seed, 'commit', '-q', '-m', 'seed');
      git(seed, 'push', '-q', 'origin', 'HEAD:main');
      git(dir, 'clone', '-q', origin, clone); // the daemon's managed clone, at the seed commit
      writeFileSync(join(seed, 'scripts/operations/cli-adapter.mjs'), '// v2 — landed on main after the clone was built\n');
      git(seed, 'commit', '-q', '-am', 'main moves a file the promote pass never imports');
      git(seed, 'push', '-q', 'origin', 'HEAD:main');
      log?.('managed clone is 1 commit behind origin/main, behind only in scripts/operations/cli-adapter.mjs');

      const childFile = join(dir, 'child.mjs');
      writeFileSync(childFile, CHILD);
      let out;
      try {
        out = JSON.parse(execFileSync('node', [childFile], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, SOAK_SOURCE_ROOT: sourceRoot, SOAK_CLONE: clone, WE_DAEMON_MANAGED_CLONE: '1', WE_DAEMON_STATE_DIR: join(dir, 'state') },
        }));
      } catch (e) {
        violations.push({ invariant: 'scenario-runs', detail: `the scenario child crashed: ${String(e?.stderr || e?.message || e).split('\n').slice(0, 3).join(' | ')}` });
        return { violations };
      }
      log?.(`promoted: ${JSON.stringify(out.ready)}; threw: ${out.threw}`);
      if (out.fixtureComplete !== true || JSON.stringify(out.fixtureFiles) !== JSON.stringify([
        'scripts/lib/fixture-sandbox.mjs', 'scripts/operations/promote-draft-pr-dispatch.mjs',
      ])) {
        violations.push({ invariant: 'fixture-closure-proven', detail: `expected the complete two-module fixture graph: ${JSON.stringify(out)}` });
      }
      if (out.defaultComplete !== false || out.defaultReady.length !== 0 || !/STALE code/.test(out.defaultRefusal ?? '')) {
        violations.push({ invariant: 'unknown-commonjs-closure-refuses', detail: `unwalked default dependencies must refuse before promotion: ${JSON.stringify(out)}` });
      }
      if (!out.ready.includes(PR)) {
        violations.push({
          invariant: 'green-draft-promoted-despite-off-path-lag',
          detail: `PR #${PR} (planned promote-draft, checks green) was NOT promoted; the pass ${out.threw ? `threw: ${out.threw}` : 'did nothing'}`,
        });
      }
      const logged = out.lines.some((l) => /promote-draft/.test(l) && /2 commit\(s\) behind/.test(l));
      log?.(`tick log mentions the promote failure: ${logged}`);
      if (!logged) {
        violations.push({
          invariant: 'promote-half-failure-is-logged',
          detail: `a tick whose promote half threw printed no line naming the promote half and its reason; lines: ${JSON.stringify(out.lines)}`,
        });
      }
      return { violations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
