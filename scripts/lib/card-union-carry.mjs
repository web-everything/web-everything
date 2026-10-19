/** Relaxation #10: carry an existing acceptance only over the resolver's card-list union. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { section, entries, loadCardConflictSettings } from './card-conflict-resolve.mjs';
import { isCardPath, isCardOnlyDiff } from '../ci-card-only.mjs';
import { mapHashReferences } from '../backlog/id.mjs';
import { gitRun } from './git-run.mjs';
import { latestAcceptRecord, resolveAcceptCarryForward } from './accept-carry-forward.mjs';

export function resolveCardUnionCarrySetting(options) {
  const setting = loadCardConflictSettings(options);
  return { value: setting.value.carryAcceptanceOnUnion, source: setting.sources.carryAcceptanceOnUnion };
}
const sha = /^[0-9a-f]{40}$/;
const refuse = reason => ({ ok: false, reason });

/** Read-only git proof. Each patch is relative to its OWN merge base; main's changes are not the PR's. */
export function proveCardUnionOnly({ acceptedHead, newHead, mainRef = 'origin/main', run = gitRun, cwd } = {}) {
  if (typeof acceptedHead !== 'string' || typeof newHead !== 'string' || typeof mainRef !== 'string'
    || !sha.test(acceptedHead) || !sha.test(newHead) || !mainRef || mainRef.startsWith('-')) return refuse('invalid proof refs');
  const git = (...args) => {
    const r = run('git', args, { cwd });
    if (r.status !== 0 || typeof r.stdout !== 'string' || r.stdout.includes('\ufffd') || r.stdout.includes('\0') && args[0] !== 'diff') throw Error(`unreadable git ${args[0]}`);
    return r.stdout;
  };
  const outsideDiff = (base, head) => {
    const dir = mkdtempSync(join(tmpdir(), 'we-card-union-proof-'));
    try {
      const before = join(dir, 'before.md'), after = join(dir, 'after.md');
      writeFileSync(before, base);
      writeFileSync(after, head);
      const result = run('git', ['diff', '--no-index', '--unified=2', '--no-color', '--no-ext-diff', '--no-textconv', before, after], { cwd });
      if (![0, 1].includes(result.status) || typeof result.stdout !== 'string'
        || result.stdout.includes('\ufffd') || result.stdout.includes('\0')) throw Error('unreadable outside-list diff');
      // File headers contain temporary paths; retain only hunk content, without line numbers.
      let inHunk = false;
      return result.stdout.split('\n').filter(line => {
        if (line.startsWith('@@')) { inHunk = true; return false; }
        return inHunk;
      }).join('\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    mainRef = git('rev-parse', '--verify', `${mainRef}^{commit}`).trim();
    if (!sha.test(mainRef)) return refuse('unreadable main snapshot');
    const bases = [acceptedHead, newHead].map(head => {
      const base = git('merge-base', '--all', mainRef, head).trim();
      if (!sha.test(base)) throw Error('missing or ambiguous merge base');
      return base;
    });
    const heads = [acceptedHead, newHead];
    const paths = heads.map((head, i) => git('diff', '--name-only', '--no-renames', '-z', `${bases[i]}..${head}`).split('\0').filter(Boolean).sort());
    if (!paths.every(p => isCardOnlyDiff(p) && p.every(isCardPath))) return refuse('net patch is not card-only');
    if (JSON.stringify(paths[0]) !== JSON.stringify(paths[1])) return refuse('net patches touch different card sets');
    // The same bornAs visitor/mapping used by the resolver, read at the fresh main snapshot.
    const aliases = run('git', ['grep', '-E', '^bornAs: x[0-9a-z]{6}$', mainRef, '--', 'backlog/'], { cwd });
    if (![0, 1].includes(aliases.status)) return refuse('cannot read JIT reference mapping');
    const mapping = new Map(); const ambiguous = new Set();
    for (const line of String(aliases.stdout || '').split('\n')) {
      const m = /^backlog\/(\d+)-[^/]+\.md:bornAs: (x[0-9a-z]{6})$/.exec(line.slice(`${mainRef}:`.length));
      if (!m) continue;
      if (mapping.has(m[2]) && mapping.get(m[2]) !== m[1]) ambiguous.add(m[2]);
      mapping.set(m[2], m[1]);
    }
    const normalize = text => mapHashReferences(text, hash => {
      if (ambiguous.has(hash)) throw Error('ambiguous JIT reference mapping');
      return mapping.get(hash) ?? hash;
    });
    for (const path of paths[0]) {
      const readBlob = ref => {
        const mode = git('ls-tree', ref, '--', path);
        if (!mode.startsWith('100644 blob ') || mode.trim().split('\n').length !== 1) throw Error(`${path}: missing or non-regular card (new cards cannot carry)`);
        const text = git('show', `${ref}:${path}`);
        const part = section(text);
        const list = part && entries(part.body);
        if (!part || !list || /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(text)) throw Error(`${path}: missing, ambiguous or invalid list section`);
        // Only actual entry lines (and their children), never blank whitespace, are union evidence.
        const allowed = new Set(); let offset = 0;
        text.split('\n').forEach((line, n) => {
          if (offset >= part.start && offset < part.end && line.trim()) allowed.add(n + 1);
          offset += line.length + 1;
        });
        return { allowed, stripped: text.slice(0, part.start) + '[Also raised by list]\n' + text.slice(part.end), list: list.map(normalize) };
      };
      const mainEntries = readBlob(mainRef).list;
      const pairs = heads.map((head, i) => [bases[i], head].map(readBlob));
      const outside = pairs.map(([base, head]) => outsideDiff(base.stripped, head.stripped));
      if (outside[0] !== outside[1]) return refuse(`${path}: changes outside the Also raised by list differ between accepted and new head`);
      const acceptedEntries = pairs.map(([, head]) => head.list);
      for (let i = 0; i < 2; i++) {
        const blobs = pairs[i];
        const patch = git('diff', '--unified=0', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', `${bases[i]}..${heads[i]}`, '--', path);
        let oldLine = null;
        for (const line of patch.split('\n')) {
          const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
          if (h) { oldLine = Number(h[1]); continue; }
          if (oldLine === null || line.startsWith('\\')) continue;
          if (line.startsWith('-')) {
            if (!blobs[0].allowed.has(oldLine++)) throw Error(`${path}: removed line outside list entries`);
          } else if (line.startsWith('+')) {
            // Added entries are checked against accepted-head and main provenance below.
          } else if (line.startsWith(' ')) { oldLine++; }
          else if (line !== '') throw Error(`${path}: unparseable patch`);
        }
        if (oldLine === null) throw Error(`${path}: no readable patch hunks`);
      }
      if (!acceptedEntries[0].every(entry => acceptedEntries[1].includes(entry))) return refuse(`${path}: union dropped an accepted entry`);
      if (!acceptedEntries[1].every(entry => acceptedEntries[0].includes(entry) || mainEntries.includes(entry))) return refuse(`${path}: entry not from accepted head or main`);
    }
    return { ok: true, reason: 'card-union-only net patches; accepted entries preserved' };
  } catch (error) { return refuse(error.message); }
}

/** The sanctioned CLI owns every acceptance/hold/referral guard. No label restoration here. */
export function restampCardUnion({ repo, pr, acceptedHead, newHead, cwd, spawn = spawnSync } = {}) {
  const r = spawn(process.execPath, [new URL('../review-set-label.mjs', import.meta.url).pathname,
    String(pr), `--repo=${repo}`, '--to=restamp', '--actor=conflict-watch', '--channel=card-union',
    `--new-head=${newHead}`, `--card-union-accepted=${acceptedHead}`, '--reason=relaxation #10 card-union-only'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? { ok: true } : refuse(String(r.stderr || r.stdout || `restamp exit ${r.status}`).trim());
}

export function tryCardUnionCarry({ labels, comments, newHead, repo, pr, cwd, setting = resolveCardUnionCarrySetting(),
  acceptCarryForward = resolveAcceptCarryForward(), prove = proveCardUnionOnly, restamp = restampCardUnion } = {}) {
  const record = latestAcceptRecord(comments);
  const result = { acceptedHead: record?.sha, newHead, setting };
  if (!setting.value || acceptCarryForward.value !== 'on') return { ...result, ...refuse(`carry requires carryAcceptanceOnUnion=true and acceptCarryForward=on (carryAcceptanceOnUnion=${setting.value}; acceptCarryForward=${acceptCarryForward.value})`) };
  if (!labels?.some(label => (label.name ?? label) === 'review:accepted')) return { ...result, ...refuse('no existing acceptance') };
  if (!record || record.laterVerdict || record.laterBodyDerivedHold) return { ...result, ...refuse('no standing trusted accept record') };
  try {
    const proof = prove({ acceptedHead: record.sha, newHead, mainRef: 'origin/main', cwd });
    if (!proof.ok) return { ...result, ...proof };
    const write = restamp({ repo, pr, acceptedHead: record.sha, newHead, cwd });
    return { ...result, ...write, reason: write.ok ? proof.reason : `restamp refused: ${write.reason}` };
  } catch (error) { return { ...result, ...refuse(`carry unavailable: ${error.message}`) }; }
}
