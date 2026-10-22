/**
 * Post-approval card grouping (card xym8nt4).
 *
 * Problem: approved card-only PRs that edit the same card file wait behind each other in the drain
 * (the planner's `overlap-yield` deferrals). Each one takes a full merge-queue cycle, and each re-merge costs a
 * review round.
 *
 * What this does, once per drain pass, BEFORE the cascade enqueues anything (so the PR the others yield to can
 * still join the group instead of being queued ahead of it):
 *   1. FORM. From this pass's overlap waits (`cardGroupCandidates`: the planner's overlap-yield-only deferrals,
 *      the PRs they yield to, and any `queue-file-overlap` outcome), take PRs whose WHOLE diff is backlog cards
 *      (`isCardOnlyDiff` and every path `isCardPath`), that are open, non-draft, at the judged head,
 *      `ready-to-merge` + `review:accepted`, with no review hold, and that the strategy's own read-only
 *      admission check (`prestage`: live head, send-back, workflow surface, red-team hold) allows. PRs that
 *      share a card file form one group (connected components, oldest PR first, at most `maxSize`).
 *      The drain builds ONE combined commit chain on current origin/main: each source PR is 3-way merged in
 *      order with `git merge-tree` (object DB only, no worktree, no index of the clone). A conflict is
 *      resolved ONLY by the existing card resolver (`resolveRaisedByConflict`: union of the
 *      "Also raised by" list); any other conflict, or any refusal, drops the group and the PRs stay serial.
 *      The result must then pass `verifyUnion`: the lines the combined branch adds over main are exactly the
 *      union of the lines the sources add (after the shared JIT reference normalisation), no source line is
 *      missing, no line any source deleted comes back, and no file outside the sources' files changes.
 *      Then the branch `lane/card-group-<id>` is pushed (a NEW name, never forced), and one PR is opened that
 *      references every source PR, labelled `ready-to-merge` + `review:pending`. The union was never reviewed
 *      as a whole, so it gets the normal review again (card-only diffs already get the lighter juror set) and
 *      every other drain gate (required CI, merge queue CI, red-team policy).
 *   2. HOLD. While a group exists, every source PR is held by the drain (`holdFor`) so it can never land on
 *      its own beside the combined PR. Source PRs are NOT closed, relabelled or edited at this point: they
 *      only get one comment. This is the reversible option.
 *   3. RECONCILE (throttled). Combined PR merged → each source is checked against the NEW main (all its
 *      added lines present); a verified source is closed with a comment naming the combined PR; an
 *      unverified one is left open and released. Combined PR closed unmerged, failed required CI, or sent back
 *      (`review:changes` / `review:human`), or any source moved (head, labels, state) → the group dissolves:
 *      the drain closes ITS OWN combined PR with a comment and every source returns to the serial path with
 *      its approval untouched.
 *
 * Fail closed everywhere: an unreadable state file holds every PR the drain asks about (nothing can land
 * past a group it cannot see); any git/gh error, unknown file list, non-card path or resolver refusal means
 * "no group", never "group anyway".
 *
 * Settings (`drain.group.*`, policy cascade standard < platform < tool < env, each source logged):
 *   - `enabled` (boolean, standard false; env WE_DRAIN_GROUP_ENABLED true/false, 1/0, on/off)
 *   - `maxSize` (integer 2..20, standard 8; env WE_DRAIN_GROUP_MAX_SIZE)
 *   - `eligibility` (only 'card-only' is valid; code PRs are never grouped)
 *   - `reconcileSec` (integer 15..3600, standard 120): how often active groups are re-read
 *   - `retryMin` (integer 1..1440, standard 30): how long a source set whose build failed is not retried
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cascadePolicy } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { gitRun, hashObjectVerified } from './git-run.mjs';
import { isCardPath, isCardOnlyDiff } from '../ci-card-only.mjs';
import { resolveRaisedByConflict, loadCardConflictSettings } from './card-conflict-resolve.mjs';
import { collapseRollupToLatestPerName } from './rollup-collapse.mjs';
import { mapHashReferences } from '../backlog/id.mjs';
import { bornAsIndexFromItems } from '../conveyor/queue-store.mjs';
import { CONSTELLATION_REPOS, canonicalizeSlug, repoKeyForSlug } from './constellation-repos.mjs';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

export const CARD_GROUP_BRANCH_PREFIX = 'lane/card-group-';
export const CARD_GROUP_MARKER = 'we-card-group';
export const CARD_GROUP_TRAILER = 'Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>';
const SHA = /^[0-9a-f]{40}$/;
const firstLine = e => String(e?.message ?? e ?? '').split('\n')[0];
const labelNames = labels => (Array.isArray(labels) ? labels : []).map(l => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
// One spelling per repository: a URL/host prefix and `.git` are dropped, a known key (`we`) or a legacy
// `chalbert/<repo>` maps to the current slug, and case is folded. Otherwise the same repo reads as a different one.
const repoIdentity = repo => {
  const s = String(repo ?? '').trim()
    .replace(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?github\.com[/:]/i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const key = s ? repoKeyForSlug(s) : null;
  return (key ? CONSTELLATION_REPOS[key].slug : canonicalizeSlug(s)).toLowerCase();
};
const sameRepo = (a, b) => !!repoIdentity(a) && repoIdentity(a) === repoIdentity(b);

export function cardGroupStatePath(env = process.env) { return join(resolveCoordinationRoot({ env }), 'drain-card-groups.json'); }
export const CARD_GROUP_STATE_ENV = 'WE_DRAIN_CARD_GROUP_STATE';
/**
 * THE one state path. Grouping (writes) and every enqueue hold (reads) both resolve it here, so an override
 * can never split them. `WE_DRAIN_CARD_GROUP_STATE` wins; under test (VITEST / WE_UNDER_TEST) with no override
 * it is null (no live coordination file is read or written, and grouping is off).
 */
export function resolveCardGroupStatePath(env = process.env) {
  const override = String(env?.[CARD_GROUP_STATE_ENV] ?? '').trim();
  if (override) return override;
  if (env?.VITEST || env?.WE_UNDER_TEST) return null;
  return cardGroupStatePath(env);
}

const STANDARD = { enabled: false, maxSize: 8, eligibility: 'card-only', reconcileSec: 120, retryMin: 30 };
const intIn = (lo, hi) => v => Number.isInteger(v) && v >= lo && v <= hi;

/** Resolve `drain.group.*`. Never throws. */
export function readCardGroupSettings({ env = process.env, tool, platform, log } = {}) {
  const bool = raw => raw === undefined ? undefined : /^(true|1|on)$/i.test(raw) ? true : /^(false|0|off)$/i.test(raw) ? false : raw;
  const int = raw => raw === undefined ? undefined : /^\d+$/.test(String(raw).trim()) ? Number(raw) : raw;
  try {
    const block = tool ?? (env.VITEST || env.WE_UNDER_TEST ? {} : readSettings()?.drain?.group ?? {});
    const r = cascadePolicy('drainGroup', block, {
      env, platform, ...(log ? { log } : {}),
      standard: STANDARD,
      valid: { enabled: v => typeof v === 'boolean', maxSize: intIn(2, 20), eligibility: v => v === 'card-only',
        reconcileSec: intIn(15, 3600), retryMin: intIn(1, 1440) },
      envValues: { enabled: bool(env.WE_DRAIN_GROUP_ENABLED), maxSize: int(env.WE_DRAIN_GROUP_MAX_SIZE) },
    });
    const v = { ...STANDARD, ...(r.value ?? {}) };
    const src = k => r.sources?.[k] ?? 'standard';
    return { enabled: v.enabled === true && v.eligibility === 'card-only', maxSize: v.maxSize, eligibility: v.eligibility,
      reconcileSec: v.reconcileSec, retryMin: v.retryMin,
      sources: { enabled: src('enabled'), maxSize: src('maxSize'), eligibility: src('eligibility'), reconcileSec: src('reconcileSec'), retryMin: src('retryMin') } };
  } catch (e) {
    return { ...STANDARD, enabled: false, sources: { enabled: `unreadable (${firstLine(e)})` } };
  }
}

export const formatCardGroupSetting = s =>
  `drain.group.enabled=${s.enabled ? 'on' : 'off'} (${s.sources?.enabled ?? 'standard'}), maxSize=${s.maxSize} (${s.sources?.maxSize ?? 'standard'}), eligibility=${s.eligibility} (${s.sources?.eligibility ?? 'standard'})`;

/** PURE: the deterministic group id for a source set (order-free). */
export function groupId(sources) {
  const key = [...sources].map(s => `${Number(s.num)}@${s.headSha}`).sort().join(',');
  return createHash('sha256').update(key).digest('hex').slice(0, 10);
}
export const sourceSetKey = sources => [...sources].map(s => `${Number(s.num)}@${s.headSha}`).sort().join(',');

