/**
 * Shared establishment evidence. `classify` preserves unknown; boolean callers fail closed.
 * HOLD guards use the whole lineage and adoption metadata. Planner ordering uses only the
 * current tip: an adopted branch whose tip moved is still protected, but its new tip is new.
 */
export function isEstablished({ git, headSha, state, overlay, overlays = [], establishedRefs = new Set(), evidence = 'lineage', classify = false } = {}) {
  const result = (status) => classify ? status : status !== 'not-established';
  try {
    const resolve = (rev) => {
      const probe = git(['rev-parse', '--verify', '--end-of-options', rev]);
      return (!probe.error && probe.status === 0 && String(probe.stdout ?? '').trim()) || null;
    };
    const ancestry = (sha, head) => {
      const probe = git(['merge-base', '--is-ancestor', sha, head]);
      if (probe.error) return 'unknown';
      return probe.status === 0 ? 'established' : probe.status === 1 ? 'not-established' : 'unknown';
    };
    if (evidence === 'tip') {
      if (!overlay?.ref || !headSha) return result('unknown');
      // A published refresh is a rename of protected intent, not an ordinary branch
      // advancing its tip. Carry affirmative lineage evidence into the planner too.
      const renamed = overlay.refreshedFrom?.length || overlays.some((entry) =>
        (entry.ref === overlay.ref && entry.refreshedFrom?.length)
        || entry.refreshedFrom?.includes(overlay.ref));
      if (renamed && isEstablished({ git, headSha, state, overlay, overlays, establishedRefs,
        classify: true }) === 'established') return result('established');
      const head = resolve(`${headSha}^{commit}`);
      const tip = resolve(`refs/remotes/origin/${overlay.ref}^{commit}`);
      return result(head && tip ? ancestry(tip, head) : 'unknown');
    }
    const adopted = state?.adopted;
    if (typeof adopted?.head !== 'string' || !adopted.head.trim() || !Array.isArray(adopted.applied)
      || !adopted.applied.every((entry) => typeof entry?.ref === 'string' && entry.ref.trim())) return result('unknown');
    if (!overlay?.ref || !headSha) return result('unknown');

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
      || adopted.applied.some((entry) => entry?.ref === ref))) return result('established');

    const head = resolve(`${headSha}^{commit}`);
    if (!head) return result('unknown');
    let unknown = false;
    const probe = (sha) => {
      const status = ancestry(sha, head);
      if (status === 'unknown') unknown = true;
      return status === 'established';
    };
    for (const entry of entries) {
      if (names.has(entry.ref) && entry.pinnedSha !== undefined && probe(entry.pinnedSha)) return result('established');
    }
    for (const ref of names) {
      const tip = resolve(`refs/remotes/origin/${ref}^{commit}`);
      if (!tip) unknown = true;
      else if (probe(tip)) return result('established');
    }
    return result(unknown ? 'unknown' : 'not-established');
  } catch {
    return result('unknown');
  }
}
