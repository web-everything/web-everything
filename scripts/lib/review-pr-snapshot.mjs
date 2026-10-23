/** Shared PR reads: immutable fields keep live metadata; explicitly head-pinned
 * informational context is TTL bounded. Authority readers always fetch live.
 * review.prSnapshot.ttlMs: standard 120000 < platform review.prSnapshot <
 * review-settings.json prSnapshot < WE_REVIEW_PR_SNAPSHOT_TTL_MS; 0 disables.
 * Diff bases can move without a push: baseRefOid is an additional discriminator.
 * Net/stack diffs and all review authority remain live in their existing readers.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { defaultPoolRoot } from './lane-pool-paths.mjs';
import { isUnderTest } from './under-test.mjs';
import { withFileLock, writeJsonAtomic } from './atomic-json-file.mjs';
import { PR_VIEW_FIELDS } from './pr-view-transport.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const IMMUTABLE = new Set(['files', 'commits', 'diff']);
const validPart = (field, value) => field === 'diff' ? typeof value === 'string' : Array.isArray(value);
const sha = v => typeof v === 'string' && /^[a-f0-9]{40,64}$/i.test(v);
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

// Informational context only. Never substitute this for label/merge/write authority or
// a live head check. A caller must supply the head its work order is examining.
export const PR_CONTEXT_FIELDS = Object.freeze([...new Set([
  ...PR_VIEW_FIELDS, 'headRefOid', 'baseRefOid', 'baseRefName', 'commits',
])]);

/** Authority-bearing review entry reads stay LIVE, while seeding context for
 * downstream jurors. No second gh call is needed to publish the same response. */
export function readLivePrContext({ repo, pr, exec, ...options } = {}) {
  const view = JSON.parse(String(exec(['pr', 'view', String(pr), '--repo', repo, '--json', PR_CONTEXT_FIELDS.join(',')])));
  if (sha(view?.headRefOid) && Number(view.number) === Number(pr)
    && Array.isArray(view.files) && Array.isArray(view.comments)) {
    // A fresh authority read must also replace old same-head context.
    try { readPinnedPrContext({ ...options, repo, pr, headSha: view.headRefOid, exec: () => JSON.stringify(view), refresh: true }); }
    catch { /* Cache IO/lock failure must not fail a successful live authority read. */ }
  }
  return view;
}

/** Share contextual PR reads across jurors/fixers, with no gh probe on a hit.
 * The explicit head is part of the key AND checked against a miss's response.
 * readComments, when supplied, proves a complete REST thread (never a list snapshot).
 * Read it before the view, so the final view also checks for a push during that read.
 */
export function readPinnedPrContext({ repo, pr, headSha, exec, readComments,
  env = process.env, dir, now = Date.now, settings = resolvePrSnapshotSettings({ env }), refresh = false,
} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !Number.isSafeInteger(Number(pr)) || Number(pr) <= 0 || !sha(headSha)) {
    throw new Error('pr-context: repo, positive PR and full head SHA are required');
  }
  headSha = headSha.toLowerCase();
  const identity = [env.GH_HOST || 'github.com', repo.toLowerCase(), Number(pr), headSha, 'context'];
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const root = dir ?? join(defaultPoolRoot(ROOT, env), '.admission', 'pr-snapshots');
  const path = join(root, `${key}.json`);
  const ttl = settings.value.ttlMs;
  const enabled = ttl > 0 && (!isUnderTest(env) || !!dir);
  const hit = () => {
    if (!enabled || refresh) return null;
    const cached = readJson(path), age = now() - cached?.at;
    return cached?.version === 2 && JSON.stringify(cached.identity) === JSON.stringify(identity)
      && age >= 0 && age < ttl && Number(cached.data?.number) === Number(pr)
      && cached.data?.headRefOid?.toLowerCase() === headSha
      && Array.isArray(cached.data.files) && Array.isArray(cached.data.comments)
      && (!readComments || cached.commentsComplete) ? cached.data : null;
  };
  const fetch = () => {
    const comments = readComments?.(Number(pr), { repo, exec: (file, args, opts) => exec(args, opts) });
    if (readComments && !Array.isArray(comments)) throw new Error('pr-context: complete comments unreadable');
    const data = JSON.parse(String(exec(['pr', 'view', String(pr), '--repo', repo, '--json', PR_CONTEXT_FIELDS.join(',')])));
    if (data?.headRefOid?.toLowerCase() !== headSha || Number(data.number) !== Number(pr)) {
      throw new Error('pr-context: PR or head changed; refusing mismatched context');
    }
    if (!Array.isArray(data.files) || !Array.isArray(data.comments)) throw new Error('pr-context: incomplete view');
    if (readComments) data.comments = comments;
    if (enabled) {
      try { writeJsonAtomic(path, { version: 2, identity, at: now(), data, commentsComplete: !!readComments }, { mode: 0o600 }); }
      catch { /* An unwritable cache never changes the fresh read's result. */ }
    }
    return data;
  };
  const cached = hit();
  if (cached) return cached;
  if (!enabled) return fetch();
  try { mkdirSync(root, { recursive: true }); } catch { return fetch(); }
  // One refresh across processes; cache is checked again after acquiring the lock.
  return withFileLock(`${path}.lock`, () => hit() ?? fetch(), { timeoutMs: 90000, staleMs: 120000 });
}
export function resolvePrSnapshotSettings({ env = process.env, fileConfig = readJson(join(ROOT, 'scripts', 'review-settings.json')), platform, log } = {}) {
  const pick = v => v?.ttlMs === undefined ? {} : { ttlMs: v.ttlMs };
  const raw = env.WE_REVIEW_PR_SNAPSHOT_TTL_MS;
  return cascadePolicy('review.prSnapshot', pick(fileConfig?.prSnapshot), {
    standard: { ttlMs: 120000 }, platform: pick(platform ?? platformPreference('review', { env })?.prSnapshot), env, log,
    envValues: { ttlMs: typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : undefined },
    valid: { ttlMs: v => Number.isSafeInteger(v) && v >= 0 },
  });
}

