/** Configurable fix-session scope holds; conservative region observations and shared policy cascade. */
import { execFileSync } from 'node:child_process';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';

export const FIX_SCOPE_DEFAULTS = Object.freeze({
  holdMode: 'active-session', overlapGranularity: 'region', regionMarginLines: 20,
  priorityBypass: true, stalledAfterMinutes: 30, fastTrackLabels: Object.freeze(['fast-track', 'priority:urgent']),
});
const valid = {
  holdMode: v => ['active-session', 'pr-lifetime'].includes(v),
  overlapGranularity: v => ['region', 'file'].includes(v),
  regionMarginLines: v => Number.isInteger(v) && v >= 0 && v <= 10000,
  priorityBypass: v => typeof v === 'boolean',
  stalledAfterMinutes: v => typeof v === 'number' && Number.isFinite(v) && v > 0,
  fastTrackLabels: v => Array.isArray(v) && v.every(s => typeof s === 'string'),
};
const numberEnv = v => v === undefined ? undefined : String(v).trim() === '' ? v : Number(v);
const booleanEnv = v => v === undefined ? undefined : /^(on|true|1)$/i.test(v) ? true : /^(off|false|0)$/i.test(v) ? false : v;
const read = fn => { try { return fn() ?? {}; } catch { return {}; } };
export function resolveFixScopePolicy({ env = process.env, readTool = readSettings, platform } = {}) {
  return cascadePolicy('fixScope', read(readTool).fixScope, { standard: FIX_SCOPE_DEFAULTS, platform, env, valid,
    envValues: {
      holdMode: env.WE_FIX_SCOPE_HOLD_MODE, overlapGranularity: env.WE_FIX_SCOPE_OVERLAP_GRANULARITY,
      regionMarginLines: numberEnv(env.WE_FIX_SCOPE_REGION_MARGIN_LINES), priorityBypass: booleanEnv(env.WE_FIX_SCOPE_PRIORITY_BYPASS),
      stalledAfterMinutes: numberEnv(env.WE_FIX_SCOPE_STALLED_AFTER_MINUTES),
    },
  });
}
const prNumber = v => /^(?:#)?[1-9]\d*$/.test(String(v)) && Number.isSafeInteger(Number(String(v).replace(/^#/, ''))) ? Number(String(v).replace(/^#/, '')) : null;
export function resolveOperatorPriorityPrs({ env = process.env, readTool = readSettings, platform } = {}) {
  const resolved = cascadePolicy('build', read(readTool).build, { standard: { priority: [] }, platform, env,
    valid: { priority: v => Array.isArray(v) && v.every(p => prNumber(p) !== null) },
    envValues: { priority: env.WE_BUILD_PRIORITY === undefined ? undefined : String(env.WE_BUILD_PRIORITY).split(/[,\s]+/).filter(Boolean) },
  });
  return { prs: new Set(resolved.value.priority.map(prNumber)), source: resolved.sources.priority };
}

/** Old-side coordinates. null per file means a non-text/add/delete/rename or unreadable patch. */
export function parseUnifiedZeroHunks(diffText) {
  const out = new Map();
  if (typeof diffText !== 'string') return out;
  let file = null, inHunk = false;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) { file = null; inHunk = false; continue; }
    if (!inHunk && line.startsWith('--- ')) {
      const path = line.slice(4).replace(/\t.*$/, '');
      file = path.startsWith('a/') ? path.slice(2) : null;
      if (file) out.set(file, []);
    } else if (!inHunk && line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/\t.*$/, '');
      if (file && path !== `b/${file}`) out.set(file, null);
    } else if (file && line.startsWith('@@')) {
      inHunk = true;
      const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
      if (!m) { out.set(file, null); continue; }
      const start = Number(m[1]), count = m[2] === undefined ? 1 : Number(m[2]);
      out.get(file)?.push([start, start + Math.max(0, count - 1)]);
    }
  }
  return out;
}
export function rangesIntersect(rangesA, rangesB, margin = 20) {
  return rangesA.some(([a, b]) => rangesB.some(([c, d]) => a - margin <= d + margin && c - margin <= b + margin));
}
export function regionOverlapDecision({ file, hunksA, hunksB, margin = 20, mergeConflict }) {
  const a = hunksA?.get(file), b = hunksB?.get(file);
  if (!a?.length || !b?.length || mergeConflict == null) return { overlap: true, why: 'region observation unavailable; retaining file hold', failedClosed: true };
  if (mergeConflict) return { overlap: true, why: 'trial merge conflicts' };
  const overlap = rangesIntersect(a, b, margin);
  return { overlap, why: overlap ? 'changed regions intersect within margin' : 'changed regions are disjoint and trial merge is clean' };
}

/** git seam receives argv and returns stdout; subprocess failures carry their numeric exit status. Never throws.
 * Cache includes origin/main's current tip, so a reader remains valid across base movement. */
export function createRegionReader({ root, git = args => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
}) } = {}) {
  const hunks = new Map(), merges = new Map(), fetched = new Set();
  const run = args => { try { return String(git(args)).trim(); } catch { return null; } };
  const tip = () => run(['rev-parse', '--verify', 'origin/main^{commit}']);
  const ensureHead = (sha, pr) => {
    if (!sha) return null;
    if (run(['rev-parse', '--verify', `${sha}^{commit}`])) return sha;
    if (prNumber(pr) !== null && !fetched.has(Number(pr))) {
      fetched.add(Number(pr)); run(['fetch', 'origin', `refs/pull/${Number(pr)}/head`]);
      if (run(['rev-parse', '--verify', `${sha}^{commit}`])) return sha;
    }
    return null;
  };
  return {
    hunksFor(headSha, pr) {
      const baseTip = tip(), key = JSON.stringify([pr ?? null, headSha, baseTip]);
      if (hunks.has(key)) return hunks.get(key);
      let result = null;
      if (baseTip && ensureHead(headSha, pr)) {
        const base = run(['merge-base', baseTip, headSha]);
        const diff = base && run(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', base, headSha, '--']);
        if (diff !== null && diff !== undefined) result = parseUnifiedZeroHunks(diff);
      }
      hunks.set(key, result); return result;
    },
    mergeConflicts(headA, headB) {
      if (!headA || !headB) return null;
      const key = JSON.stringify([tip(), ...[headA, headB].sort()]);
      if (merges.has(key)) return merges.get(key);
      let result;
      try { git(['merge-tree', '--write-tree', '--name-only', '--no-messages', headA, headB]); result = false; }
      catch (e) { result = e?.status === 1 ? true : null; }
      merges.set(key, result); return result;
    },
  };
}
