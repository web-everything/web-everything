import { isTerminalStatus } from '../lib/backlog-status.cjs';
/**
 * @file scripts/operations/resolve-io.mjs
 * @description THE IO SHELL of the `resolve` declaration (#xrrpfo7) — the reader its `read` step is injected
 *   with, and the sink its `write` effect is applied through.
 *
 * SAME SPLIT AS `./claim-io.mjs`, deliberately: `./resolve.mjs` is the WHAT and this is the only place it
 * touches the world, which is what lets every refusal in the declaration be tested with no filesystem and no
 * git.
 *
 * IT REUSES, IT DOES NOT RESTATE. `resolveBacklogFile`/`idFromName`/`readField` come from the same modules
 * `claim-io.mjs` uses; the write goes through the extracted guarded writer
 * (`we:scripts/backlog/guarded-write.mjs#writeBacklogMd`) and never a bare `writeFileSync`, because that
 * writer owns the lane-not-primary refusal and the #883 locus scan at write time. A second writer here would
 * be a second answer to "may this file be written", which is the failure #2644 names.
 *
 * THE SCOPE READ IS THE EXPENSIVE ONE, and it is deliberately shaped to report THREE states rather than two.
 * `reconcileScope` can only run when the item declares a `scope:`; a pre-#2613 legacy item declares none, and
 * the CLI prints a note and passes. So this reader returns `scopeDeclared` SEPARATELY from `offending`:
 * `{scopeDeclared: false}` means the check could not run, `{scopeDeclared: true, offending: []}` means it ran
 * and found nothing. `planResolve` keeps them apart for the same reason `verify` keeps `unrun` out of `pass`.
 *
 * IMPURE by construction: `fs`, `git`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';

import { readField } from '../backlog/frontmatter.mjs';
// #2803 — the REAL reconciliation, wired by default. See `createResolveReader`'s note: defaulting these to
// `null` shipped a guard that never ran.
import { reconcileScope } from '../readiness/scope-reconcile.mjs';
import { parseObservedFiles } from '../readiness/scope-lease-collect.mjs';
import { repoKeyFromSlug } from '../readiness/lane-manifest.mjs';
import { ROUTE_ENTRIES } from '../lib/route-import-graph.mjs';
import { writeBacklogMd } from '../backlog/guarded-write.mjs';
// #2747 — the shared wall-clock helper, NOT a hand-rolled UTC ISO day-slice. The hand-rolled form stamps the
// runtime's UTC day, which runs a day ahead of a UTC-behind operator all evening. `check:standards` scans for
// it and caught this exact file on its first cut. `claim-io.mjs` imports the same helper for the same reason.
// (The scanner matches the pattern in comments too, so this note describes it rather than quoting it.)
import { localToday } from '../lib/local-date.mjs';
import { RESOLVE_EFFECT } from './resolve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Resolved by SCRIPT LOCATION, never cwd — same reason `run-store.mjs` does it. */
export const REPO_ROOT = resolvePath(HERE, '..', '..');

const backlogDir = (root) => join(root, 'backlog');

/**
 * The item's `scope:` as a PARSED STRING ARRAY — what `reconcileScope` actually takes.
 *
 * `reconcileScope`'s own signature is `@param {string[]} a.declared`, and `we:scripts/backlog.mjs`'s
 * `readScopeList` feeds it a gray-matter-parsed array. Passing `readField`'s raw frontmatter STRING instead
 * made `normScope` treat every declared scope as EMPTY, so the #2803 guard flagged every touched presentation
 * file as drift even when the item's scope covered it perfectly (PR #1510 correctness juror, round 2).
 *
 * That is the second bug in this one guard: round 1 was "it never runs", and the fix for it produced "it runs
 * on the wrong shape". Both had the same root — the reader was reasoning about the reconciliation's contract
 * instead of reading it.
 *
 * Returns `null` (not `[]`) when there is no usable list, so the caller can tell "no scope declared" from
 * "declared an empty one".
 */
export function readScopeList(content) {
  try {
    const scope = createRequire(import.meta.url)('gray-matter')(content)?.data?.scope;
    return Array.isArray(scope) ? scope.filter((x) => typeof x === 'string' && x.trim()) : null;
  } catch { return null; }
}
const idFromName = (file) => file.replace(/\.md$/, '').split('-')[0];

/**
 * Find the one backlog file a ref names. Refuses AMBIGUITY rather than picking the first match — two files
 * for one id means the caller's ref does not identify an item, and resolving the wrong card is worse than
 * refusing.
 */
