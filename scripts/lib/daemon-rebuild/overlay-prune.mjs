/** Post-plan observations only. Loss decisions belong exclusively to the rebuild planner. */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { overlayFilePath, registrationIdentity, appendOverlayEvent } from '../daemon-overlays.mjs';
import { cascadePolicy } from '../policy-cascade.mjs';
import { runGhSync } from '../gh-throttle.mjs';
import { feedPath, publishAttention } from '../../operations/needs-you-feed.mjs';
import { pinnedStatus } from './plan.mjs';
import { verifyRev, FULL_SHA_RE } from './shared.mjs';

const settingsPath = join(dirname(fileURLToPath(import.meta.url)), '../daemon-rebuild-settings.json');
const sidecar = (root, env) => `${overlayFilePath(root, env)}.stale-state`;
export function overlayStaleSettings(env = process.env) {
  let tool;
  try { tool = JSON.parse(readFileSync(settingsPath, 'utf8')).overlayStale; } catch { /* defaults */ }
  return cascadePolicy('overlayStale', tool, { env, standard: { enabled: true, threshold: 2 },
    envValues: { enabled: env.WE_OVERLAY_STALE === undefined ? undefined : env.WE_OVERLAY_STALE !== '0' },
    valid: { enabled: v => typeof v === 'boolean', threshold: v => Number.isInteger(v) && v >= 0 },
  }).value;
}
function readState(root, env) {
  try {
    const state = JSON.parse(readFileSync(sidecar(root, env), 'utf8'));
    if (!state.current || !state.records || !Array.isArray(state.rows)) throw new Error('invalid stale sidecar');
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { current: {}, records: {}, rows: [] };
  }
}
/** Inspect the last detector output without probing, publishing or advancing counters. */
export function readOverlayStale(root, env = process.env) { return readState(root, env).rows; }

