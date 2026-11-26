/** Stable branch name from a persisted referral run and finding fingerprint. PURE. */
export function rulingBranch(key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}:[a-f0-9]{64}$/.test(key))
    throw new Error('missing or invalid persisted rulingKey; re-prepare from the referral run ID and finding fingerprint');
  return `lane/card-ruling-${key.replace(':', '-')}`;
}