/** exec is the existing gh argv -> stdout port. `diff` additionally reads `pr diff`.
 * Only requested fields escape this adapter; no metadata or authority is stored. */
export function readSnapshotPrView({ repo, pr, fields, exec, env = process.env,
  dir, now = Date.now, settings = resolvePrSnapshotSettings({ env }),
} = {}) {
  const requested = [...fields];
  const run = names => {
    const jsonFields = names.filter(f => f !== 'diff');
    const view = JSON.parse(exec(['pr', 'view', String(pr), '--repo', repo, '--json', jsonFields.join(',')]));
    if (names.includes('diff')) view.diff = String(exec(['pr', 'diff', String(pr), '--repo', repo]));
    return view;
  };
  const ttl = settings.value.ttlMs;
  const immutable = requested.filter(f => IMMUTABLE.has(f));
  // Keep unrelated readers and tests on their original single-call path.
  if (!ttl || !immutable.length || (isUnderTest(env) && !dir)) return run(requested);
  const proof = ['headRefOid', 'baseRefOid'];
  const project = view => Object.fromEntries(requested.filter(f => Object.hasOwn(view, f)).map(f => [f, view[f]]));
  const live = run([...new Set([...requested.filter(f => !IMMUTABLE.has(f)), ...proof])]);
  if (!sha(live.headRefOid) || !sha(live.baseRefOid)) return project(run([...new Set([...requested, ...proof])]));
  const identity = [env.GH_HOST || 'github.com', repo, Number(pr), live.headRefOid, live.baseRefOid];
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const cacheDir = dir ?? join(defaultPoolRoot(ROOT, env), '.admission', 'pr-snapshots');
  const path = join(cacheDir, `${key}.json`);
  const cached = readJson(path);
  const age = now() - cached?.at;
  if (cached?.version === 1 && JSON.stringify(cached.identity) === JSON.stringify(identity)
    && age >= 0 && age < ttl && immutable.every(f => validPart(f, cached.data?.[f]))) {
    return project({ ...live, ...Object.fromEntries(immutable.map(f => [f, cached.data[f]])) });
  }
  // Fetch the original view together with its proof: a concurrent push must never store
  // the new head's payload under the old head. Return this fresh response on a miss.
  const fresh = run([...new Set([...requested, ...proof])]);
  // `pr diff` has no JSON proof attached. Check both tips AFTER that separate
  // call, too; a concurrent push/retarget must never poison an earlier snapshot.
  let after = fresh;
  if (requested.includes('diff')) { try { after = run(proof); } catch { after = {}; } }
  if (after.headRefOid === fresh.headRefOid && after.baseRefOid === fresh.baseRefOid
    && fresh.headRefOid === live.headRefOid && fresh.baseRefOid === live.baseRefOid
    && immutable.every(f => validPart(f, fresh[f]))) {
    let temp;
    try {
      mkdirSync(cacheDir, { recursive: true });
      temp = `${path}.${randomUUID()}.tmp`;
      const data = Object.fromEntries(immutable.map(f => [f, fresh[f]]));
      writeFileSync(temp, JSON.stringify({ version: 1, identity, at: now(), data }), { flag: 'wx', mode: 0o600 });
      renameSync(temp, path); // Atomic publication across juror/fixer processes.
    } catch { /* Cache IO never changes a read's outcome. */ }
    finally { if (temp) { try { unlinkSync(temp); } catch { /* renamed or unwritable */ } } }
  }
  return project(fresh);
}
