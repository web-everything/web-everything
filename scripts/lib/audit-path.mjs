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

/** Collapses `.`, empty and `..` segments; null for an empty path or one that climbs above the root. */
function normalise(path) {
  if (path.startsWith('/')) return null;
  const parts = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * `anchors` (optional, lower-case): the first folder of each protected glob (`scripts` of `scripts/**`). A report that
 * sits under a folder above the repo (`repo/scripts/x.mjs`) also yields each trailing sub-path that starts at an anchor,
 * as the old matcher did, so the nested form is never less protected. Without anchors only the path itself is read.
 */
export function canonicalPaths(file, anchors = null) {
  if (typeof file !== 'string' || file.length > MAX_AUDIT_PATH) return null;
  const text = file.replace(/^ +| +$/g, '');
  // A leading `word:` reads as a URL scheme (`file:x`, or a top-level `x.mjs:42`): refused, as the old matcher did.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return null;
  const m = GRAMMAR.exec(text);
  if (!m) return null;
  const path = m[2] ?? m[3];
  const out = new Set();
  // A git diff side prefix (`a/ b/ c/ i/ w/ o/`) may be a real folder, so the path is read both with and without it.
  const forms = [path];
  if (/^[abciwo]\//.test(path)) forms.push(path.slice(2));
  // Prose wraps a name in edge punctuation (a bullet `-docs/a.md`, a sentence-final `x.mjs.`, a hidden-folder dot),
  // so the name with its leading and trailing `-`, `_`, `.` and `/` runs trimmed is a candidate too. Extra candidates only
  // ever protect more; the first candidate is always the path exactly as reported.
  for (const f of [...forms]) {
    const t = f.replace(/^[-_./]+/, '').replace(/[-_./]+$/, '');
    if (t !== f) forms.push(t);
  }
  const first = normalise(forms[0]);
  if (first === null) return null;
  out.add(first);
  for (const f of forms.slice(1)) {
    const c = normalise(f);
    if (c !== null) out.add(c);
  }
  // Anchored sub-paths are cut from the report's own segments BEFORE `..` is resolved, as the old matcher did:
  // `repo/scripts/../guard-x.mjs` must still yield `scripts/../guard-x.mjs` -> `guard-x.mjs`.
  if (anchors && anchors.size) {
    for (const f of forms) {
      const segs = f.split('/').filter(x => x !== '' && x !== '.');
      for (let i = 1; i < segs.length; i++) {
        if (!anchors.has(segs[i].toLowerCase())) continue;
        const c = normalise(segs.slice(i).join('/'));
        if (c !== null) out.add(c);
      }
    }
  }
  // The old matcher also matched the report as written and the digits of its line suffix; kept, so nothing it
  // protected is lost. Both are extra candidates only: they can protect more, never less.
  const raw = normalise(text);
  if (raw !== null) out.add(raw);
  const loc = (m[4] ?? '').slice(1);
  if (loc) for (const d of [loc, ...loc.split(':'), ...(loc.match(/\d+/g) ?? [])]) out.add(d);
  return out.size > MAX_AUDIT_CANDIDATES ? null : [...out];
}
