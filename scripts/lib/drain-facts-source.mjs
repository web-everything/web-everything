/**
 * @file scripts/lib/drain-facts-source.mjs
 * @description Where the drain's pass-start PR reads come from: the webhook store (the pr-events Durable Object's
 *   facts, through we:scripts/lib/pr-facts.mjs) when it is fresh, else GitHub. Operator go 2026-10-09 16:35 ET.
 *
 * WHY: measured 2026-10-09, the drain's `listing` (~20 s) and `classifyGateReads` (~17 s) steps are mostly per-PR
 *   GitHub reads — the required check's direct REST read for every listed PR whose rollup is capped or missing it,
 *   plus labels/draft the shared snapshot serves up to 75 s old. The store already holds head SHA, draft, labels and
 *   COMPLETED checks per head, pushed by webhook.
 *
 * WHAT IT SERVES (classification reads only):
 *   - the required check's verdict on the listed head ({@link resolveRequiredCheckViaStore}), when the store holds a
 *     completed run of that check ON that head. No run in the store ⇒ GitHub (the store keeps completed runs only,
 *     so absence never means green);
 *   - labels and draft on a listing row whose head the store agrees with ({@link overlayListingRow}).
 *   NOT served, stays on GitHub: mergeability (the store has none), files, bodies, comments, in-progress checks.
 *
 * SAFETY: the merge write never trusts these reads. Right before each merge the drain re-reads the PR live
 *   (`fetchFreshPrForRevalidation`) and the merge-queue hook reads the check runs live; any label write re-reads
 *   live. So a stale store answer can only delay or skip a PR this pass, never land one. This is why the module, not
 *   merge-ai-prs.mjs, imports pr-facts (pinned by __tests__/pr-facts-merge-gate-isolation.test.mjs).
 *
 * SETTINGS (`drainFactsSource` in we:scripts/settings/drain-facts-source.json): `source: 'store-first' | 'github'`.
 *   Layers: built-in default (`store-first`) → the settings file → env `WE_DRAIN_FACTS_SOURCE` (tool override).
 *
 * EVIDENCE: every pass logs one `merge-ai-prs · facts-source: {...}` line ({@link formatFactsSourceLine}): per repo
 *   which source answered and why, and how many check reads the store served vs GitHub.
 */
import { readDeclaredSettings } from './settings-files.mjs';

