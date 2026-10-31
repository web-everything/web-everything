/** Configurable fix-session scope holds; conservative region observations and shared policy cascade. */
import { execFileSync } from 'node:child_process';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';

export const FIX_SCOPE_DEFAULTS = Object.freeze({
  holdMode: 'active-session', overlapGranularity: 'region', regionMarginLines: 20,
  waitForLandingHolder: Object.freeze({ enabled: true, holderStates: Object.freeze(['review:accepted', 'in-merge-queue']) }),
  priorityBypass: true, stalledAfterMinutes: 30, fastTrackLabels: Object.freeze(['fast-track', 'priority:urgent']),
});
const validHolderStates = v => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s.trim() !== '');
const valid = {
  waitForLandingHolder: v => typeof v === 'boolean' || validHolderStates(v),
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
  const resolved = cascadePolicy('fixScope', read(readTool).fixScope, { standard: FIX_SCOPE_DEFAULTS, platform, env, valid,
    envValues: {
      holdMode: env.WE_FIX_SCOPE_HOLD_MODE, overlapGranularity: env.WE_FIX_SCOPE_OVERLAP_GRANULARITY,
      regionMarginLines: numberEnv(env.WE_FIX_SCOPE_REGION_MARGIN_LINES), priorityBypass: booleanEnv(env.WE_FIX_SCOPE_PRIORITY_BYPASS),
      stalledAfterMinutes: numberEnv(env.WE_FIX_SCOPE_STALLED_AFTER_MINUTES),
    },
  });
  // The cascade validates by top-level key; enforce each nested leaf's distinct shape afterward.
  // waitForLandingHolder deliberately has no environment override.
  const setting = resolved.value.waitForLandingHolder;
  resolved.value.waitForLandingHolder = {
    enabled: setting?.enabled,
    holderStates: setting?.holderStates,
  };
  for (const [leaf, check] of [['enabled', v => typeof v === 'boolean'], ['holderStates', validHolderStates]]) {
    const path = `waitForLandingHolder.${leaf}`;
    if (check(resolved.value.waitForLandingHolder[leaf])) continue;
    resolved.invalid.push(`${resolved.sources[path] ?? 'tool'}.${path}=${JSON.stringify(resolved.value.waitForLandingHolder[leaf])}`);
    resolved.value.waitForLandingHolder[leaf] = FIX_SCOPE_DEFAULTS.waitForLandingHolder[leaf];
    resolved.sources[path] = 'standard';
    resolved.leafValues[path] = FIX_SCOPE_DEFAULTS.waitForLandingHolder[leaf];
  }
  return resolved;
}
const prNumber = v => /^(?:#)?[1-9]\d*$/.test(String(v)) && Number.isSafeInteger(Number(String(v).replace(/^#/, ''))) ? Number(String(v).replace(/^#/, '')) : null;
export function resolveOperatorPriorityPrs({ env = process.env, readTool = readSettings, platform } = {}) {
  const resolved = cascadePolicy('build', read(readTool).build, { standard: { priority: [] }, platform, env,
    valid: { priority: v => Array.isArray(v) && v.every(p => prNumber(p) !== null) },
    envValues: { priority: env.WE_BUILD_PRIORITY === undefined ? undefined : String(env.WE_BUILD_PRIORITY).split(/[,\s]+/).filter(Boolean) },
  });
  return { prs: new Set(resolved.value.priority.map(prNumber)), source: resolved.sources.priority };
}

const matchedHolderStates = (state, holderStates) => typeof state.baseRefName === 'string' && state.baseRefName !== 'main' ? [] : (holderStates ?? []).filter(s =>
  (s === 'in-merge-queue' && state.inMergeQueue === true)
  || (state.labels ?? []).some(label => (typeof label === 'string' ? label : label?.name) === s));

const RED_TEAM_BLOCKED = 'red-team:blocked';
/** Reasons a matched holder can never land as it stands: a draft (operator-parked) or a red-team block.
 * Missing isDraft (legacy snapshot) is not evidence of a draft, so the hold is retained. */
const cannotLandReasons = state => [
  ...(state.isDraft === true ? ['draft'] : []),
  ...((state.labels ?? []).some(label => (typeof label === 'string' ? label : label?.name) === RED_TEAM_BLOCKED) ? [RED_TEAM_BLOCKED] : []),
];

/** PURE: only a holder near landing can use a real conflict to serialize fixers. */
export function landingHolderDecision({ state, setting }) {
  if (setting?.enabled !== true) return { hold: true, why: 'trial merge conflicts' };
  if (state == null) return { hold: true, failedClosed: true, why: 'trial merge conflicts; holder state unreadable, retaining hold' };
  const matched = matchedHolderStates(state, setting.holderStates);
  const blocked = matched.length ? cannotLandReasons(state) : [];
  if (blocked.length) return { hold: false,
    why: `trial merge conflicts; holder cannot land: ${blocked.join(', ')} — not waiting, dispatching in parallel, land-time conflict handling resolves it` };
  if (matched.length) return { hold: true, landing: true,
    why: `trial merge conflicts; holder is landing (${matched.join(', ')}) — waiting until it merges` };
  return { hold: false, why: 'trial merge conflicts; holder not near landing — dispatching in parallel, land-time conflict handling resolves it' };
}

/** PURE: parse one GraphQL page into PR states; null means the response is unreadable. */
export function parseHolderStates(json) {
  try {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const nodes = data?.data?.repository?.pullRequests?.nodes;
    if (data?.errors?.length || !Array.isArray(nodes)) return null;
    const states = new Map();
    for (const node of nodes) {
      if (prNumber(node?.number) === null || typeof node.headRefOid !== 'string'
        || typeof node.isInMergeQueue !== 'boolean' || (node.isDraft !== undefined && typeof node.isDraft !== 'boolean')
        || !Array.isArray(node.labels?.nodes)
        || !node.labels.nodes.every(label => typeof label?.name === 'string')) return null;
      states.set(Number(node.number), { labels: node.labels.nodes.map(label => label.name),
        inMergeQueue: node.isInMergeQueue, headRefOid: node.headRefOid,
        ...(typeof node.isDraft === 'boolean' ? { isDraft: node.isDraft } : {}),
        ...(typeof node.baseRefName === 'string' ? { baseRefName: node.baseRefName } : {}) });
    }
    return states;
  } catch { return null; }
}

/** One lazy, cached open-PR snapshot per pass, paginated at most five times. Never throws.
 * A partial or failed snapshot is unreadable rather than evidence that a holder is absent. */
export function createHolderStateReader({ repo, // owner/name slug (ghRepoSlug); missing = unreadable, fail closed
  exec = (command, args) => execFileSync(command, args, {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }),
} = {}) {
  let loaded = false, states = null;
  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      const [owner, name] = String(repo ?? '').split('/');
      if (!owner || !name) return;
      const query = `query($owner: String!, $name: String!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          pullRequests(states: OPEN, first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { number headRefOid baseRefName isDraft isInMergeQueue labels(first: 50) { nodes { name } } }
          }
        }
      }`;
      const snapshot = new Map();
      let cursor = null;
      for (let page = 0; page < 5; page++) {
        const json = JSON.parse(String(exec('gh', ['api', 'graphql', '-f', `query=${query}`,
          '-f', `owner=${owner}`, '-f', `name=${name}`, ...(cursor ? ['-f', `cursor=${cursor}`] : [])])));
        const parsed = parseHolderStates(json);
        const info = json?.data?.repository?.pullRequests?.pageInfo;
        if (!parsed || typeof info?.hasNextPage !== 'boolean') return;
        for (const [pr, state] of parsed) snapshot.set(pr, state);
        if (!info.hasNextPage) { states = snapshot; return; }
        if (typeof info.endCursor !== 'string' || !info.endCursor || info.endCursor === cursor) return;
        cursor = info.endCursor;
      }
    } catch { /* unreadable state retains conflict holds */ }
  };
  return {
    stateFor(pr) { load(); return states?.get(Number(pr)) ?? null; },
    landingPrs(holderStates) {
      load();
      return states ? [...states].filter(([, state]) => matchedHolderStates(state, holderStates).length).map(([pr]) => pr) : [];
    },
  };
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
  if (mergeConflict) return { overlap: true, conflict: true, why: 'trial merge conflicts' };
  const overlap = rangesIntersect(a, b, margin);
  return { overlap, why: overlap ? 'changed regions intersect within margin' : 'changed regions are disjoint and trial merge is clean' };
}

