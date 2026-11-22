/** D18 total recovery table. Branch facts own authority; manifest state records intent only. */
import { states } from './manifest.mjs';

export function reconcile(row, F1, F2, F3) {
  const action = (action, reason, severity) => ({ action, reason, ...(severity ? { severity } : {}) });
  if (!row || !states.includes(row.state) || !['same', 'changed', 'stub', 'absent'].includes(F1)
      || !['absent', 'destDigest', 'other'].includes(F2) || typeof F3 !== 'boolean')
    return action('stop', 'Unreadable or unknown evidence; stop batch and inspect branch facts');
  if (row.state === 'quarantined') return action('quarantine', row.quarantineReason || 'Quarantined; only a new manifest releases this row');
  if (F2 === 'other') return action('quarantine', 'Destination has another digest; stop batch and inspect');
  if (F2 === 'absent' && ['stub', 'absent'].includes(F1)) return action('quarantine', 'Card lost; stop batch and restore from sourceSha', 'high');
  if (F3) return action('quarantine', 'Destination id taken; stop batch; S2 renumbering needs a new manifest');
  if (F2 === 'destDigest') {
    if (F1 === 'changed') return action('quarantine', 'Source changed after snapshot and destination cutover; stop batch');
    return F1 === 'stub' ? action('done', 'Stub and destination verified')
      : action('reconcile-links', 'Destination owns the card; mark cutover then reconcile WE stub and inbound links');
  }
  if (F1 === 'changed') return action('snapshot-again', 'Source owns card; snapshot again before cutover');
  return action('copy', 'Source owns card; build and verify destination bytes for cutover PR');
}
