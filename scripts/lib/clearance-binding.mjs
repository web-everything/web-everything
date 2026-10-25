/** Pure head binding shared by review and enqueue readers without loading their operation graphs. */
export function clearanceBindsHead({ humanClearedSha = null, headSha = null, coverage = null } = {}) {
  const head = typeof headSha === 'string' ? headSha.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{7,40}$/.test(head)) return false;
  if (typeof humanClearedSha === 'string' && humanClearedSha.trim().toLowerCase() === head) return true;
  return !!(coverage && coverage.covers === true && /^[0-9a-f]{40}$/.test(head)
    && typeof coverage.liveHead === 'string' && coverage.liveHead.toLowerCase() === head);
}
