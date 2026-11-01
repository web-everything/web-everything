/** @file scripts/lib/daemon-rebuild/overlay-strategies.mjs — Overlay conflict-resolution strategies.
 * Split out of daemon-rebuild.mjs (move-only).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isExcludable } from './closure-scope.mjs';
import { FULL_SHA_RE, verifyRev, rebuildCommitEnv } from './shared.mjs';

/** Scope only conflicted paths, never other overlay changes. All Git evidence must be readable.
 * The temporary commit is an input to merge-tree only; the planner retains the real overlay parent. */
export function resolveClosureScopedConflict({ git, cur, ovSha, scope, tried = [] }) {
  let dir;
  try {
    const checked = (args, opts = {}, allowed = [0]) => {
      const r = git(args, opts);
      if (!r || r.error || !allowed.includes(r.status)) throw new Error('scoped Git evidence unavailable');
      return r;
    };
    const call = (args, opts, allowed) => String(checked(args, opts, allowed).stdout ?? '');
    const output = call(['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', cur, ovSha], {}, [1]);
    const records = output.split('\0');
    if (!FULL_SHA_RE.test(records.shift()) || records.pop() !== '') return null;
    const files = [...new Set(records.filter(Boolean))].sort();
    const actualScope = typeof scope === 'function' ? scope() : scope;
    if (!(actualScope instanceof Set) || !files.length || files.some(p => !isExcludable(p, actualScope))) return null;
    tried.push('closure-scope');
    const mb = call(['merge-base', cur, ovSha]).trim();
    if (!FULL_SHA_RE.test(mb)) return null;
    dir = mkdtempSync(join(tmpdir(), 'daemon-scoped-index-'));
    const opts = { env: { GIT_INDEX_FILE: join(dir, 'index') } };
    call(['read-tree', ovSha], opts);
    for (const path of files) {
      const base = call(['--literal-pathspecs', 'ls-tree', '-z', mb, '--', path]);
      if (!base) call(['update-index', '--force-remove', '--', path], opts);
      else {
        const match = /^(100[0-7]{3}|120000) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(base);
        if (!match || match[3] !== path) return null;
        call(['update-index', '--add', '--cacheinfo', match[1], match[2], path], opts);
      }
    }
    const tree = call(['write-tree'], opts).trim();
    if (!FULL_SHA_RE.test(tree)) return null;
    const scoped = call(['commit-tree', tree, '-p', ovSha, '-m', 'daemon-rebuild: scoped overlay input'], {
      env: rebuildCommitEnv(checked, cur, ovSha),
    }).trim();
    if (!FULL_SHA_RE.test(scoped)) return null;
    const merged = call(['merge-tree', '--write-tree', '--no-messages', `--merge-base=${mb}`, cur, scoped]).split('\n')[0].trim();
    return FULL_SHA_RE.test(merged) ? { ok: true, via: 'closure-scope', tree: merged, excluded: files } : null;
  } catch { return null; }
  finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
}

/** Ordered: first strategy that returns a result wins; a failed strategy leaves the next one available. */
export const OVERLAY_CONFLICT_STRATEGIES = Object.freeze([
  {
    name: 'edge-ref',
    run(ctx) {
      const { git, cur, ovSha, ref, approvedEdgeSha, tried } = ctx;
  try {
    if (approvedEdgeSha && FULL_SHA_RE.test(approvedEdgeSha)) {
      const edgeSha = verifyRev(git, `refs/remotes/origin/edge/${ref}^{commit}`);
      if (edgeSha === approvedEdgeSha) {
        tried.push('edge-ref');
        if (git(['merge-base', '--is-ancestor', ovSha, edgeSha]).status === 0) {
          const mt = git(['merge-tree', '--write-tree', '--no-messages', cur, edgeSha]);
          const tree = String(mt.stdout ?? '').split('\n')[0].trim();
          if (mt.status === 0 && tree) return { ok: true, via: 'edge-ref', tree, edgeSha };
        }
      } else if (edgeSha) {
        tried.push('edge-ref-unrecorded-tip');
      }
    }
  } catch { /* try replay */ }
      return null;
    },
  },
  {
    name: 'replay',
    run(ctx) {
      const { git, cur, ovSha, ref, approvedEdgeSha, tried } = ctx;
  tried.push('replay');
  try {
    // A merge commit can carry changes no other commit has (a conflict resolution, an adaptation). Replay
    // walks only non-merge commits, so it would adopt a tree missing that work while the build records the
    // whole PR head as incorporated. Refuse (fail closed → unresolved) rather than adopt a partial tree.
    // An unreadable merge probe also refuses: a wrong refusal only keeps the visible drop.
    const merges = git(['rev-list', '--merges', '--max-count=1', ovSha, '--not', cur]);
    const hasMerges = merges.status !== 0 || String(merges.stdout ?? '').trim() !== '';
    const revs = hasMerges ? null : git(['rev-list', '--reverse', '--no-merges', ovSha, '--not', cur]);
    const commits = String(revs?.stdout ?? '').trim().split(/\s+/).filter(Boolean);
    if (revs && revs.status === 0 && commits.length > 0) {
      let tip = cur;
      let tree;
      for (const c of commits) {
        const mt = git(['merge-tree', '--write-tree', '--no-messages', `--merge-base=${c}^`, tip, c]);
        tree = String(mt.stdout ?? '').split('\n')[0].trim();
        if (mt.status !== 0 || !tree) { tree = null; break; }
        const ct = git(['commit-tree', tree, '-p', tip, '-m', `daemon-rebuild: replay ${c}`], {
          env: rebuildCommitEnv(git, tip, c),
        });
        tip = String(ct.stdout ?? '').trim();
        if (ct.status !== 0 || !tip) { tree = null; break; }
      }
      if (tree) return { ok: true, via: 'replay', tree };
    }
  } catch { /* report the original conflict */ }
      return null;
    },
  },
  { name: 'closure-scope', run: ctx => ctx.scope ? resolveClosureScopedConflict(ctx) : null },
]);

/** Resolve only in the object DB; a failed strategy leaves the next one available.
 *  `approvedEdgeSha` is the sha an operator recorded for this overlay's `origin/edge/<ref>` (see
 *  {@link recordedEdgeSha}): an edge branch is adopted ONLY when its tip equals it. A branch that merely exists
 *  and contains the PR head — anyone with push access can create one — is never trusted. */
export function resolveOverlayConflict({ git, cur, ovSha, ref, approvedEdgeSha = null, scope, edgeResolve = true }) {
  const tried = [];
  for (const strategy of OVERLAY_CONFLICT_STRATEGIES) {
    if (!edgeResolve && strategy.name !== 'closure-scope') continue;
    const r = strategy.run({ git, cur, ovSha, ref, approvedEdgeSha, tried, scope });
    if (r) return r;
  }
  const files = [];
  try {
    const mt = git(['merge-tree', '--write-tree', '--name-only', cur, ovSha]);
    if (mt.status === 1) {
      for (const line of String(mt.stdout ?? '').split('\n').slice(1)) {
        if (!line) break;
        files.push(line);
      }
    }
  } catch { /* best-effort paths */ }
  return { ok: false, files, tried };
}
