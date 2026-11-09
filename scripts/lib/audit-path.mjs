/**
 * Strict grammar for a file path an audit reports (PR #6381 redesign). Pure: no I/O, no settings, no repo root.
 *
 *   report = TRIM( ("+++ " | "--- ")? ( Q PATH Q | PATH ) LOC? )
 *   PATH   = [A-Za-z0-9._/-]+          (every tracked file name is in this set)
 *   LOC    = :N | :N-M | :N:C | #LN | #LN-LN
 *
 * `canonicalPaths(file)` returns the repo-relative forms the report names, or `null` when the report is not exactly
 * that shape. `null` means PROTECTED: a caller must treat it as matching every protected glob. Anything the grammar
 * does not list (prose, non-ASCII, escapes, `+`, `@`, backslash, an absolute path, `..` above the root, an empty path)
 * is refused rather than decoded, so no decoding can ever reduce what is protected.
 */
export const MAX_AUDIT_PATH = 512;
/** Most candidates one report may yield; more cannot be matched at bounded cost and fail closed (protected). */
export const MAX_AUDIT_CANDIDATES = 32;
const GRAMMAR = /^(?:(?:\+\+\+|---) )?(?:(["'`])([A-Za-z0-9._/-]+)\1|([A-Za-z0-9._/-]+))(:\d+(?:-\d+|:\d+)?|#L\d+(?:-L\d+)?)?$/;

/** Collapses `.` and empty segments; null for an empty path, a rooted one, or one holding a `..` segment. */
function normalise(path) {
  if (path.startsWith('/')) return null;
  const parts = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * `anchors` (optional, lower-case): the first folder of each protected glob (`scripts` of `scripts/**`). EVERY form
 * the report yields (as written, side-prefix stripped, line suffix stripped, joined, ...) also yields each trailing
 * sub-path that starts at an anchor, as the old matcher did, so `repo/scripts/x.mjs:42` still reaches `scripts/x.mjs`.
 * Without anchors only the path itself is read.
 *
 * A PATH that ends in punctuation (`.` `-` `_` `/`) or holds a `..` segment is refused: no tracked name does either, and
 * the old matcher's trimmed and joined readings of such a name are not worth chasing one by one.
 */
export function canonicalPaths(file, anchors = null) {
  if (typeof file !== 'string' || file.length > MAX_AUDIT_PATH) return null;
  const text = file.replace(/^ +| +$/g, '');
  // A leading `word:` reads as a URL scheme (`file:x`, or a top-level `x.mjs:42`): refused, as the old matcher did.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return null;
  const m = GRAMMAR.exec(text);
  if (!m) return null;
  const path = m[2] ?? m[3];
  if (/[._/-]$/.test(path)) return null;
  const first = normalise(path);
  if (first === null) return null;
  const out = new Set([first]);
  // A git diff side prefix (`a/ b/ c/ i/ w/ o/`) may be a real folder, so the path is read both with and without it.
  if (/^[abciwo]\//.test(path)) { const c = normalise(path.slice(2)); if (c !== null) out.add(c); }
  // A leading run of `-`, `_` or `.` is a bullet or a hidden-folder dot in prose (`-docs/a.md`): the trimmed name too.
  for (const f of [...out]) {
    const t = f.replace(/^[-_.]+/, '');
    const c = t !== f ? normalise(t) : null;
    if (c !== null) out.add(c);
  }
  // The old matcher also matched the report as written, with every non-path character removed (`custom/x.mjs:42` read
  // as `custom/x.mjs42`), and the line-suffix pieces; kept, so nothing it protected is lost.
  for (const c of [normalise(text), normalise(text.replace(/[^A-Za-z0-9._/-]/g, ''))]) if (c !== null) out.add(c);
  const loc = (m[4] ?? '').slice(1);
  if (loc) for (const d of [loc, ...loc.split(':'), ...(loc.match(/\d+/g) ?? [])]) out.add(d);
  if (anchors && anchors.size) {
    for (const c of [...out]) {
      const segs = c.split('/');
      for (let i = 1; i < segs.length; i++) {
        if (!anchors.has(segs[i].toLowerCase())) continue;
        const sub = normalise(segs.slice(i).join('/'));
        if (sub !== null) out.add(sub);
      }
    }
  }
  return out.size > MAX_AUDIT_CANDIDATES ? null : [...out];
}