export const DRAIN_FACTS_SOURCES = Object.freeze(['store-first', 'github']);
export const DRAIN_FACTS_DEFAULTS = Object.freeze({ source: 'store-first' });
export const DRAIN_FACTS_SOURCE_ENV = 'WE_DRAIN_FACTS_SOURCE';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The merged settings. Never throws; an unknown source falls back to `github` (today's reads) and is named. */
export function loadDrainFactsSettings({ file, env = process.env } = {}) {
  const errors = [];
  let src = file;
  if (src === undefined) {
    const read = readDeclaredSettings();
    src = read.settings;
    errors.push(...read.errors.map((e) => `${e.source}: ${e.error}`));
  }
  const s = { ...DRAIN_FACTS_DEFAULTS, ...(isObj(src?.drainFactsSource) ? src.drainFactsSource : {}) };
  const override = String(env?.[DRAIN_FACTS_SOURCE_ENV] ?? '').trim();
  if (override) s.source = override;
  if (!DRAIN_FACTS_SOURCES.includes(s.source)) {
    errors.push(`drainFactsSource: source must be one of ${DRAIN_FACTS_SOURCES.join(', ')} (got ${JSON.stringify(s.source)}); using github`);
    s.source = 'github';
  }
  return { ...s, errors };
}

/**
 * Read the store once per repo for this pass. Never throws.
 * @param {{repos: Array<string|null>, settings?: {source: string}, readRepoFacts?: Function}} a
 *   `readRepoFacts({repo, caller})` → `{asOfMs, prs: facts[]}` or null (pr-facts.mjs's contract)
 * @returns {Promise<Map<string, {source: 'store'|'github', reason: string, asOfMs: number|null, prs: Map<number, object>}>>}
 */
export async function readPassFacts({ repos, settings = DRAIN_FACTS_DEFAULTS, readRepoFacts }) {
  const out = new Map();
  const read = readRepoFacts ?? defaultReadRepoFacts;
  for (const repo of repos) {
    const key = repo ?? 'cwd';
    const github = (reason) => out.set(key, { source: 'github', reason, asOfMs: null, prs: new Map() });
    if (settings.source !== 'store-first') { github(`setting: ${settings.source}`); continue; }
    if (!repo) { github('no-repo-slug'); continue; }
    try {
      const r = await read({ repo, caller: 'merge-ai-prs.mjs' });
      if (!r || r.unavailable) { github(r?.unavailable || 'store-not-fresh'); continue; }
      out.set(key, { source: 'store', reason: 'served', asOfMs: r.asOfMs ?? null, prs: new Map((r.prs ?? []).map((f) => [Number(f.number), f])) });
    } catch (e) { github(`store-error: ${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`); }
  }
  return out;
}

/** pr-facts' `readRepoFacts`, plus WHY the store did not answer (`{unavailable: reason}`): disabled / not configured,
 *  feed-stale, ttl-expired, no-bootstrap… — the reason the per-pass line reports. */
async function defaultReadRepoFacts({ repo, caller }) {
  const pf = await import('./pr-facts.mjs');
  const { mirror, settings, reason } = await pf.loadMirror({ repo });
  if (!mirror) return { unavailable: reason || 'no-mirror' };
  const verdict = pf.judgeMirror(mirror, { nowMs: Date.now(), ...settings });
  if (!verdict.ok) return { unavailable: verdict.reason };
  return pf.readRepoFacts({ repo, caller });
}

/** The store's facts for one listed PR, only when they describe the SAME head the listing shows. PURE. */
export function factsForHead(repoFacts, pr) {
  if (repoFacts?.source !== 'store' || !pr?.headRefOid) return null;
  const f = repoFacts.prs.get(Number(pr.number));
  return f && f.headSha === pr.headRefOid ? f : null;
}

/**
 * PURE. The required check's evidence from the store as a `statusCheckRollup` CheckRun row, or null (→ GitHub).
 * Null when the store has no facts for this head, or no COMPLETED run of the check on it.
 */
export function storeCheckRow(repoFacts, pr, requiredCheck = 'test') {
  const f = factsForHead(repoFacts, pr);
  const c = f?.checks?.find((x) => x?.name === requiredCheck && x.conclusion);
  if (!c) return null;
  return { __typename: 'CheckRun', name: requiredCheck, status: 'COMPLETED', conclusion: String(c.conclusion).toUpperCase(), head_sha: pr.headRefOid, source: 'store' };
}

/**
 * The drop-in for the drain's `resolveChecks`: when the listing's rollup cannot answer (`needsDirectRead(pr)`, the
 * drain's own fast-path test), answer from the store before paying a GitHub REST read. `resolveLive(pr)` is the
 * drain's existing `resolveRequiredCheck`. `tally` counts which source answered.
 */
export async function resolveRequiredCheckViaStore(pr, { repoFacts, requiredCheck = 'test', needsDirectRead, resolveLive, tally = null }) {
  if (!needsDirectRead(pr)) return pr;
  const row = storeCheckRow(repoFacts, pr, requiredCheck);
  if (row) {
    if (tally) tally.checksFromStore += 1;
    const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
    const { requiredCheckReadError, ...rest } = pr; // eslint-disable-line no-unused-vars
    return { ...rest, statusCheckRollup: [...rollup.filter((r) => (r?.name || r?.context) !== requiredCheck || r?.__typename === 'StatusContext'), row] };
  }
  if (tally) tally.checksFromGithub += 1;
  return resolveLive(pr);
}

/**
 * PURE. A listing row with labels and draft taken from the store when the store agrees on the head (webhook-fresh,
 * where the shared snapshot may be up to its TTL old). A head mismatch leaves the row as listed and marks it.
 */
export function overlayListingRow(row, repoFacts) {
  if (repoFacts?.source !== 'store') return row;
  const f = repoFacts.prs.get(Number(row?.number));
  if (!f) return row;
  if (f.headSha !== row.headRefOid) return { ...row, factsHeadMismatch: true };
  return { ...row, labels: f.labels.map((name) => ({ name })), isDraft: !!f.draft, factsSource: 'store' };
}

/** A fresh per-pass counter for {@link resolveRequiredCheckViaStore}. */
export function createFactsTally() { return { checksFromStore: 0, checksFromGithub: 0 }; }

/** The per-pass evidence line (stderr survives the drain's --json). */
export function formatFactsSourceLine(byRepo, tally = createFactsTally()) {
  const repos = {};
  for (const [repo, r] of byRepo ?? []) repos[repo] = { source: r.source, reason: r.reason, prs: r.prs.size, ageMs: r.asOfMs == null ? null : Date.now() - r.asOfMs };
  const sources = new Set(Object.values(repos).map((r) => r.source));
  const source = sources.size === 1 ? [...sources][0] : sources.size ? 'mixed' : 'github';
  return `merge-ai-prs · facts-source: ${JSON.stringify({ source, repos, ...tally })}`;
}
