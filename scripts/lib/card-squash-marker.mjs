/** Drain-recorded net-patch proof. Subjects alone are never provenance. */
import { createHash } from 'node:crypto';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

const prefix = '🔁 conveyor — card squash proof';
const fields = /^old=([a-f0-9]{40}) new=([a-f0-9]{40}) patch=([a-f0-9]{64})$/;
export const patchWithoutPositions = text => String(text).split('\n').filter(line => !/^(?:index |@@)/.test(line)).join('\n');
export const squashPatchHash = text => createHash('sha256').update(patchWithoutPositions(text)).digest('hex');
export function formatCardSquashMarker({ oldHead, newHead, patchHash }) {
  const line = `old=${oldHead} new=${newHead} patch=${patchHash}`;
  if (!fields.test(line)) throw new Error('invalid card squash proof');
  return `${prefix}\n\n${line}`;
}
export function parseCardSquashMarkers(comments) {
  return (Array.isArray(comments) ? comments : []).flatMap(c => {
    if (!isTrustedMarkerAuthor(c) || typeof c.body !== 'string') return [];
    const lines = c.body.trimStart().split('\n');
    if (lines[0] !== prefix) return [];
    const match = fields.exec(lines.slice(1).join('\n').trim());
    return match ? [{ oldHead: match[1], newHead: match[2], patchHash: match[3] }] : [];
  });
}
/** Called only with the successful push result. Failed reads/posts leave the round spent. */
export function postCardSquashMarker({ result, comments, readComments, postComment }) {
  if (result?.action !== 'rebased' || !result.proof) return false;
  try {
    const existing = readComments ? readComments() : comments;
    if (parseCardSquashMarkers(existing).some(m => m.newHead === result.proof.newHead)) return false;
    postComment(formatCardSquashMarker(result.proof));
    return true;
  } catch { return false; }
}
