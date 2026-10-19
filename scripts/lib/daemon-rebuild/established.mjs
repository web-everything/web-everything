/** Fail closed: only complete adoption metadata and negative ancestry probes prove a newcomer. */
export function isEstablished({ git, headSha, state, overlay, overlays = [], establishedRefs = new Set() } = {}) {
  try {
    const adopted = state?.adopted;
    if (typeof adopted?.head !== 'string' || !adopted.head.trim() || !Array.isArray(adopted.applied)
      || !adopted.applied.every((entry) => typeof entry?.ref === 'string' && entry.ref.trim())) return true;
    if (!overlay?.ref || !headSha) return true;

    // A refresh renames intent, not its establishment. Resolve the whole connected lineage,
    // in either direction and independently of registry order (including retired names).
    const entries = overlays.includes(overlay) ? overlays : [...overlays, overlay];
    const names = new Set([overlay.ref]);
    let changed;
    do {
      changed = false;
      for (const entry of entries) {
        const family = [entry.ref, ...(entry.refreshedFrom ?? [])];
        if (!family.some((ref) => names.has(ref))) continue;
        for (const ref of family) {
          if (!names.has(ref)) { names.add(ref); changed = true; }
        }
      }
    } while (changed);
    if ([...names].some((ref) => establishedRefs.has(ref)
      || adopted.applied.some((entry) => entry?.ref === ref))) return true;

    const resolve = (rev) => {
      const probe = git(['rev-parse', '--verify', '--end-of-options', rev]);
      return (!probe.error && probe.status === 0 && String(probe.stdout ?? '').trim()) || null;
    };
    const head = resolve(`${headSha}^{commit}`);
    if (!head) return true;
    const ancestorOrUnknown = (sha) => {
      const probe = git(['merge-base', '--is-ancestor', sha, head]);
      return !!probe.error || probe.status !== 1;
    };
    for (const entry of entries) {
      if (names.has(entry.ref) && entry.pinnedSha !== undefined && ancestorOrUnknown(entry.pinnedSha)) return true;
    }
    for (const ref of names) {
      const tip = resolve(`refs/remotes/origin/${ref}^{commit}`);
      if (!tip || ancestorOrUnknown(tip)) return true;
    }
    return false;
  } catch {
    return true;
  }
}