export function resolveBacklogFile(ref, root, listFiles) {
  const raw = String(ref ?? '').replace(/^#/, '').trim();
  if (!raw) return null;
  const padded = /^\d+$/.test(raw) ? raw.padStart(3, '0') : raw;
  const files = listFiles(backlogDir(root)).filter((f) => f.endsWith('.md'));
  const matches = files.filter((f) => idFromName(f) === padded || f.replace(/\.md$/, '') === padded);
  if (matches.length !== 1) return null;
  return matches[0];
}

/**
 * The observed touch-set for #2803, replaying `we:scripts/backlog.mjs`'s `observedFilesForResolve`.
 *
 * The slug normalization is load-bearing and is NOT incidental: `repoKeyFromSlug` takes an `owner/name` slug,
 * not a remote URL — it splits on `/` and never strips `.git`, so a raw `git@github.com:owner/name.git` keys
 * as `name.git`, NOTHING matches a `we:`-qualified declared entry, and the guard is silently inert. That is
 * the same silent-inertness this file was just caught shipping one level up, so it is replayed exactly.
 */
export function observedFilesForResolve({ root, exec }) {
  const git = (args) => exec('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const url = String(git(['remote', 'get-url', 'origin'])).trim();
  const slug = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? url;
  const repoKey = repoKeyFromSlug(slug);
  if (!repoKey) throw new Error(`origin remote "${url}" yields no repo key`);
  const base = String(git(['merge-base', 'origin/main', 'HEAD'])).trim();
  if (!base) throw new Error('empty merge-base against origin/main');
  return parseObservedFiles({
    diffOut: String(git(['diff', '--name-only', '--end-of-options', `${base}...HEAD`])),
    porcelainOut: String(git(['status', '--porcelain'])),
    repoKey,
  });
}

/**
 * Build the injected reader.
 *
 * `reconcile` and `observedFiles` DEFAULT TO THE REAL BINDINGS. They were parameters defaulting to `null` so
 * a test could drive the #2803 branch without a git tree — and `run.mjs` calls this with no arguments, so the
 * scope-drift guard NEVER RECONCILED ANYTHING in the wired operation (PR #1510 correctness juror, blocker).
 *
 * The second half of that bug is subtler and is fixed below: with `reconcile` null, this reported
 * `scopeDeclared: true` with an empty `offending`, which `planResolve` reads as "ran and found nothing".
 * The declaration's whole three-state design exists to keep "could not check" apart from "checked clean",
 * and the wiring collapsed it anyway. `scopeDeclared` now means THE RECONCILIATION RAN — nothing else.
 */
export function createResolveReader({
  root = REPO_ROOT,
  listFiles = (dir) => readdirSync(dir),
  readText = (path) => readFileSync(path, 'utf8'),
  exec = execFileSync,
  today = localToday,
  // Injected so the declaration's scope-drift branch is reachable in a test. The real bindings are
  // `we:scripts/lib/scope-reconcile.mjs` and the observed-file walk the CLI uses.
  reconcile = reconcileScope,
  observedFiles = observedFilesForResolve,
} = {}) {
  return ({ ref }) => {
    const file = resolveBacklogFile(ref, root, listFiles);
    if (!file) return { found: false };

    const abs = join(backlogDir(root), file);
    const rel = `backlog/${file}`;
    const content = readText(abs);
    const id = idFromName(file);
    const kind = readField(content, 'kind') || '';
    const status = readField(content, 'status') || '';

    // #658 — children by the `parent:` EDGE, never the body's prose listing. Only for an epic: walking every
    // card to find children of a story would be pure cost for a guard that cannot fire.
    const openChildren = [];
    if (kind === 'epic') {
      for (const f of listFiles(backlogDir(root)).filter((n) => n.endsWith('.md'))) {
        if (f === file) continue;
        let body;
        try { body = readText(join(backlogDir(root), f)); } catch { continue; }
        const parent = readField(body, 'parent');
        if (!parent || parent.replace(/^["']|["']$/g, '') !== id) continue;
        // THE HOME'S OWN PREDICATE, not an approximation of it: `openChildrenOf` in
        // `we:scripts/backlog.mjs` counts a child as open when its status is anything OTHER THAN
        // `resolved`, defaulting an absent status to `open`. An ALLOWLIST of open/active/preparing was
        // here first and silently dropped `parked` — a first-class status — so an epic with parked
        // children resolved through the operation while the CLI would have refused it (PR #1510
        // correctness juror, round 3).
        //
        // An exclusion is the right shape for the same reason it is there: a status this file has never
        // heard of must count as OPEN, because the alternative is a new status silently disabling the
        // guard. This is the third finding on this operation with one root — re-deriving a predicate
        // instead of reading the home that owns it.
        const st = readField(body, 'status') || 'open';
        if (!isTerminalStatus(st)) openChildren.push({ num: idFromName(f), status: st });
      }
    }

    // #2803 — THREE-STATE. `scopeDeclared` means THE RECONCILIATION RAN, not merely that the card names a
    // `scope:`. Setting it from the frontmatter alone is what let a null `reconcile` report "checked clean"
    // for a check that never executed — the exact collapse the declaration's three states exist to prevent.
    let scopeDeclared = false;
    let offending = [];
    const declared = readScopeList(content);
    const hasDeclaredScope = Array.isArray(declared) && declared.length > 0;
    if (hasDeclaredScope && typeof reconcile === 'function' && typeof observedFiles === 'function') {
      try {
        const observed = observedFiles({ root, exec });
        offending = reconcile({
          declared, // the PARSED ARRAY — see `readScopeList`
          observed,
          routeGraph: { routeEntries: ROUTE_ENTRIES },
        })?.offending ?? [];
        scopeDeclared = true; // set ONLY after the reconciliation actually returned
      } catch {
        // A reconciliation that THREW has not reported clean. Left `false` so the declaration reports
        // `scopeUnchecked` rather than a clean run.
        scopeDeclared = false;
        offending = [];
      }
    }

    return { found: true, abs, rel, id, kind, status, content, openChildren, scopeDeclared, offending, today: today() };
  };
}

/**
 * BUILD THE SINK MAP for `resolve`'s one effect. Applies the already-computed bytes through the guarded
 * writer, which owns the lane-not-primary refusal — never a bare `writeFileSync`.
 */
export function createResolveSinks({ root = REPO_ROOT } = {}) {
  return {
    [RESOLVE_EFFECT]: async (payload) => {
      writeBacklogMd(payload.abs, payload.rel, payload.content, { root });
      return { rel: payload.rel, written: true };
    },
  };
}
