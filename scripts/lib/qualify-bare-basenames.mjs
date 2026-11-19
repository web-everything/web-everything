/** Pure path qualification shared by held-card producers and filing. */
const BARE_FILE = /(?<![\w./:~@-])([\w][\w.-]*\.(?:mjs|cjs|js|ts|json|md|css|html|yml|yaml))(?![\w/-])/g;

/** A bare basename matching exactly ONE tracked file becomes `we:<path>`; zero or several matches stay bare
 *  (the scrub then refuses them) and the several-match candidates are returned so the caller can list them. */
export function qualifyBareBasenames(text, trackedFiles) {
  const byBase = new Map();
  for (const file of trackedFiles) {
    const base = file.slice(file.lastIndexOf('/') + 1);
    byBase.set(base, [...(byBase.get(base) ?? []), file]);
  }
  const ambiguous = {};
  const out = text.replace(BARE_FILE, (match, name) => {
    const found = byBase.get(name) ?? [];
    if (found.length === 1) return `we:${found[0]}`;
    if (found.length > 1) ambiguous[name] = found;
    return match;
  });
  return { text: out, ambiguous };
}
