/** Shared protection against dropping established overlays in a main-only rebuild. */
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { feedPath, publishAttention } from '../../operations/needs-you-feed.mjs';
import { alertsFilePath, writeRebuildState } from './state.mjs';
import { overlayFilePath, appendOverlayEvent } from '../daemon-overlays.mjs';
import { isEstablished } from './established.mjs';

const NEEDS_YOU_KINDS = new Set(['main-only-forced', 'overlay-refresh-failed', 'overlay-held-on-last-good']);

export function makeRebuildAlert({ root, stEnv, log, nowIso, alerts }) {
  return (kind, detail) => {
    alerts.push({ kind, detail });
    log?.error?.(`daemon-rebuild: ${kind}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
    try {
      const file = alertsFilePath(root, stEnv);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify({ at: nowIso(), kind, detail })}\n`, 'utf8');
    } catch { /* best-effort audit trail only */ }
    // Operator attention is a real feed write, independent of the health watch's shadow mode.
    // Do not swallow publication failures: a force must not proceed with only an audit log.
    if (NEEDS_YOU_KINDS.has(kind)) {
      const at = nowIso();
      const head = createHash('sha256').update(JSON.stringify([root, kind, detail,
        kind === 'main-only-forced' ? at : null])).digest('hex');
      publishAttention({
        repo: `daemon/${root}`, pr: 0, head, kind,
        reason: detail.reason ?? 'Established overlays held on last good build',
        title: `${kind === 'main-only-forced' ? `Forced main-only by ${detail.by}` : kind}: ${(detail.refs ?? [detail.ref]).join(', ')}`,
        ...detail,
      }, { path: feedPath({ env: stEnv }), now: Date.parse(at) });
    }
  };
}

export function guardMainOnly({ root, env, stEnv, state, overlayState, git, prevHead, mainOnly, mainOnlyForce, nowIso, alert }) {
  if (overlayState.corrupt) {
    alert('overlay-state-corrupt', { file: overlayFilePath(root, env) });
    if (!mainOnlyForce) return { moved: false, reason: 'overlay-state-corrupt' };
  }
  if (!mainOnly) return null;
  const refs = overlayState.overlays.filter((overlay) => isEstablished({
    state, overlays: overlayState.overlays, git, headSha: prevHead, overlay,
  })).map((o) => o.ref);
  if (mainOnlyForce) {
    const detail = { ...mainOnlyForce, refs: overlayState.corrupt ? ['unknown'] : refs };
    appendOverlayEvent(root, { kind: 'main-only-forced', ...detail }, { env });
    alert('main-only-forced', detail);
  } else if (refs.length) {
    state.held = { since: state.held?.since ?? nowIso(), reason: 'overlay-refresh-held',
      failed: `Overlay refresh held: ${refs.join(', ')}`, details: [], lastGood: prevHead,
      target: null, mainSha: null, updatedAt: nowIso() };
    writeRebuildState(root, state, stEnv);
    alert('overlay-held-on-last-good', { refs, files: [] });
    return { moved: false, reason: 'overlay-refresh-held' };
  }
  return null;
}