/** The live `regionOverlap` callback for filterFixesByInFlightScope. IO is injected: `readPrHeads(root, prs)`
 * returns a Map of current heads, and `regionReader` is a {@link createRegionReader} (null disables regions). */
export function createLiveRegionOverlap({ holderEntries = new Map(), readPrHeads, regionReader, policy, root }) {
  const observedHeads = new Map();
  const headFor = e => {
    const pr = Number(e.pr);
    // Claim metadata records the acquisition head; heartbeats do not track fixer pushes.
    // Only current PR observations can release a file hold. Missing heads fail closed below.
    const sha = e.headRefOid || holderEntries.get(pr)?.headRefOid;
    if (sha) return sha;
    if (!observedHeads.has(pr)) observedHeads.set(pr, readPrHeads(root, [pr]).get(pr) ?? null);
    return observedHeads.get(pr);
  };
  return (candidate, holder, sharedFile) => {
    // Only identical file entries can use regions. Directory/ancestor scopes remain exclusive.
    if (!regionReader) return { overlap: true, why: 'region reader unavailable', failedClosed: true };
    if (!holder.pr || !(candidate.overlapScope ?? candidate.scope)?.includes(sharedFile)
      || !holder.scope?.includes(sharedFile) || sharedFile.endsWith('/')) {
      return { overlap: true, why: 'build or directory scope requires file hold', failedClosed: true };
    }
    const file = sharedFile.replace(/^[^:]+:/, '');
    const a = headFor(candidate), b = headFor(holder);
    return regionOverlapDecision({ file, hunksA: regionReader.hunksFor(a, candidate.pr),
      hunksB: regionReader.hunksFor(b, holder.pr), margin: policy.value.regionMarginLines,
      mergeConflict: a && b ? regionReader.mergeConflicts(a, b) : null });
  };
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