/** One bounded read; a truncated or failed listing is unknown, never an empty open-PR set. */
export function readOpenPrHeads(root, env, query = runGhSync) {
  try {
    const rows = JSON.parse(query(['pr', 'list', '--state=open', '--limit=1000', '--json=headRefName,headRefOid,isCrossRepository'],
      { cwd: root, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }));
    return Array.isArray(rows) && rows.length < 1000
      && rows.every(r => typeof r.headRefName === 'string' && FULL_SHA_RE.test(r.headRefOid)) ? rows : null;
  } catch { return null; }
}
function notify(root, env, row) {
  const kind = row.reason === 'conflict' ? 'overlay-stale-conflict' : `overlay-stale-${row.reason}`;
  appendOverlayEvent(root, { kind, ...row }, { env });
  if (row.reason !== 'superseded') publishAttention({ repo: 'web-everything', pr: 0,
    head: `${row.ref}@${row.tip ?? 'unknown'}#${row.registration ?? ''}`, ref: row.ref, kind, title: `Overlay ${row.ref}`, reason: row.reason, ...row,
  }, { path: feedPath({ env }) });
}
/** Unknown inputs retain the registration and request operator inspection. No loss inference lives here. */
export function detectOverlayStale({ root, env = process.env, overlays, plan, mainSha, git,
  openPrHeads, remoteTips, settings = overlayStaleSettings(env), emit = row => notify(root, env, row),
}) {
  if (!settings.enabled) return [];
  const state = readState(root, env), rows = [], skipped = new Set();
  if (!overlays.length) return [];
  let heads = openPrHeads;
  const probe = args => { try { return git(args)?.status; } catch { return null; } };
  for (const overlay of overlays) {
    const { ref } = overlay;
    let tip = null;
    try { tip = remoteTips === undefined ? verifyRev(git, `refs/remotes/origin/${ref}^{commit}`) : remoteTips[ref]; } catch { /* unknown */ }
    if (!FULL_SHA_RE.test(tip)) tip = null;
    const key = JSON.stringify([ref, tip, registrationIdentity(overlay)]);
    const prior = state.records[key] ?? { count: 0, notified: false };
    const record = { ...prior, count: state.current[ref] === key ? prior.count : 0 };
    state.current[ref] = key;
    state.records[key] = record;
    const excluded = overlay.pr > 0 || overlay.pinned || overlay.edgeResolution
      || plan.applied?.some(a => a.ref === ref && a.pinnedFrom)
      || plan.decisions?.some(d => d.ref === ref && /pinned/.test(d.reason ?? ''))
      || plan.alerts?.some(a => a.detail?.ref === ref && /pinned/.test(a.kind));
    if (excluded) { record.count = 0; skipped.add(ref); continue; }
    if (heads === undefined) heads = readOpenPrHeads(root, env);
    // A fork PR reusing the branch name is not this origin branch's PR.
    if (heads?.some(h => h.headRefName === ref && h.isCrossRepository !== true)) { record.count = 0; skipped.add(ref); continue; }
    let reason = null;
    if (!tip || !FULL_SHA_RE.test(mainSha) || !Array.isArray(heads)) reason = 'unknown';
    if (!reason) {
      let pin;
      try { pin = pinnedStatus(git, overlay, mainSha, tip); } catch { pin = { why: 'unknown' }; }
      if (pin.why === 'unknown') reason = 'unknown';
      else if (pin.pinned) { record.count = 0; skipped.add(ref); continue; }
    }
    if (!reason) {
      // A pinned carrier's sha is what the plan actually carries; pinnedFrom is the rejected fetched tip.
      const carriers = [...(plan.applied ?? []).filter(a => a.ref !== ref && overlays.some(o => o.ref === a.ref)),
        ...heads.filter(h => h.headRefName !== ref && !overlays.some(o => o.ref === h.headRefName)).map(h => ({ sha: h.headRefOid }))];
      let unknown = false;
      for (const carrier of carriers) {
        const status = FULL_SHA_RE.test(carrier.sha) ? probe(['merge-base', '--is-ancestor', tip, carrier.sha]) : null;
        if (status === 0) { reason = 'superseded'; break; }
        if (status !== 1) unknown = true;
      }
      if (!reason && unknown) reason = 'unknown';
    }
    if (!reason) {
      let merge;
      try { merge = git(['merge-tree', '--write-tree', mainSha, tip]); } catch { /* unknown */ }
      if (!FULL_SHA_RE.test(String(merge?.stdout ?? '').split('\n')[0]) || ![0, 1].includes(merge?.status)) reason = 'unknown';
      else if (merge.status === 1) reason = 'conflict';
    }
    record.count = reason === 'conflict' ? record.count + 1 : 0;
    const row = { ref, tip, registration: createHash('sha256').update(key).digest('hex').slice(0, 12), count: record.count, reason: reason ?? 'clean',
      ownerAction: reason === 'superseded' ? `daemon-overlay.mjs remove ${ref}` : `rebase ${ref} onto main` };
    rows.push(row);
    if (reason && (reason !== 'conflict' || record.count > settings.threshold) && !(record.seen ??= {})[reason]) {
      // One notice per (ref, tip, registration, reason): a transient `unknown` never suppresses a later conflict.
      record.seen[reason] = true;
      (record.pending ??= {})[reason] = row;
    }
  }
  state.rows = rows;
  const live = new Set(overlays.map(o => o.ref));
  for (const ref of Object.keys(state.current)) if (!live.has(ref)) delete state.current[ref];
  const file = sidecar(root, env), tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  // Clear a pending notice only after delivery succeeds: a failed publish retries next tick (never lost).
  for (const [key, record] of Object.entries(state.records)) {
    for (const [why, notice] of Object.entries(record.pending ?? {})) {
      // Recheck tip, registration and pin: an obsolete notice is dropped, never delivered.
      if (state.current[notice.ref] !== key || skipped.has(notice.ref) || !live.has(notice.ref)
        || rows.find(r => r.ref === notice.ref)?.reason !== why) { delete record.pending[why]; continue; }
      try { emit(notice); delete record.pending[why]; } catch { /* retried next tick */ }
    }
  }
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
  return rows;
}
