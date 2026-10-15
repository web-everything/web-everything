const HEX = /^[0-9a-f]{40}$/;

/** PURE: durable provenance, never an approval marker in its own right. */
export function buildVerdictCarriedMarker({ fromSha, toSha, patchId }) {
  if (![fromSha, toSha, patchId].every(v => typeof v === 'string' && HEX.test(v))) throw Error('carry marker requires three 40-hex values');
  return `<!-- review-verdict-carried from=${fromSha} to=${toSha} patch-id=${patchId} -->`;
}
export function parseVerdictCarriedMarker(body) {
  const m = /<!-- review-verdict-carried from=([0-9a-f]{40}) to=([0-9a-f]{40}) patch-id=([0-9a-f]{40}) -->/.exec(String(body ?? ''));
  return m ? { fromSha: m[1], toSha: m[2], patchId: m[3] } : null;
}
