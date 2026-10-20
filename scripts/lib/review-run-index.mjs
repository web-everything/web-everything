/**
 * Indexed scan of `review-pr-*` run records for one repo/PR/head.
 *
 * Why: the drain's red-team evidence read and the saved-result provenance check each parsed EVERY review-pr run
 * (6.4k files, 1.5 GB, measured 2026-10-19) on every call, ~4.7 s per scan, several scans per candidate per pass.
 * That made the merge cascade take 10-28 minutes for 1-5 PRs.
 *
 * What it keeps: a small in-process index from each file's stat identity (dev, inode, size, mtime, ctime in ns) to
 * the four fields the callers match on. It fails closed:
 *   - a file may be skipped (served from the index) only when its mtime AND ctime are older than the settle window
 *     (`redTeam.reviewRunIndexSettleMin`, standard 10) and its stat identity is unchanged; anything newer is read;
 *   - after the scan every skipped file is stat-ed again, and any whose identity changed is read and re-judged,
 *     so a rewrite during the scan is never missed;
 *   - any stat failure means the file is read through `readRun`, so a corrupt or vanished record throws exactly as
 *     the full scan did. Nothing is ever skipped on an error.
 * Matching files are always read fresh, and hits come back in `listRunIds` order. The match is case-insensitive,
 * a superset of each caller's own predicate; callers still apply their exact checks to the fresh record.
 */
import { statSync } from 'node:fs';
import { listRunIds, readRun, runPath } from '../operations/run-store.mjs';
import { cascadePolicy, formatCascadeSourcesLine, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

const index = new Map();
const MAX_ENTRIES = 50_000;
const sigOf = st => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
const keyOf = run => (run?.op === 'review-pr' && typeof run.input?.repo === 'string'
  ? { repo: run.input.repo.toLowerCase(), pr: Number(run.input?.pr), rev: String(run.findings?.read?.netBasis?.rev ?? '').toLowerCase() }
  : null);

/** Cascade setting `redTeam.reviewRunIndexSettleMin` (env WE_REVIEW_RUN_INDEX_SETTLE_MIN). */
export function readReviewRunIndexSetting({ env = process.env, tool, platform, log } = {}) {
  const raw = env.WE_REVIEW_RUN_INDEX_SETTLE_MIN;
  const pick = o => o?.reviewRunIndexSettleMin === undefined ? {} : { reviewRunIndexSettleMin: o.reviewRunIndexSettleMin };
  const r = cascadePolicy('redTeam', pick(tool ?? readSettings().redTeam), {
    env, platform: pick(platform ?? platformPreference('redTeam', { env })), standard: { reviewRunIndexSettleMin: 10 },
    valid: v => typeof v === 'number' && Number.isFinite(v) && v > 0,
    envValues: { reviewRunIndexSettleMin: raw === undefined || raw.trim() === '' ? undefined : Number(raw) },
  });
  if (log) log(formatCascadeSourcesLine('redTeam', r));
  return r;
}
// The drain logs the resolved value and its source once per pass (merge-ai-prs); this reader stays silent.
const settleMsDefault = () => readReviewRunIndexSetting().value.reviewRunIndexSettleMin * 60_000;

/** @returns {{ id: string, run: object }[]} review-pr runs that may match, each freshly read. Throws as `readRun` does. */
export function readMatchingReviewRuns({ runsDir, repo, pr, head, list = listRunIds, read = readRun, stat = statSync,
  now = Date.now, settleMs } = {}) {
  const want = { repo: String(repo ?? '').toLowerCase(), pr: Number(pr), rev: String(head ?? '').toLowerCase() };
  const matches = key => !!key && key.repo === want.repo && key.pr === want.pr && key.rev === want.rev;
  const window = settleMs ?? settleMsDefault();
  const statSig = id => {
    const st = stat(runPath(id, runsDir), { bigint: true });
    const settled = Number(st.mtimeMs) < now() - window && Number(st.ctimeMs) < now() - window;
    return { sig: sigOf(st), settled };
  };
  const remember = (id, sig, key) => {
    if (index.size >= MAX_ENTRIES) index.delete(index.keys().next().value);
    index.set(`${runsDir}\0${id}`, { sig, key });
  };
  // Read fresh; index only when the file was settled and unchanged across the read.
  const readAndIndex = (id, before) => {
    const run = read(id, runsDir); // a corrupt or vanished record throws here, as the full scan did
    const key = keyOf(run);
    if (before?.settled) {
      let after = null;
      try { after = statSig(id); } catch { /* not indexed: next scan reads it again */ }
      if (after && after.settled && after.sig === before.sig) remember(id, before.sig, key);
    }
    return { run, key };
  };
  const ids = list(runsDir).filter(id => id.startsWith('review-pr-'));
  const slots = new Array(ids.length).fill(null);
  const skipped = [];
  ids.forEach((id, i) => {
    let s = null;
    try { s = statSig(id); } catch { /* read below reports it */ }
    const cached = s?.settled ? index.get(`${runsDir}\0${id}`) : null;
    if (cached && cached.sig === s.sig) {
      if (matches(cached.key)) slots[i] = { id, run: read(id, runsDir) };
      else skipped.push({ i, id, sig: s.sig });
      return;
    }
    const { run, key } = readAndIndex(id, s);
    if (matches(key)) slots[i] = { id, run };
  });
  // Re-check every skipped file after the scan: a change during the scan is read and re-judged, never missed.
  for (const { i, id, sig } of skipped) {
    let s = null;
    try { s = statSig(id); } catch { /* read below reports it */ }
    if (s && s.settled && s.sig === sig) continue;
    const { run, key } = readAndIndex(id, s);
    if (matches(key)) slots[i] = { id, run };
  }
  return slots.filter(Boolean);
}