/** PURE: a `queue-file-overlap` reason ("#A,#B share f1, f2") names only card files. */
export function overlapReasonIsCardOnly(reason) {
  const at = String(reason ?? '').indexOf(' share ');
  if (at < 0) return false;
  const files = String(reason).slice(at + 7).split(', ').map(s => s.trim()).filter(Boolean);
  return files.length > 0 && files.every(isCardPath);
}

/**
 * PURE: connected components over shared card files. `candidates` = [{num, headSha, files}], every file a card.
 * Each component is ordered by PR number (oldest first) and capped at `maxSize`; only components of 2+ return.
 */
export function planCardGroups({ candidates = [], maxSize = 8 } = {}) {
  const list = candidates.filter(c => Number.isInteger(Number(c?.num)) && SHA.test(c?.headSha ?? '')
    && Array.isArray(c.files) && c.files.length && c.files.every(isCardPath))
    .sort((a, b) => Number(a.num) - Number(b.num));
  const parent = list.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map();
  list.forEach((c, i) => {
    for (const f of c.files) {
      if (owner.has(f)) parent[find(i)] = find(owner.get(f));
      else owner.set(f, i);
    }
  });
  const comps = new Map();
  list.forEach((c, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(c); });
  return [...comps.values()]
    .map(members => members.slice(0, Math.max(2, maxSize)))
    .filter(members => members.length >= 2)
    .map(members => ({ sources: members.map(m => ({ num: Number(m.num), headSha: m.headSha, files: [...m.files] })),
      files: [...new Set(members.flatMap(m => m.files))].sort() }));
}

/** IO: the bornAs → NNN map on `base`, the same one the card resolver uses. */
export function readReferenceMap({ base, cwd, run = gitRun }) {
  const aliases = run('git', ['grep', '-E', '^bornAs: x[0-9a-z]{6}$', base, '--', 'backlog/'], { cwd });
  if (![0, 1].includes(aliases.status)) return { ok: false, reason: 'cannot read JIT reference mapping' };
  const items = [];
  for (const line of String(aliases.stdout || '').split('\n')) {
    const match = /^backlog\/(\d+)-[^/]+\.md:bornAs: (x[0-9a-z]{6})$/.exec(line.slice(`${base}:`.length));
    if (match) items.push({ num: match[1], bornAs: match[2] });
  }
  // A bornAs claimed by two numbered cards is AMBIGUOUS: it is left out of the map (compared literally) and
  // returned, so the caller refuses any source whose change mentions it.
  const ambiguous = new Set(items.filter((item, i) => items.some((other, j) => i !== j && item.bornAs === other.bornAs && item.num !== other.num)).map(i => i.bornAs));
  return { ok: true, map: bornAsIndexFromItems(items.filter(i => !ambiguous.has(i.bornAs))), ambiguous };
}

// Paths are read NUL-separated (`-z`) and passed as literal pathspecs: git C-quotes a non-ASCII or special name in
// line output (`"k/caf\303\251.md"`), and a `*` in a name is a glob. Either would read a changed file as absent.
const zNames = r => String(r.stdout ?? '').split('\0').filter(Boolean);
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };
// `ignoreBOM: true` KEEPS a leading BOM in the text (the default strips it), so adding or removing one is a change.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** IO: make sure every sha is in the object DB; fetch by sha only (no ref, no FETCH_HEAD). */
export function ensureCommits({ shas, cwd, run = gitRun }) {
  const have = sha => run('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd }).status === 0;
  const missing = shas.filter(sha => !have(sha));
  if (!missing.length) return { ok: true };
  const f = run('git', ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', ...missing], { cwd });
  if (f.status !== 0 || missing.some(sha => !have(sha))) return { ok: false, reason: `fetch failed (${String(f.stderr ?? '').split('\n')[0] || `exit ${f.status}`})` };
  return { ok: true };
}

/** IO: a PR head's own changed files against its merge base with `base`. null = unknown. */
export function sourceFiles({ base, headSha, cwd, run = gitRun }) {
  const mb = run('git', ['merge-base', base, headSha], { cwd });
  const mbSha = String(mb.stdout ?? '').trim();
  if (mb.status !== 0 || !SHA.test(mbSha)) return null;
  const d = run('git', ['diff', '--name-only', '-z', '--no-renames', mbSha, headSha], { cwd });
  if (d.status !== 0) return null;
  return { mergeBase: mbSha, files: zNames(d) };
}

/** True only when the whole change list is backlog cards. */
export const cardOnlyFiles = files => Array.isArray(files) && files.length > 0 && files.every(isCardPath) && isCardOnlyDiff(files);

/**
 * IO (object DB only): apply each source onto `base` in order. Returns { ok, commit, steps } or { ok:false, reason }.
 * Each step is one commit (parent = the previous step) so the combined branch shows which PR added what.
 */
export function buildCombined({ base, sources, cwd, run = gitRun, env, referenceMap = new Map(), resolveEnabled = false, message = s => `card-group: apply #${s.num}` } = {}) {
  if (!SHA.test(base ?? '') || !Array.isArray(sources) || sources.length < 2) return { ok: false, reason: 'need a base and 2+ sources' };
  let cur = base;
  const steps = [];
  const tmp = mkdtempSync(join(tmpdir(), 'card-group-'));
  try {
    for (const s of sources) {
      const mt = run('git', ['-c', 'merge.conflictStyle=merge', 'merge-tree', '--write-tree', '--name-only', '--no-messages', cur, s.headSha], { cwd });
      const out = String(mt.stdout ?? '').split('\n');
      let tree = out[0]?.trim();
      if (![0, 1].includes(mt.status) || !SHA.test(tree ?? '')) return { ok: false, reason: `#${s.num}: merge-tree failed (${String(mt.stderr ?? '').split('\n')[0] || `exit ${mt.status}`})` };
      const resolved = [];
      if (mt.status === 1) {
        const paths = [...new Set(out.slice(1).map(l => l.trim()).filter(Boolean))];
        if (!paths.length) return { ok: false, reason: `#${s.num}: conflict with no named path` };
        const bad = paths.find(p => !isCardPath(p));
        if (bad) return { ok: false, reason: `#${s.num}: non-card conflict (${bad})` };
        // cardConflicts.autoResolveRaisedBy is honoured exactly as on the rebase path: disabled → no union, no group.
        if (resolveEnabled !== true) return { ok: false, reason: `#${s.num}: card conflict and cardConflicts.autoResolveRaisedBy disabled` };
        const index = join(tmp, `index-${s.num}`);
        const ienv = { ...(env ?? {}), GIT_INDEX_FILE: index };
        if (run('git', ['read-tree', tree], { cwd, env: ienv }).status !== 0) return { ok: false, reason: `#${s.num}: read-tree failed` };
        for (const path of paths) {
          const texts = [tree, cur, s.headSha].map(ref => run('git', ['show', `${ref}:${path}`], { cwd }));
          if (texts.some(r => r.status !== 0)) return { ok: false, reason: `#${s.num}: ${path} missing on one side` };
          const modes = [cur, s.headSha].map(ref => run('git', ['ls-tree', ref, '--', path], { cwd }));
          if (modes.some(r => r.status !== 0 || !String(r.stdout).startsWith('100644 blob '))) return { ok: false, reason: `#${s.num}: ${path} is not a regular file` };
          const res = resolveRaisedByConflict({ path, merged: String(texts[0].stdout), main: String(texts[1].stdout), pr: String(texts[2].stdout), referenceMap, enabled: resolveEnabled === true });
          if (!res.ok) return { ok: false, reason: `#${s.num}: ${path}: ${res.reason}` };
          const blob = hashObjectVerified(run, res.text, { cwd, env, label: path });
          if (!blob.ok) return { ok: false, reason: `#${s.num}: ${blob.reason}` };
          if (run('git', ['update-index', '--add', '--cacheinfo', '100644', blob.oid, path], { cwd, env: ienv }).status !== 0)
            return { ok: false, reason: `#${s.num}: could not stage ${path}` };
          resolved.push(path);
        }
        const wt = run('git', ['write-tree'], { cwd, env: ienv });
        tree = String(wt.stdout ?? '').trim();
        if (wt.status !== 0 || !SHA.test(tree)) return { ok: false, reason: `#${s.num}: write-tree failed` };
      }
      const ct = run('git', ['commit-tree', tree, '-p', cur, '-m', message(s)], { cwd, env });
      const commit = String(ct.stdout ?? '').trim();
      if (ct.status !== 0 || !SHA.test(commit)) return { ok: false, reason: `#${s.num}: commit-tree failed (${String(ct.stderr ?? '').split('\n')[0]})` };
      steps.push({ num: s.num, headSha: s.headSha, commit, resolved });
      cur = commit;
    }
    return { ok: true, commit: cur, steps };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp index cleanup is best effort */ }
  }
}

/** PURE: +/- lines per file from a `git diff -U0` text. */
export function parseDiffLines(text) {
  const files = new Map();
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) { cur = null; continue; }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      cur = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (cur && !files.has(cur)) files.set(cur, { added: [], removed: [] });
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') { const name = p.replace(/^a\//, ''); if (!files.has(name)) files.set(name, { added: [], removed: [] }); cur = name; }
      continue;
    }
    if (!cur || line.startsWith('@@') || line.startsWith('\\')) continue;
    if (line.startsWith('+')) files.get(cur).added.push(line.slice(1));
    else if (line.startsWith('-')) files.get(cur).removed.push(line.slice(1));
  }
  return files;
}

