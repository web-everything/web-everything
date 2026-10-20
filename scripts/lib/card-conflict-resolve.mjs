/** Mechanical card-list union. No checkout, judgment about prose, or review clearance. */
import { isCardPath, isCardOnlyDiff } from '../ci-card-only.mjs';
import { MENTION_HEADING } from './card-dedupe.mjs';
import { mapHashReferences } from '../backlog/id.mjs';
import { bornAsIndexFromItems } from '../conveyor/queue-store.mjs';
import { hashObjectVerified } from './git-run.mjs';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

export function loadCardConflictSettings({ env = process.env, platform = platformPreference('cardConflicts', { env }),
  repo = readSettings()?.cardConflicts } = {}) {
  const raw = env.WE_CARD_CONFLICTS_AUTO_RESOLVE_RAISED_BY;
  const value = raw === 'true' || raw === '1' ? true : raw === 'false' || raw === '0' ? false : raw || undefined;
  const recheckRaw = env.WE_CARD_CONFLICTS_GIT_RECHECK_FILES;
  const recheck = recheckRaw === 'true' || recheckRaw === '1' ? true : recheckRaw === 'false' || recheckRaw === '0' ? false : recheckRaw || undefined;
  return cascadePolicy('cardConflicts', repo, { standard: { autoResolveRaisedBy: true, gitRecheckFiles: true }, platform,
    envValues: { autoResolveRaisedBy: value, gitRecheckFiles: recheck },
    valid: { autoResolveRaisedBy: v => typeof v === 'boolean', gitRecheckFiles: v => typeof v === 'boolean' } });
}

const markers = /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m;
const refuse = reason => ({ ok: false, reason });

// Only a single real section, outside fenced examples, can be rebuilt. Its entries may have indented children.
function section(text) {
  const lines = text.split('\n');
  let offset = 0, start = null, end = text.length, fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^#{1,6} /.test(line)) {
      if (line === MENTION_HEADING) {
        if (start !== null) return null;
        start = offset + line.length + 1;
      } else if (start !== null && end === text.length) end = offset;
    }
    offset += line.length + 1;
  }
  if (start === null || start > end) return null;
  return { start, end, body: text.slice(start, end) };
}

function entries(body) {
  const out = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    if (/^- Also raised by \S+#\d+\b/.test(line)) out.push(line);
    else if (/^\s+\S/.test(line) && out.length) out[out.length - 1] += `\n${line}`;
    else return null;
  }
  return out;
}

/** PURE: only conflict markers wholly inside the mention list are eligible. Preserve all other merged bytes. */
export function resolveRaisedByConflict({ path, merged, main, pr, referenceMap = new Map(), enabled = true } = {}) {
  if (!enabled) return refuse('cardConflicts.autoResolveRaisedBy disabled');
  if (!isCardPath(path)) return refuse('conflict is not a backlog card');
  if ([merged, main, pr].some(t => typeof t !== 'string' || t.includes('\0'))) return refuse('unreadable card');
  const m = section(merged), a = section(main), b = section(pr);
  if (!m || !a || !b) return refuse('missing or ambiguous Also raised by section');
  if (markers.test(merged.slice(0, m.start) + merged.slice(m.end))) return refuse('conflict outside Also raised by list');
  if (markers.test(main) || markers.test(pr)) return refuse('side already contains conflict markers');
  // Validate the complete conflict grammar; orphan/nested/diff3 markers always refuse.
  let state = 0, count = 0;
  for (const line of m.body.split('\n')) {
    if (/^<<<<<<< .+/.test(line) && state === 0) { state = 1; count++; }
    else if (line === '=======' && state === 1) state = 2;
    else if (/^>>>>>>> .+/.test(line) && state === 2) state = 0;
    else if (markers.test(line)) return refuse('unsupported conflict markers');
  }
  if (state !== 0 || !count) return refuse('no complete list conflict');
  const left = entries(a.body), right = entries(b.body);
  if (!left || !right) return refuse('section contains non-list content');
  // The existing JIT reference visitor and bornAs index are shared with backlog numbering/queue recovery.
  const normalize = text => mapHashReferences(text, hash => referenceMap.get(hash) ?? hash);
  const union = [...new Set([...left, ...right].map(normalize))];
  const tail = m.end === merged.length ? '\n' : `\n\n${merged.slice(m.end)}`;
  return { ok: true, text: `${merged.slice(0, m.start)}\n${union.join('\n')}${tail}` };
}

/** IO: prove the entire PR is card-only, plan ALL resolutions before staging any, then write verified blobs. */
export function applyRaisedByConflictsToIndex({ run, cwd, env, tree, base, mergeRef, conflictPaths, enabled = true } = {}) {
  if (!enabled) return refuse('cardConflicts.autoResolveRaisedBy disabled');
  const diff = run('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${mergeRef}`], { cwd });
  if (diff.status !== 0 || !isCardOnlyDiff(String(diff.stdout || '').split('\0').filter(Boolean))) return refuse('PR is not proven card-only');
  if (!conflictPaths?.length || !conflictPaths.every(isCardPath)) return refuse('non-backlog conflict');
  const aliases = run('git', ['grep', '-E', '^bornAs: x[0-9a-z]{6}$', base, '--', 'backlog/'], { cwd });
  if (![0, 1].includes(aliases.status)) return refuse('cannot read JIT reference mapping');
  const items = [];
  for (const line of String(aliases.stdout || '').split('\n')) {
    const match = /^backlog\/(\d+)-[^/]+\.md:bornAs: (x[0-9a-z]{6})$/.exec(line.slice(`${base}:`.length));
    if (match) items.push({ num: match[1], bornAs: match[2] });
  }
  const referenceMap = bornAsIndexFromItems(items);
  if (items.some((item, i) => items.some((other, j) => i !== j && item.bornAs === other.bornAs && item.num !== other.num)))
    return refuse('ambiguous JIT reference mapping');
  const plans = [];
  for (const path of conflictPaths) {
    const texts = [tree, base, mergeRef].map(ref => run('git', ['show', `${ref}:${path}`], { cwd }));
    if (texts.some(r => r.status !== 0)) return refuse('conflicting card side is missing');
    const modes = [tree, base, mergeRef].map(ref => run('git', ['ls-tree', ref, '--', path], { cwd }));
    if (modes.some(r => r.status !== 0 || !String(r.stdout).startsWith('100644 blob '))) return refuse('conflicting card is not a regular file');
    const result = resolveRaisedByConflict({ path, merged: texts[0].stdout, main: texts[1].stdout, pr: texts[2].stdout, referenceMap });
    if (!result.ok) return result;
    plans.push({ path, text: result.text });
  }
  for (const { path, text } of plans) {
    const blob = hashObjectVerified(run, text, { cwd, env, label: path });
    if (!blob.ok) return blob;
    const staged = run('git', ['update-index', '--add', '--cacheinfo', '100644', blob.oid, path], { cwd, env });
    if (staged.status !== 0) return refuse('could not stage resolved card');
  }
  return { ok: true, resolved: plans.map(p => p.path) };
}
