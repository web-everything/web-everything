const HEX = /^[0-9a-f]{40}$/;
const KINDS = new Set(['clean-main-merge', 'jit-rename']);

/** PURE: durable provenance, never an approval marker in its own right. */
export function buildVerdictCarriedMarker({ fromSha, toSha, patchId, commits }) {
  if (![fromSha, toSha].every(v => typeof v === 'string' && HEX.test(v))) throw Error('carry marker requires full head shas');
  if (commits !== undefined) {
    if (!Array.isArray(commits) || !commits.length || !commits.every(c => HEX.test(c.sha) && KINDS.has(c.kind))) throw Error('carry marker requires classified commits');
    return `<!-- review-verdict-carried from=${fromSha} to=${toSha} same-content=${commits.map(c => `${c.sha}:${c.kind}`).join(',')} -->`;
  }
  if (typeof patchId !== 'string' || !HEX.test(patchId)) throw Error('carry marker requires a patch id');
  return `<!-- review-verdict-carried from=${fromSha} to=${toSha} patch-id=${patchId} -->`;
}
export function parseVerdictCarriedMarker(body) {
  const text = String(body ?? '');
  const m = /<!-- review-verdict-carried from=([0-9a-f]{40}) to=([0-9a-f]{40}) patch-id=([0-9a-f]{40}) -->/.exec(text);
  if (m) return { fromSha: m[1], toSha: m[2], patchId: m[3] };
  const history = /<!-- review-verdict-carried from=([0-9a-f]{40}) to=([0-9a-f]{40}) same-content=([0-9a-f]{40}:(?:clean-main-merge|jit-rename)(?:,[0-9a-f]{40}:(?:clean-main-merge|jit-rename))*) -->/.exec(text);
  if (!history) return null;
  const commits = history[3].split(',').map(c => { const [sha, kind] = c.split(':'); return { sha, kind }; });
  if (!commits.every(c => HEX.test(c.sha) && KINDS.has(c.kind))) return null;
  return { fromSha: history[1], toSha: history[2], commits };
}
