/**
 * R883 slice 2 — the PR's OWN change between the prior reviewed head and the new head.
 *
 * A raw `prior..head` diff also contains every commit that came in from main (merges, rebases), which pushes most
 * later rounds past the delta cap. For each file in the raw range this compares the PR's own patch against the
 * merge-base with `base` at both heads; a file whose own patch is identical (content, mode, binary data and place in
 * the file, ignoring only absolute line numbers) was not changed by the PR and is dropped.
 * Pure: git is injected as `exec`. Fails closed: ANY unreadable input returns null so the caller keeps the raw range
 * (or a full review). Kept files keep their raw line data, so the result is only ever a subset of the raw range.
 */

const SHA = /^[0-9a-f]{4,64}$/i;
const REF = /^[A-Za-z0-9._/-]+$/;
const MAX = 64 * 1024 * 1024;

/**
 * Normalise a `git diff` for one path into a signature of the PR's own change. Only the parts that vary with what
 * main did are removed: the `diff --git` / `index` header lines (blob ids and paths) and the absolute line numbers
 * and function-context text of each `@@` header. Everything else is kept, so the signature still differs for a
 * binary change (`--binary` data), a mode change (`old/new/new file/deleted file mode`), an empty-file add, a moved
 * block (3 lines of context stay in) and a content line that merely looks like a header (`---old`). Anything that
 * is not recognised stays in the signature, which can only keep a file, never drop one.
 */
function signature(text) {
  const out = [];
  let inHeader = true;
  for (const l of text.split('\n')) {
    if (l.startsWith('@@')) { inHeader = false; out.push('@@'); continue; }
    if (inHeader) {
      if (l.startsWith('GIT binary patch') || l.startsWith('Binary files')) inHeader = false;
      else if (l.startsWith('diff --git ') || l.startsWith('index ')) continue;
    }
    out.push(l);
  }
  return out.join('\n');
}

/** One file's PR-own patch since the merge-base with `base`, as a position-independent signature. */
function ownPatch(exec, head, base, path) {
  const mb = String(exec('git', ['merge-base', head, base], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  if (!SHA.test(mb)) throw new Error('merge-base-unreadable');
  // --literal-pathspecs: `path` is data from the caller, never a glob or pathspec magic.
  const text = String(exec('git', ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', '--unified=3', mb, head, '--', path],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX }));
  return signature(text);
}

/**
 * @param {{exec: Function, priorHead: string, head: string, base: string, rawFiles: Record<string, number[]|null>}} o
 * @returns {{files: Record<string, number[]|null>, dropped: string[]}|null} null = cannot prove; use the raw range.
 */
export function netInterdiff({ exec, priorHead, head, base, rawFiles } = {}) {
  try {
    if (typeof exec !== 'function' || !SHA.test(priorHead ?? '') || !SHA.test(head ?? '')) return null;
    if (typeof base !== 'string' || !base || base.startsWith('-') || !REF.test(base)) return null;
    if (!rawFiles || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) return null;
    const files = {};
    const dropped = [];
    for (const [path, lines] of Object.entries(rawFiles)) {
      if (typeof path !== 'string' || !path || path.startsWith('-')) return null;
      if (ownPatch(exec, priorHead, base, path) === ownPatch(exec, head, base, path)) dropped.push(path);
      else files[path] = lines;
    }
    return { files, dropped };
  } catch {
    return null;
  }
}

/** One shadow log line comparing the raw range with the interdiff (null interdiff = fell back to raw). */
export function interdiffShadowLine({ pr, raw, net } = {}) {
  const rawCount = raw && typeof raw === 'object' ? Object.keys(raw).length : 0;
  const netCount = net?.files ? Object.keys(net.files).length : null;
  return `[net-interdiff] pr=${pr ?? '?'} raw=${rawCount} interdiff=${netCount ?? 'unavailable'}`;
}
