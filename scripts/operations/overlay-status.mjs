import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
export const OVERLAY_STATUS_FOOTER = 'covered registrations may be retirable; removal stays a manual operator step via daemon-overlay.mjs remove';
export function assessOverlayStatus(snapshot) {
  return { clones: snapshot.clones.map((clone) => {
    const rows = clone.registrations.map((r) => ({ ...r, adopted: !!r.tipSha && r.adopted === true,
      onMain: !!r.tipSha && r.onMain === true, containedBy: null, covered: false }));
    const eligible = (r) => !!r.tipSha && r.fresh === true && r.adopted === true;
    for (const r of rows) {
      r.containedBy = rows.find((o) => o !== r && eligible(o) && r.containers.includes(o.ref))?.ref ?? null;
      // Tip coverage is informational, not proof that recorded contributions can be removed.
      r.covered = eligible(r) && (r.onMain || !!r.containedBy);
    }
    return { ...clone, registrations: rows };
  }) };
}
export function overlayStatusOperation({ collect } = {}) {
  return op('overlay-status', {
    input: { clone: { type: 'string', required: false } },
    verdictFrom: 'assess',
    read: compute({ reads: ['input.clone'], fn: ({ input }) => collect({ clone: input.clone }) }),
    assess: compute({ reads: ['findings.read'], fn: ({ findings }) => assessOverlayStatus(findings.read) }),
  });
}
const yesNo = (value) => value == null ? '?' : value ? 'yes' : 'no';
const shortWhy = (why) => String(why).replace(/\s+/g, ' ').trim().slice(0, 120);
export function overlayStatusLines(verdict) {
  return verdict.clones.flatMap((c) => [
    `${c.clone} HEAD ${c.headSha || '?'} held=${yesNo(c.held)}${c.held && c.heldSince != null ? ` since ${c.heldSince}` : ''}${c.held && c.heldWhy != null ? ` why=${shortWhy(c.heldWhy)}` : ''} onLastGood=${yesNo(c.onLastGood)} building=${yesNo(c.building)}`,
    ...c.registrations.map((r) => `  ${r.ref} ${r.adopted ? 'ADOPTED' : 'not yet'} tip=${r.tipSha || '?'} recorded=${r.recordedSha || '?'} fresh=${yesNo(r.fresh)}${r.onMain ? ' on-main' : ''}${r.containedBy ? ` contained-by ${r.containedBy}` : ''}${r.pinned === true ? ' pinned' : ''}${r.covered ? ' covered' : ''}`),
  ]);
}