/** PURE: a file's lines (a trailing newline does not make an extra empty line). */
const splitLines = text => { const a = String(text ?? '').split('\n'); if (a.length && a.at(-1) === '') a.pop(); return a; };
const countOf = arr => { const m = new Map(); for (const l of arr) m.set(l, (m.get(l) ?? 0) + 1); return m; };
/** PURE: `needle` appears in `hay` in the same order (not necessarily adjacent). */
export const isSubsequence = (needle, hay) => { let i = 0; for (const l of hay) if (i < needle.length && l === needle[i]) i++; return i === needle.length; };
/**
 * IO: a file's normalized lines at `ref`, plus what a line comparison cannot see: the tree entry's `mode`
 * (100644, 100755, 120000 …) and `eol` (the file ends with a newline; an empty file counts as ending with one).
 * Null when the path is ABSENT there, proven by no exact `ls-tree` row; any git failure (ls-tree or show) or
 * non-UTF-8 content THROWS, so neither a read error nor a lossy decode can pass as "absent" or "unchanged".
 */
function readEntry({ ref, path, cwd, run, norm }) {
  const ls = run('git', ['ls-tree', '-z', ref, '--', path], { cwd, env: LITERAL });
  if (ls.status !== 0) throw new Error(`ls-tree ${String(ref).slice(0, 10)} ${path} failed`);
  // `<mode> <type> <oid>\t<path>`: only a row naming exactly this path counts (never a prefix or pattern match).
  const row = zNames(ls).find(r => r.slice(r.indexOf('\t') + 1) === path);
  if (!row) return null;
  const mode = row.split(/\s/)[0];
  const r = run('git', ['show', `${ref}:${path}`], { cwd, encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`show ${String(ref).slice(0, 10)}:${path} failed`);
  // Byte-exact: invalid UTF-8 would decode to U+FFFD and hide a byte change, so it refuses (throws) instead.
  let text;
  try { text = Buffer.isBuffer(r.stdout) ? utf8.decode(r.stdout) : String(r.stdout ?? ''); }
  catch { throw new Error(`${path} at ${String(ref).slice(0, 10)} is not valid UTF-8 text`); }
  // A leading BOM is a property of the file like its mode, not part of line 1 (that would make the first line
  // a different line and upset the order proof); `bom` carries it.
  const bom = text.startsWith('\ufeff');
  const body = bom ? text.slice(1) : text;
  return { lines: splitLines(body).map(norm), mode, eol: body === '' || body.endsWith('\n'), bom };
}
/** PURE: what a source sets beyond its lines: `mode` / `eol` when its head differs from its merge base (else null). */
const metaChange = (from, to) => ({ mode: from?.mode === to.mode ? null : to.mode, eol: from && from.eol === to.eol ? null : to.eol,
  bom: (from?.bom ?? false) === to.bom ? null : to.bom });
/** PURE: `head`'s lines (in order) that `target` still has — the order a source wants kept. */
const keptOrder = (head, target) => { const have = new Set(target); return head.filter(l => have.has(l)); };

/**
 * IO: one source's per-file change as ordered line multisets, after JIT reference normalisation.
 * Per path: `from` (counts at the source's merge base with `onto`), `to` (counts at its head), `addedSeq`
 * (its net-added lines in head order). A deleted file is reported as `deletedFile`.
 */
function sourceChange({ onto, headSha, cwd, run, norm }) {
  const mb = String(run('git', ['merge-base', onto, headSha], { cwd }).stdout ?? '').trim();
  if (!SHA.test(mb)) throw new Error('no merge base');
  const names = run('git', ['diff', '--name-only', '-z', '--no-renames', mb, headSha], { cwd });
  if (names.status !== 0) throw new Error('diff failed');
  const out = new Map();
  for (const path of zNames(names)) {
    const fromEntry = readEntry({ ref: mb, path, cwd, run, norm }), toEntry = readEntry({ ref: headSha, path, cwd, run, norm });
    if (toEntry === null) { out.set(path, { deletedFile: true }); continue; }
    const fromLines = fromEntry?.lines ?? [], toLines = toEntry.lines;
    const from = countOf(fromLines), to = countOf(toLines);
    // One path per diff, so the patch header's own quoting of the name never matters.
    const d = run('git', ['diff', '-U0', '--no-renames', '--no-color', mb, headSha, '--', path], { cwd, env: LITERAL });
    if (d.status !== 0) throw new Error('diff failed');
    const added = [...parseDiffLines(d.stdout).values()].flatMap(f => f.added);
    const addedSeq = added.map(norm).filter(l => (to.get(l) ?? 0) > (from.get(l) ?? 0));
    // A mode-only or final-newline-only change has no differing line, so it is carried separately (`meta`).
    out.set(path, { from, to, addedSeq, head: toLines, meta: metaChange(fromEntry, toEntry) });
  }
  return out;
}

/**
 * IO: prove the combined commit is exactly the union of the sources, on ORDERED line MULTISETS (counts, not
 * sets) after the resolver's JIT reference normalisation. Per file and per line `l` (b = count on base,
 * c = count on combined): when a source raises its count of `l` (to t), c must equal max(b, max t); when a
 * source lowers it (to t), c must equal min(b, min t); when no source changes it, c must equal b (so ANY
 * deletion or duplicate no source made — e.g. the union dedup dropping a repeated entry — refuses). A line one
 * source raises and another lowers refuses. Each source's added lines must appear in the combined file in the
 * source's order, and base lines that survive must keep their order. A file outside the sources, or a source
 * that deletes a file, refuses.
 */
export function verifyUnion({ base, combined, sources, cwd, run = gitRun, referenceMap = new Map() } = {}) {
  const norm = t => mapHashReferences(t, h => referenceMap.get(h) ?? h);
  const missing = [], extra = [], deleted = [], resurrected = [], disagree = [], order = [], outside = [], unsupported = [];
  const perFile = [];
  const changes = sources.map(s => ({ s, change: sourceChange({ onto: base, headSha: s.headSha, cwd, run, norm }) }));
  const paths = new Set(changes.flatMap(x => [...x.change.keys()]));
  const changed = run('git', ['diff', '--name-only', '-z', '--no-renames', base, combined], { cwd });
  if (changed.status !== 0) throw new Error('combined diff failed');
  for (const p of zNames(changed)) if (!paths.has(p)) outside.push(p);
  for (const path of [...paths].sort()) {
    if (changes.some(x => x.change.get(path)?.deletedFile)) { unsupported.push(`${path} deleted by a source`); continue; }
    const baseEntry = readEntry({ ref: base, path, cwd, run, norm }), combinedEntry = readEntry({ ref: combined, path, cwd, run, norm });
    const B = baseEntry?.lines ?? [], C = combinedEntry?.lines ?? null;
    if (C === null) { missing.push({ path, line: '(whole file)' }); continue; }
    // File mode and final newline: the combined file takes the value a source set (sources must agree), else the base's.
    for (const [key, label] of [['mode', 'file mode'], ['eol', 'final newline'], ['bom', 'byte-order mark']]) {
      const set = [...new Set(changes.map(x => x.change.get(path)?.meta?.[key]).filter(v => v != null))];
      if (set.length > 1) { disagree.push({ path, line: `(${label}: ${set.join(' vs ')})` }); continue; }
      const exp = set.length ? set[0] : baseEntry?.[key] ?? combinedEntry[key];
      if (combinedEntry[key] !== exp) (set.length ? missing : extra).push({ path, line: `(${label} ${exp} → ${combinedEntry[key]})`, expected: exp, found: combinedEntry[key] });
    }
    const b = countOf(B), c = countOf(C);
    const up = new Map(), down = new Map();
    for (const { change } of changes) {
      const ch = change.get(path);
      if (!ch) continue;
      for (const l of new Set([...ch.from.keys(), ...ch.to.keys()])) {
        const f = ch.from.get(l) ?? 0, t = ch.to.get(l) ?? 0;
        if (t > f) up.set(l, Math.max(up.get(l) ?? 0, t));
        if (t < f) down.set(l, Math.min(down.get(l) ?? Infinity, t));
      }
      // Order: the source's WHOLE head order (not only its added lines) must survive, so a reorder it made, or
      // one the union undid, refuses.
      if (!isSubsequence(ch.addedSeq, C) || !isSubsequence(keptOrder(ch.head, C), C)) order.push({ path, source: changes.find(x => x.change === change).s.num });
    }
    const keep = new Map();
    let added = 0, wanted = 0;
    for (const l of new Set([...b.keys(), ...c.keys(), ...up.keys(), ...down.keys()])) {
      const bb = b.get(l) ?? 0, cc = c.get(l) ?? 0;
      if (up.has(l) && down.has(l)) { disagree.push({ path, line: l }); continue; }
      const exp = up.has(l) ? Math.max(bb, up.get(l)) : down.has(l) ? Math.min(bb, down.get(l)) : bb;
      wanted += Math.max(0, exp - bb); added += Math.max(0, cc - bb);
      keep.set(l, Math.min(bb, exp));
      if (cc === exp) continue;
      if (cc < exp) (up.has(l) ? missing : deleted).push({ path, line: l, expected: exp, found: cc });
      else (down.has(l) ? resurrected : extra).push({ path, line: l, expected: exp, found: cc });
    }
    const survivors = [];
    for (const l of B) { const k = keep.get(l) ?? 0; if (k > 0) { survivors.push(l); keep.set(l, k - 1); } }
    if (!isSubsequence(survivors, C)) order.push({ path, source: 'base' });
    perFile.push({ path, sourceAdded: wanted, combinedAdded: added });
  }
  const ok = [missing, extra, deleted, resurrected, disagree, order, outside, unsupported].every(a => !a.length);
  return { ok, perFile, missing, extra, deleted, resurrected, disagree, order, outside, unsupported };
}

/**
 * IO: `source` (at the head given) is fully on `ref` (new main, after the combined PR merged): every line it
 * raises is on `ref` at least as often as in its head and in its order, every line it lowers is on `ref` at
 * most as often as in its head, and no file it deletes is still there.
 */
export function sourceLanded({ ref, source, cwd, run = gitRun, referenceMap = new Map() }) {
  const norm = t => mapHashReferences(t, h => referenceMap.get(h) ?? h);
  let change;
  try { change = sourceChange({ onto: ref, headSha: source.headSha, cwd, run, norm }); }
  catch (e) { return { ok: false, reason: firstLine(e) }; }
  for (const [path, ch] of change) {
    let entry;
    try { entry = readEntry({ ref, path, cwd, run, norm }); } catch (e) { return { ok: false, reason: firstLine(e) }; }
    if (ch.deletedFile) { if (entry !== null) return { ok: false, reason: `${path} still on main` }; continue; }
    if (entry === null) return { ok: false, reason: `${path} missing on main` };
    const R = entry.lines;
    // A mode-only or final-newline-only change has not landed until main carries it too.
    if (ch.meta?.mode != null && entry.mode !== ch.meta.mode) return { ok: false, reason: `${path} file mode on main is ${entry.mode}, the source sets ${ch.meta.mode}` };
    if (ch.meta?.eol != null && entry.eol !== ch.meta.eol) return { ok: false, reason: `${path} final newline on main differs from the source's` };
    if (ch.meta?.bom != null && entry.bom !== ch.meta.bom) return { ok: false, reason: `${path} byte-order mark on main differs from the source's` };
    const r = countOf(R);
    for (const l of new Set([...ch.from.keys(), ...ch.to.keys()])) {
      const f = ch.from.get(l) ?? 0, t = ch.to.get(l) ?? 0, have = r.get(l) ?? 0;
      if (t > f && have < t) return { ok: false, reason: `a line of ${path} is not on main` };
      if (t < f && have > t) return { ok: false, reason: `a line ${path} removes is still on main` };
    }
    if (!isSubsequence(ch.addedSeq, R) || !isSubsequence(keptOrder(ch.head, R), R)) return { ok: false, reason: `lines of ${path} are on main in a different order` };
  }
  return { ok: true };
}

/** PURE: the combined PR body. References every source PR. */
export function combinedPrBody({ id, sources, files, base, steps = [] }) {
  const rows = sources.map(s => {
    const step = steps.find(x => x.num === s.num);
    return `- #${s.num} at \`${s.headSha.slice(0, 12)}\`${step?.resolved?.length ? ` (Also-raised-by union on ${step.resolved.length} file(s))` : ''}`;
  });
  return [
    `Combines ${sources.length} approved card-only PRs that edit the same card file(s) into one branch on main \`${base.slice(0, 12)}\`, so they land in one merge-queue cycle instead of ${sources.length} (card xym8nt4).`,
    '',
    '## Source PRs (applied in this order)',
    ...rows,
    '',
    '## Files',
    ...files.map(f => `- \`${f}\``),
    '',
    '## Safety',
    '- Built by the drain with `git merge-tree`; a conflict is resolved only by the card resolver (union of the "Also raised by" list). Anything else would have stopped the group.',
    '- Checked before push: the lines this PR adds over main are exactly the union of the lines the source PRs add; no source line is missing, no deleted line came back, no other file changed.',
    '- The source PRs stay open and are held by the drain. They are closed only after this PR merges and each one\'s lines are confirmed on main. If this PR is closed, fails CI, or is sent back, the group dissolves and every source PR lands on its own as before.',
    '- This PR still goes through review and every drain and merge-queue gate.',
    '',
    `<!-- ${CARD_GROUP_MARKER} id=${id} sources=${sources.map(s => `${s.num}@${s.headSha}`).join(',')} -->`,
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
}

export function readGroupState(path, readFile = readFileSync) {
  try {
    if (!existsSync(path)) return { groups: [], failed: {} };
    const data = JSON.parse(readFile(path, 'utf8'));
    if (!data || !Array.isArray(data.groups)) return { unreadable: true };
    // `lastReconcileAt` is per repository ({ [repo]: ms }): one drain's pass must never throttle another repo's.
    // A legacy single number has no owner, so it is dropped (each repo reconciles once more, then stamps its own).
    const stamps = data.lastReconcileAt && typeof data.lastReconcileAt === 'object' && !Array.isArray(data.lastReconcileAt) ? data.lastReconcileAt : {};
    return { groups: data.groups, failed: data.failed && typeof data.failed === 'object' ? data.failed : {}, lastReconcileAt: stamps };
  } catch { return { unreadable: true }; }
}

/**
 * PURE: the hold for one candidate, given the state. A source of any recorded group is held; an unreadable
 * state holds everything (we cannot prove the PR is not a source). The published main-red repair PR (`mainFix`,
 * set by the drain's own red-main gate) is never held: red main already holds the combined PR, so a group hold
 * on the repair would deadlock both. Reconcile dissolves the group the repair needs.
 */
export function cardGroupHold(state, { num, repo, localSlug, files = null, mainFix = false } = {}) {
  if (mainFix === true) return null;
  if (state?.unreadable) return { kind: 'card-grouped', reason: 'card-group state unreadable — holding (fail closed)' };
  const slug = repoIdentity(repo || localSlug);
  if (!slug) return { kind: 'card-grouped', reason: 'card-group repository identity missing — holding (fail closed)' };
  const paths = Array.isArray(files) ? files.map(f => (typeof f === 'string' ? f : f?.path)).filter(Boolean) : [];
  for (const g of state?.groups ?? []) {
    if (!sameRepo(g.repo, slug)) continue;
    if (Number(g.pr) === Number(num)) continue; // the combined PR itself lands normally
    const where = g.pr ? `#${g.pr}` : `pending card group ${g.id}`;
    if (g.sources?.some(s => Number(s.num) === Number(num)))
      return { kind: 'card-grouped', reason: `grouped into ${where} (lands with it; drain.group)` };
    // An open group RESERVES its card files: no other PR touching them may land first (it would make the
    // combined PR conflict). Unknown file lists cannot be judged here; the group then dissolves on conflict.
    const shared = paths.filter(p => (g.files ?? []).includes(p));
    if (shared.length) return { kind: 'card-grouped', reason: `${shared[0]} is reserved by open card group ${where} (drain.group)` };
  }
  return null;
}

/**
 * PURE: is PR `num` a source, or THE combined PR (number AND recorded branch), of a group recorded in readable
 * state? This is an EXEMPTION (from rebase/repair and the conflict watch), so it needs proof: unreadable state,
 * a branch name alone, or a dissolved group (record removed) never exempts.
 */
export function inCardGroup(state, { num, repo, localSlug, headRef = null } = {}) {
  if (!state || state.unreadable || !Number.isInteger(Number(num))) return false;
  const slug = repoIdentity(repo || localSlug);
  return (state.groups ?? []).some(g => sameRepo(g.repo, slug)
    && ((g.pr != null && Number(g.pr) === Number(num) && headRef != null && headRef === g.branch)
      || g.sources?.some(s => Number(s.num) === Number(num))));
}

/** IO: the same membership, read from THE shared state path. No state path / no file / unreadable → false. */
export function readInCardGroup({ num, repo, localSlug, headRef = null, env = process.env } = {}) {
  const path = resolveCardGroupStatePath(env);
  if (!path || !existsSync(path)) return false;
  return inCardGroup(readGroupState(path), { num, repo, localSlug, headRef });
}

/**
 * IO: the shared state exists but cannot be read, so membership is UNKNOWN. A caller whose wrong guess would act on
 * a group member (the conflict watch's send-back) holds on this; a missing file or no state path is not unknown.
 */
export function readCardGroupStateUnreadable({ env = process.env } = {}) {
  const path = resolveCardGroupStatePath(env);
  return !!path && existsSync(path) && readGroupState(path).unreadable === true;
}

/** PURE: a queue read blocks a group when any entry is a source, shares a group file, or has an unknown file list. */
export function queueBlocksGroup(queue, { sources, files }) {
  if (!queue || queue.error || !Array.isArray(queue.entries)) return `merge queue unreadable (${queue?.error ?? 'no result'})`;
  const nums = new Set(sources.map(s => Number(s.num)));
  for (const e of queue.entries) {
    if (nums.has(Number(e.num))) return `#${e.num} is already in the merge queue`;
    if (e.files === null || !Array.isArray(e.files)) return `queued #${e.num} has an unknown file list`;
    const hit = e.files.find(f => files.includes(f));
    if (hit) return `queued #${e.num} still shares ${hit} — waiting until it clears`;
  }
  return null;
}

/**
 * The drain's card grouping. `exec` runs gh (execFileSync shape), `run` runs git (gitRun shape) in `cwd`
 * (a clone of the local repo). `prestage(c, headSha)` is the strategy's read-only admission check.
 */
/**
 * PURE: this pass's grouping inputs — the enqueue outcomes, every planner deferral whose ONLY wait is an
 * overlap-yield, and the PR each such deferral yields to. Those deferrals (planLabelDrain's `deferred`) never reach
 * the enqueue loop, so they are absent from the enqueue outcomes; the PR they yield to is READY, and would be
 * queued ahead of the group (blocking it) unless it can join. A yield target is marked `yieldTarget`: form() takes
 * it only when it is itself a merge-decided local candidate (the planner's yield is always within one repository).
 * A deferral that also waits on a blocker, a couple or an incomplete context is not a candidate.
 */
export function cardGroupCandidates({ enqueueOutcomes = [], deferred = [] } = {}) {
  const overlapOnly = d => Array.isArray(d?.waitOn) && d.waitOn.length > 0 && d.waitOn.every(w => String(w).startsWith('overlap-yield:'));
  const waits = (Array.isArray(deferred) ? deferred : []).filter(overlapOnly);
  const repoOf = d => d.repo ?? d.overlapYield?.repo ?? null;
  const deferrals = waits.map(d => ({ num: Number(d.num), repo: repoOf(d), outcome: 'deferred', kind: 'overlap-yield', reason: d.waitOn.join(', ') }));
  // PR numbers are repository-local: a target is keyed (and matched against the waits) by repo and number.
  const key = (repo, num) => `${repoIdentity(repo)}#${num}`;
  const targets = new Map();
  for (const d of waits) {
    const pr = Number(d.overlapYield?.pr);
    if (!Number.isInteger(pr) || targets.has(key(repoOf(d), pr)) || waits.some(x => key(repoOf(x), Number(x.num)) === key(repoOf(d), pr))) continue;
    targets.set(key(repoOf(d), pr), { num: pr, repo: repoOf(d), outcome: 'yield-target', kind: 'overlap-yield', reason: `yielded to by #${d.num}`, yieldTarget: true });
  }
  return [...(Array.isArray(enqueueOutcomes) ? enqueueOutcomes : []), ...deferrals, ...targets.values()];
}

/**
 * The drain's grouping step, run once per whole pass BEFORE the cascade. Every whole pass reconciles recorded
 * groups whatever the delivery strategy: a group formed under the merge queue must still release its holds after a
 * switch to direct merging. A new group forms only while the local repo merges through the queue; the cascade's
 * hold then keeps every source (the yield target included) out of the queue this same pass. While main is red the
 * pass's published repair PRs (`mainFixNums`, from the live red-main signal) go to reconcile, which dissolves any group
 * they need, and no new group forms (only the repair may land). Never throws.
 */
export function runCardGroupPass({ grouping, onlyPr = null, enqueues = false, enqueueOutcomes = [], deferred = [], verdicts = [], mainFixNums = [], isLocalRepo = r => !r, log = process.stderr } = {}) {
  if (onlyPr != null) return { reconciled: null, grouping: null };
  // `mainFixNums`: the live signal's local repair PRs, whatever their decision this pass (one that still needs a
  // rebase is `skip`, and must dissolve its group all the same). Files come from the pass listing when complete.
  const list = Array.isArray(verdicts) ? verdicts : [];
  const mainFixPrs = [...new Set((Array.isArray(mainFixNums) ? mainFixNums : []).map(Number).filter(n => Number.isInteger(n) && n > 0))].map(num => {
    const v = list.find(x => isLocalRepo(x?.repo) && Number(x?.num) === num);
    return { num, repo: null, files: v?.listedFilesComplete === true ? v.listedFiles : null };
  });
  const reconciled = grouping.reconcile({ mainFixPrs });
  if (!enqueues) return { reconciled, grouping: null };
  if (mainFixPrs.length) return { reconciled, grouping: { reason: `main is red — only the repair PR(s) ${mainFixPrs.map(f => `#${f.num}`).join(', ')} land; no group forms` } };
  const result = grouping.form({ outcomes: cardGroupCandidates({ enqueueOutcomes, deferred }), verdicts });
  if (result?.reason && !/^(disabled|[01] card-only overlap deferral)/.test(result.reason)) log.write(`  card-group: no group this pass — ${result.reason}\n`);
  return { reconciled, grouping: result };
}

export function createCardGrouping({
  localSlug, cwd = process.cwd(), exec = execFileSync, run = gitRun, env = process.env, log = process.stderr,
  statePath = resolveCardGroupStatePath(env), settings, dryRun = false, now = () => Date.now(), prestage = null,
  readFile = readFileSync, quiet = false,
  // The drain's land-write mutex (`(fn) => ({ran, result})`, the one every enqueue runs inside) and a live
  // merge-queue membership read (`() => ({inQueue:Set, error?})`). Group creation is claimed inside that mutex,
  // after proving no source is queued, so an enqueue can never pass its hold check and then race the claim.
  withLock = null, readQueue = null, readQueueFiles = null,
  cardConflictSettings = null,
  // Is `c` a published main-red repair PR per this pass's LIVE red-main signal? Never read from a candidate field
  // (a cached candidate would carry it past the red window). Such a PR is neither held nor treated as a member.
  isMainFix = () => false,
} = {}) {
  const say = line => { if (!quiet) log.write(`  card-group: ${line}\n`); };
  const isLocalGroup = g => sameRepo(g.repo, localSlug);
  const isLocalGroupId = (g, id) => isLocalGroup(g) && g.id === id;
  let setting = settings;
  if (!setting) setting = readCardGroupSettings({ env, log: line => log.write(`  ${line}\n`) });
  if (!statePath) setting = { ...setting, enabled: false, sources: { ...(setting.sources ?? {}), enabled: 'no state path (test run)' } };
  const conflictSetting = () => {
    try {
      const r = cardConflictSettings ?? loadCardConflictSettings({ env });
      return { enabled: r?.value?.autoResolveRaisedBy === true, source: r?.sources?.autoResolveRaisedBy ?? 'standard' };
    } catch (e) { return { enabled: false, source: `unreadable (${firstLine(e)})` }; }
  };
  const gh = (args, opts = {}) => String(exec('gh', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], ...opts }));
  const lockPath = `${statePath}.lock`;
  const mutate = fn => {
    try { mkdirSync(dirname(statePath), { recursive: true }); } catch { /* the lock open reports a real failure */ }
    return withFileLock(lockPath, () => {
      const st = readGroupState(statePath, readFile);
      if (st.unreadable) return { ok: false, reason: 'state unreadable' };
      const result = fn(st);
      writeJsonAtomic(statePath, { groups: st.groups, failed: st.failed, lastReconcileAt: st.lastReconcileAt ?? {} });
      return { ok: true, result };
    });
  };
  const readPr = num => JSON.parse(gh(['pr', 'view', String(num), '--repo', localSlug, '--json', 'number,state,isDraft,headRefOid,headRefName,baseRefName,labels,statusCheckRollup,mergedAt,mergeable']));
  const comment = (num, body) => { try { gh(['pr', 'comment', String(num), '--repo', localSlug, '--body', body]); return true; } catch (e) { say(`comment on #${num} failed (${firstLine(e)})`); return false; } };
  const liveEligible = (pr, headSha) => {
    const names = labelNames(pr?.labels);
    if (pr?.state !== 'OPEN') return 'not open';
    if (pr.isDraft) return 'draft';
    if (pr.headRefOid !== headSha) return 'head moved';
    if ((pr.baseRefName || 'main') !== 'main') return 'base is not main';
    if (!names.includes('ready-to-merge')) return 'no ready-to-merge';
    if (!names.includes('review:accepted')) return 'not review:accepted';
    const hold = ['review:changes', 'review:human', 'review:pending'].find(l => names.includes(l));
    if (hold) return `holds ${hold}`;
    if (String(pr.headRefName || '').startsWith(CARD_GROUP_BRANCH_PREFIX)) return 'is a combined PR';
    return null;
  };
  const mainSha = () => {
    const r = run('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd });
    const sha = String(r.stdout ?? '').split(/\s/)[0];
    return r.status === 0 && SHA.test(sha) ? sha : null;
  };
  // Only the LATEST run of the required check counts: a superseded failure (a cancelled run, then a green or still
  // queued rerun) must never close a currently green combined PR. The shared per-name collapse is the one reading
  // of "latest" (a queued or running rerun is the newest; CheckRun outranks a status context).
  const requiredFailed = pr => {
    const latest = collapseRollupToLatestPerName(pr?.statusCheckRollup).find(c => c?.name === 'test' || c?.context === 'test');
    return !!latest && ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(String(latest.conclusion || latest.state || '').toUpperCase());
  };

  const api = {
    setting,
    /** Hold for one candidate (sync). */
    holdFor(c) {
      if (!statePath || !existsSync(statePath)) return null;
      return cardGroupHold(readGroupState(statePath, readFile), { num: c?.num, repo: c?.repo, localSlug,
        files: c?.listedFilesComplete === true ? c.listedFiles : null, mainFix: isMainFix(c) === true });
    },
    /**
     * A source or combined PR of a recorded group: the drain's own rebase/repair must not move its head. The
     * published main-red repair PR is not exempted from rebase/repair: it must become landable (its group dissolves).
     */
    inGroup(c) {
      if (isMainFix(c) === true) return false;
      if (!statePath || !existsSync(statePath)) return false;
      return inCardGroup(readGroupState(statePath, readFile), { num: c?.num, repo: c?.repo, localSlug, headRef: c?.headRef });
    },

    /**
     * Re-read active groups (throttled by reconcileSec). Never throws. `mainFixPrs` ([{num, repo?, files}]) are the
     * pass's published main-red repair PRs: a group one of them is a source of, or whose reserved card it touches,
     * is dissolved at once (red main holds the combined PR, so the group could only block the repair).
     */
    reconcile({ force = false, mainFixPrs = [] } = {}) {
      try {
        if (!repoIdentity(localSlug)) return { checked: 0, reason: 'repository identity missing' };
        if (!statePath || !existsSync(statePath)) return { checked: 0 };
        const st = readGroupState(statePath, readFile);
        if (st.unreadable) { say('state unreadable — sources stay held; fix or remove the file'); return { checked: 0 }; }
        // PR numbers and group IDs are repository-local, even when coordination state is shared.
        const groups = st.groups.filter(isLocalGroup);
        if (!groups.length) return { checked: 0 };
        const fixes = (Array.isArray(mainFixPrs) ? mainFixPrs : [])
          .filter(f => Number.isInteger(Number(f?.num)) && Number(f.num) > 0 && (!f.repo || sameRepo(f.repo, localSlug)));
        const repairNeeds = g => {
          for (const f of fixes) {
            if (Number(f.num) === Number(g.pr)) continue; // the combined PR itself is never blocked by its group
            if (g.sources?.some(s => Number(s.num) === Number(f.num))) return `published main-red repair PR #${f.num} is a source`;
            const paths = (Array.isArray(f.files) ? f.files : []).map(p => (typeof p === 'string' ? p : p?.path)).filter(Boolean);
            const shared = paths.find(p => (g.files ?? []).includes(p));
            if (shared) return `published main-red repair PR #${f.num} needs reserved ${shared}`;
          }
          return null;
        };
        const stampKey = repoIdentity(localSlug);
        // A stamp that is not a past time (corrupt file, clock stepped back) must not throttle forever.
        const stamp = Number(st.lastReconcileAt?.[stampKey] ?? 0);
        const fresh = Number.isFinite(stamp) && stamp <= now() && now() - stamp < setting.reconcileSec * 1000;
        if (!force && fresh && !groups.some(repairNeeds)) return { checked: 0, throttled: true };
        if (dryRun) return { checked: 0, dryRun: true };
        mutate(s => { s.lastReconcileAt = { ...s.lastReconcileAt, [stampKey]: now() }; });
        const done = [], dissolved = [];
        for (const g of groups) {
          const tag = `group ${g.id}${g.pr ? ` (#${g.pr})` : ''}`;
          if (!g.pr) {
            // Opening interrupted: adopt the PR if one exists for the branch, else drop the record after 15 min.
            let found = null;
            try { found = JSON.parse(gh(['pr', 'list', '--repo', localSlug, '--head', g.branch, '--state', 'all', '--json', 'number,state']))[0] ?? null; } catch { continue; }
            if (found) { mutate(s => { const x = s.groups.find(y => isLocalGroupId(y, g.id)); if (x) x.pr = found.number; }); say(`${tag}: adopted #${found.number}`); }
            else if (now() - (g.createdAt ?? 0) > 15 * 60_000) {
              // Re-check under the lock: the forming pass may have recorded its PR since this snapshot was read.
              const dropped = mutate(s => {
                const x = s.groups.find(y => isLocalGroupId(y, g.id));
                if (!x || x.pr || x.createdAt !== g.createdAt) return false;
                s.groups = s.groups.filter(y => !isLocalGroupId(y, g.id)); s.failed[sourceSetKey(g.sources)] = now();
                return true;
              });
              if (dropped?.ok && dropped.result === true) { say(`${tag}: no PR was opened — record dropped, sources released`); dissolved.push(g.id); }
            }
            continue;
          }
          let pr;
          try { pr = readPr(g.pr); } catch (e) { say(`${tag}: read failed (${firstLine(e)}) — sources stay held`); continue; }
          if (pr.state === 'MERGED') {
            const base = mainSha();
            const fetched = base && ensureCommits({ shas: [base], cwd, run });
            if (!base || !fetched?.ok) { say(`${tag}: merged, but main unreadable — retried`); continue; }
            const refs = readReferenceMap({ base, cwd, run });
            let retry = false;
            for (const recorded of g.sources) {
              // Re-read the source NOW: only its CURRENT head's lines on main may close it.
              let sp;
              try { sp = readPr(recorded.num); } catch (e) { say(`${tag}: source #${recorded.num} re-read failed (${firstLine(e)}) — retried`); retry = true; break; }
              if (sp.state !== 'OPEN') { say(`${tag}: source #${recorded.num} is ${sp.state} — nothing to close`); continue; }
              const s = { num: recorded.num, headSha: sp.headRefOid };
              const have = SHA.test(s.headSha ?? '') ? ensureCommits({ shas: [s.headSha], cwd, run }) : { ok: false, reason: 'no head' };
              const landed = !have.ok ? { ok: false, reason: `current head unreadable (${have.reason})` }
                : refs.ok ? sourceLanded({ ref: base, source: s, cwd, run, referenceMap: refs.map }) : { ok: false, reason: refs.reason };
              if (s.headSha !== recorded.headSha) say(`${tag}: source #${s.num} head moved ${recorded.headSha.slice(0, 10)} → ${String(s.headSha).slice(0, 10)}; checking the current head`);
              if (landed.ok) {
                try {
                  gh(['pr', 'close', String(s.num), '--repo', localSlug, '--comment',
                    `Landed on main through the combined card PR #${g.pr} (merged). Every line this PR adds is on main, so it is closed. Its approval record is unchanged. (drain.group, card xym8nt4)`]);
                  say(`${tag}: closed source #${s.num} — landed via #${g.pr}`);
                } catch (e) { say(`${tag}: close #${s.num} failed (${firstLine(e)}) — it is released and lands or no-ops on its own`); }
              } else {
                comment(s.num, `The combined card PR #${g.pr} merged, but this PR's lines were not all found on main (${landed.reason}). It stays open and is released back to the normal drain path. (drain.group, card xym8nt4)`);
                say(`${tag}: source #${s.num} NOT closed (${landed.reason}) — released`);
              }
            }
            if (retry) continue;
            mutate(s => { s.groups = s.groups.filter(y => !isLocalGroupId(y, g.id)); });
            done.push(g.id);
            continue;
          }
          let why = repairNeeds(g);
          if (why) { /* the repair outranks the group */ }
          else if (pr.state === 'CLOSED') why = 'combined PR closed without merging';
          else if (labelNames(pr.labels).some(l => l === 'review:changes' || l === 'review:human')) why = `combined PR sent back (${labelNames(pr.labels).filter(l => l === 'review:changes' || l === 'review:human').join(', ')})`;
          else if (requiredFailed(pr)) why = 'combined PR failed the required check';
          else if (String(pr.mergeable || '').toUpperCase() === 'CONFLICTING') why = 'combined PR conflicts with main';
          else {
            for (const s of g.sources) {
              let sp;
              try { sp = readPr(s.num); } catch (e) { why = null; say(`${tag}: source #${s.num} read failed (${firstLine(e)}) — held`); break; }
              const bad = liveEligible(sp, s.headSha);
              if (bad) { why = `source #${s.num} changed (${bad})`; break; }
            }
          }
          if (!why) continue;
          if (pr.state === 'OPEN') {
            try { gh(['pr', 'close', String(g.pr), '--repo', localSlug, '--comment', `Card group dissolved: ${why}. Every source PR returns to the normal drain path with its approval unchanged. (drain.group, card xym8nt4)`]); }
            catch (e) { say(`${tag}: closing combined PR failed (${firstLine(e)}) — sources stay held, retried`); continue; }
          }
          for (const s of g.sources) comment(s.num, `Card group #${g.pr} dissolved (${why}). This PR goes back to the normal drain path. (drain.group, card xym8nt4)`);
          // Memo the dissolved source set, so form() does not rebuild the same group for retryMin (a known dissolve
          // cause would otherwise re-form, re-comment and re-open every pass). A moved source head is a new set.
          mutate(s => { s.groups = s.groups.filter(y => !isLocalGroupId(y, g.id)); s.failed[sourceSetKey(g.sources)] = now(); });
          say(`${tag}: dissolved — ${why}`);
          dissolved.push(g.id);
        }
        return { checked: groups.length, done, dissolved };
      } catch (e) { say(`reconcile error (${firstLine(e)}) — sources stay held`); return { error: firstLine(e) }; }
    },

    /**
     * Form at most one new group from this pass's deferrals. `outcomes` = enqueueOutcomes, `verdicts` = the pass
     * candidates (for labels / listed head). Returns { formed?, plan?, reason }.
     */
    form({ outcomes = [], verdicts = [] } = {}) {
      if (!setting.enabled) return { reason: 'disabled' };
      if (!statePath) return { reason: 'no state path' };
      if (!repoIdentity(localSlug)) return { reason: 'repository identity missing' };
      try {
        const st = existsSync(statePath) ? readGroupState(statePath, readFile) : { groups: [], failed: {} };
        if (st.unreadable) return { reason: 'state unreadable' };
        const grouped = new Set(st.groups.filter(isLocalGroup).flatMap(g => g.sources.map(s => Number(s.num))));
        const local = r => !r || sameRepo(r, localSlug);
        // Both overlap waits qualify: a queue-file-overlap deferral (its reason must name only card files) and an
        // overlap-yield hold (its reason names no files). Either way the git card-only check below decides.
        const waiting = o => (o.kind === 'queue-file-overlap' && overlapReasonIsCardOnly(o.reason)) || o.kind === 'overlap-yield';
        const deferred = [...new Map(outcomes.filter(o => waiting(o) && local(o.repo) && !grouped.has(Number(o.num))).map(o => [Number(o.num), o])).values()];
        if (deferred.length < 2) return { reason: `${deferred.length} card-only overlap deferral(s)` };
        const base = mainSha();
        if (!base) return { reason: 'main unreadable' };
        const cands = [];
        for (const o of deferred) {
          const v = verdicts.find(x => Number(x.num) === Number(o.num) && local(x.repo));
          const headSha = v?.listedHeadSha || v?.headSha;
          if (!SHA.test(headSha ?? '')) continue;
          // A planner-sourced candidate (a deferral or the PR it yields to) comes from the pass-start plan; it joins only
          // while its verdict still says it would land now (not since held, not pre-staged with required CI pending).
          if ((o.outcome === 'deferred' || o.yieldTarget) && (v.decision !== 'merge' || v.prestagePendingCi)) continue;
          const names = labelNames(v.prLabels);
          if (!names.includes('ready-to-merge') || !names.includes('review:accepted')) continue;
          if (v.item || v.couple || v.coupleKey) continue; // a PR that resolves an item or is half a couple stays serial
          cands.push({ num: Number(o.num), headSha, repo: v.repo });
        }
        if (cands.length < 2) return { reason: 'fewer than 2 accepted card candidates' };
        const fetched = ensureCommits({ shas: [base, ...cands.map(c => c.headSha)], cwd, run });
        if (!fetched.ok) return { reason: fetched.reason };
        const withFiles = [];
        for (const c of cands) {
          const sf = sourceFiles({ base, headSha: c.headSha, cwd, run });
          if (!sf || !cardOnlyFiles(sf.files)) continue;
          // Formation runs before the cascade's hold: a PR touching a card an open group reserves stays out.
          const held = cardGroupHold(st, { num: c.num, repo: c.repo, localSlug, files: sf.files });
          if (held) { say(`#${c.num} left out (${held.reason})`); continue; }
          withFiles.push({ ...c, files: sf.files });
        }
        let plans = planCardGroups({ candidates: withFiles, maxSize: setting.maxSize })
          .filter(p => !(st.failed?.[sourceSetKey(p.sources)] > now() - setting.retryMin * 60_000));
        if (!plans.length) return { reason: 'no group of 2+ sharing a card (or every set is in retry backoff)' };
        const plan = plans[0];
        // Live re-check of every member right before building (labels, head, draft, red-team admission).
        const live = [];
        for (const s of plan.sources) {
          let pr;
          try { pr = readPr(s.num); } catch (e) { say(`#${s.num} live read failed (${firstLine(e)}) — left out`); continue; }
          const bad = liveEligible(pr, s.headSha);
          if (bad) { say(`#${s.num} left out (${bad})`); continue; }
          if (typeof prestage === 'function') {
            const adm = prestage({ num: s.num, repo: null, baseRefName: 'main' }, s.headSha);
            if (!adm?.allowed) { say(`#${s.num} left out (admission: ${adm?.reason || 'refused'})`); continue; }
          } else { say(`#${s.num} left out (no admission check wired — fail closed)`); continue; }
          live.push(s);
        }
        plans = planCardGroups({ candidates: live, maxSize: setting.maxSize });
        if (!plans.length) {
          // Memo the planned set so a pass storm does not re-read every member each pass.
          if (!dryRun) mutate(s => { s.failed[sourceSetKey(plan.sources)] = now(); });
          return { reason: 'live re-check left fewer than 2 sharing a card' };
        }
        const refs = readReferenceMap({ base, cwd, run });
        if (!refs.ok) return { reason: refs.reason };
        const cc = conflictSetting();
        const failAll = (sources, reason) => {
          say(`group of ${sources.map(s => `#${s.num}`).join(',')} not formed: ${reason} — they stay serial (${formatCardGroupSetting(setting)})`);
          if (!dryRun) mutate(s => { s.failed[sourceSetKey(sources)] = now(); for (const [k, at] of Object.entries(s.failed)) if (at < now() - 24 * 3600_000) delete s.failed[k]; });
          return { reason };
        };
        // Build + prove; a source the build or the proof can pin a failure on is left OUT (it stays serial) and
        // the rest are re-planned. Anything not attributable to one source refuses the whole group.
        let p = plans[0];
        if (refs.ambiguous?.size) {
          const clear = [];
          for (const x of p.sources) {
            const mb = String(run('git', ['merge-base', base, x.headSha], { cwd }).stdout ?? '').trim();
            const d = SHA.test(mb) ? run('git', ['diff', '--no-color', mb, x.headSha], { cwd }) : { status: 1 };
            const hit = d.status !== 0 ? 'diff unreadable' : [...refs.ambiguous].find(h => String(d.stdout).includes(h));
            if (hit) say(`#${x.num} left out of the group (${d.status !== 0 ? hit : `mentions ambiguous JIT reference ${hit}`}) — it stays serial`);
            else clear.push(x);
          }
          const next = planCardGroups({ candidates: clear, maxSize: setting.maxSize })[0];
          if (!next) return { reason: 'fewer than 2 sources clear of ambiguous JIT references' };
          p = next;
        }
        const original = p.sources;
        // Wait (no failure memo) while a queued PR shares a group card: building on main now would conflict
        // the moment it lands.
        if (typeof readQueueFiles !== 'function') return { reason: 'no queue file read wired — fail closed' };
        const waitWhy = queueBlocksGroup(readQueueFiles(), { sources: p.sources, files: p.files });
        if (waitWhy) { say(`group of ${p.sources.map(x => `#${x.num}`).join(',')} waits: ${waitWhy}`); return { reason: waitWhy, waiting: true }; }
        const leftOut = [];
        let built, proof, id;
        for (;;) {
          // The memo is written for the set that actually formed (or failed); a trimmed or re-planned set must be
          // checked too, or a dissolved {A,B} would be rebuilt every pass from the wider plan {A,B,C}.
          if (st.failed?.[sourceSetKey(p.sources)] > now() - setting.retryMin * 60_000)
            return { reason: `group of ${p.sources.map(x => `#${x.num}`).join(',')} is in retry backoff (dissolved or failed recently)` };
          id = groupId(p.sources);
          const msg = s => `card-group ${id}: apply #${s.num} (${s.headSha.slice(0, 12)})\n\nPost-approval card grouping (drain.group, card xym8nt4).\n\n${CARD_GROUP_TRAILER}\n`;
          built = buildCombined({ base, sources: p.sources, cwd, run, env, resolveEnabled: cc.enabled, referenceMap: refs.map, message: msg });
          let offenders = [];
          let why;
          if (!built.ok) {
            why = `${built.reason} (cardConflicts.autoResolveRaisedBy=${cc.enabled} (${cc.source}))`;
            const m = /^#(\d+):/.exec(built.reason);
            if (m && !/autoResolveRaisedBy disabled/.test(built.reason)) offenders = p.sources.filter(x => x.num === Number(m[1]));
          } else {
            try { proof = verifyUnion({ base, combined: built.commit, sources: p.sources, cwd, run, referenceMap: refs.map }); }
            catch (e) { return failAll(original, `union check error (${firstLine(e)})`); }
            if (proof.ok) break;
            why = `union check failed (missing ${proof.missing.length}, extra ${proof.extra.length}, unexpected deletions ${proof.deleted.length}, resurrected ${proof.resurrected.length}, disagree ${proof.disagree.length}, order ${proof.order.length}, outside ${proof.outside.join(',') || 0}, unsupported ${proof.unsupported.join(',') || 0})`;
            offenders = p.sources.filter(x => !sourceLanded({ ref: built.commit, source: x, cwd, run, referenceMap: refs.map }).ok);
            if (proof.extra.length || proof.deleted.length || proof.outside.length || proof.order.some(o => o.source === 'base')) offenders = [];
          }
          if (!offenders.length || offenders.length === p.sources.length) return failAll(original, why);
          for (const o of offenders) { leftOut.push(o.num); say(`#${o.num} left out of the group (${why}) — it stays serial`); }
          const next = planCardGroups({ candidates: p.sources.filter(x => !offenders.includes(x)), maxSize: setting.maxSize })[0];
          if (!next) return failAll(original, `${why}; fewer than 2 left after leaving out ${offenders.map(o => `#${o.num}`).join(',')}`);
          p = next;
        }
        const summary = `#${p.sources.map(s => s.num).join(' #')} on ${p.files.length} card file(s) → ${built.commit.slice(0, 12)}; union check ok (${proof.perFile.map(f => `${f.path.split('/').pop().slice(0, 24)} +${f.combinedAdded}/${f.sourceAdded}`).join(', ')})`;
        if (dryRun) { say(`DRY RUN would open: ${summary}`); return { plan: p, built, proof, dryRun: true }; }
        const branch = `${CARD_GROUP_BRANCH_PREFIX}${id}`;
        const record = { id, repo: localSlug, branch, pr: null, base, commit: built.commit, createdAt: now(),
          sources: p.sources.map(s => ({ num: s.num, headSha: s.headSha })), files: p.files };
        if (typeof withLock !== 'function' || typeof readQueueFiles !== 'function') return { reason: 'no land mutex / queue read wired — fail closed' };
        // Inside the land mutex every enqueue runs in: prove no source is queued and every source is still at
        // its judged head, then record the group. From here on every enqueue (it re-reads the hold inside the
        // same mutex) sees the group.
        const lock = withLock(() => {
          const blocked = queueBlocksGroup(readQueueFiles(), { sources: record.sources, files: record.files });
          if (blocked) return { ok: false, reason: blocked };
          for (const x of record.sources) {
            let pr;
            try { pr = readPr(x.num); } catch (e) { return { ok: false, reason: `#${x.num} re-read failed (${firstLine(e)})` }; }
            const bad = liveEligible(pr, x.headSha);
            if (bad) return { ok: false, reason: `#${x.num} ${bad}` };
          }
          // A concurrent pass may have claimed a group meanwhile. Two open groups on one card would each hold the
          // other's combined PR for good (cardGroupHold), so a card an open group reserves refuses the claim too; it
          // is released when that group dissolves or lands. An open group with no file list cannot be judged: refuse.
          const claimed = mutate(s => {
            const open = s.groups.filter(isLocalGroup);
            const taken = new Set(open.flatMap(g => g.sources.map(y => Number(y.num))));
            if (record.sources.some(y => taken.has(y.num))) return 'a source joined another group meanwhile';
            for (const g of open) {
              const where = g.pr ? `#${g.pr}` : g.id;
              if (!Array.isArray(g.files)) return `open card group ${where} has no file list (fail closed)`;
              const hit = record.files.find(f => g.files.includes(f));
              if (hit) return `${hit} is reserved by open card group ${where} — waiting until it clears`;
            }
            s.groups.push(record);
            return true;
          });
          if (!claimed?.ok) return { ok: false, reason: `card-group state ${claimed?.reason ?? 'update failed'}` };
          if (claimed.result !== true) return { ok: false, reason: claimed.result };
          return { ok: true };
        });
        if (lock?.ran === false) return { reason: 'land mutex held — retried next pass' };
        if (!lock?.result?.ok) return { reason: `claim refused: ${lock?.result?.reason ?? 'unknown'}` };
        const remote = run('git', ['ls-remote', 'origin', `refs/heads/${branch}`], { cwd });
        const existing = String(remote.stdout ?? '').split(/\s/)[0];
        if (remote.status !== 0 || (existing && existing !== built.commit)) {
          mutate(s => { s.groups = s.groups.filter(g => !isLocalGroupId(g, id)); });
          return failAll(p.sources, existing ? `branch ${branch} already exists at another commit` : 'ls-remote failed');
        }
        if (!existing) {
          const push = run('git', ['push', 'origin', `${built.commit}:refs/heads/${branch}`], { cwd, env });
          if (push.status !== 0) { mutate(s => { s.groups = s.groups.filter(g => !isLocalGroupId(g, id)); }); return failAll(p.sources, `push failed (${String(push.stderr ?? '').split('\n')[0]})`); }
        }
        const title = `card group: ${p.sources.length} approved card PRs on ${p.files.map(f => f.split('/').pop().split('-')[0]).join(', ')}`;
        let num = null;
        try {
          const url = gh(['pr', 'create', '--repo', localSlug, '--base', 'main', '--head', branch, '--title', title.slice(0, 200),
            '--body', combinedPrBody({ id, sources: p.sources, files: p.files, base, steps: built.steps }), '--label', 'ready-to-merge', '--label', 'review:pending']).trim();
          num = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
        } catch (e) { say(`PR create for ${branch} failed (${firstLine(e)}) — the next reconcile adopts or drops it`); return { reason: 'pr create failed' }; }
        if (!Number.isInteger(num)) return { reason: 'pr create returned no number' };
        const kept = mutate(s => { const x = s.groups.find(g => isLocalGroupId(g, id)); if (x) x.pr = num; return !!x; });
        if (kept?.ok && kept.result === false) {
          // Opening outlived the reconcile's 15-minute drop: the record (and its card reservation) is gone and the
          // sources were released, so an untracked combined PR could land beside them or beside a newer group.
          try { gh(['pr', 'close', String(num), '--repo', localSlug, '--comment', 'Card group record was dropped while this PR was being opened; its sources land on their own. (drain.group, card xym8nt4)']); }
          catch (e) {
            // Never leave it untracked: re-record it (when nothing claimed its sources or cards meanwhile) so the
            // reconcile owns it from here — it dissolves it, or lands it like any group.
            const back = mutate(s => {
              const open = s.groups.filter(isLocalGroup);
              if (open.some(g => g.sources.some(y => record.sources.some(z => Number(y.num) === z.num)) || !Array.isArray(g.files) || g.files.some(f => record.files.includes(f)))) return false;
              s.groups.push({ ...record, pr: num, createdAt: now() });
              return true;
            });
            say(`close of untracked combined PR #${num} failed (${firstLine(e)}) — ${back?.result === true ? 're-recorded for the reconcile' : 'left open untracked'}`);
          }
          return { reason: `group record dropped while opening — combined PR #${num} closed` };
        }
        for (const s of p.sources) comment(s.num, `Grouped with ${p.sources.filter(x => x.num !== s.num).map(x => `#${x.num}`).join(', ')} into the combined card PR #${num} (they all edit ${p.files.map(f => `\`${f}\``).join(', ')}). This PR stays open and is held by the drain; it is closed only after #${num} merges and its lines are confirmed on main. If #${num} closes, fails, or is sent back, this PR goes back to landing on its own. (drain.group, card xym8nt4)`);
        say(`opened #${num}: ${summary} — ${formatCardGroupSetting(setting)}`);
        return { formed: { id, pr: num, branch, sources: record.sources }, proof };
      } catch (e) { say(`form error (${firstLine(e)}) — no group`); return { reason: firstLine(e) }; }
    },
  };
  return api;
}
