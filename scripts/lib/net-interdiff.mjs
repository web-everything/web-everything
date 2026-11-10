/**
 * R883 slice 2 — the PR's OWN change between the prior reviewed head and the new head.
 *
 * A raw `prior..head` diff also contains every commit that came in from main (merges, rebases), which pushes most
 * later rounds past the delta cap. For each file in the raw range this compares the PR's own patch against the
 * merge-base with `base` at both heads; a file whose own patch is identical was not changed by the PR and is dropped.
 * Pure: git is injected as `exec`. Fails closed: ANY unreadable input returns null so the caller keeps the raw range
 * (or a full review). Kept files keep their raw line data, so the result is only ever a subset of the raw range.
 */

const SHA = /^[0-9a-f]{4,64}$/i;
const REF = /^[A-Za-z0-9._/-]+$/;
const MAX = 64 * 1024 * 1024;

/** One file's PR-own patch (added/removed lines only, hunk positions ignored) since the merge-base with `base`. */
function ownPatch(exec, head, base, path) {
  const mb = String(exec('git', ['merge-base', head, base], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  if (!SHA.test(mb)) throw new Error('merge-base-unreadable');
  const text = String(exec('git', ['diff', '--no-ext-diff', '--no-color', '--no-renames', '--unified=0', mb, head, '--', path],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX }));
  return text.split('\n').filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---')).join('\n');
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
