/** Fail-closed admission check for backlog identities already present on main. */
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { healLaneRefs, looksLikeCorruption } from './lane-repair.mjs';

const HASH = /^x[0-9a-z]{6}$/;
// A trailing ` # comment` is allowed: the standards check reads `bornAs` with a YAML parser, which drops it. Only
// `bornAs` is an identity: the backlog loader replaces a frontmatter `id` with the file name.
const IDENTITY = /^bornAs:[ \t]*(["']?)(x[0-9a-z]{6})\1(?:[ \t]+#.*)?[ \t]*$/m;
// The backlog loader reads top-level cards only, and skips a name holding a backslash, so neither owns an identity.
const TOP_LEVEL_CARD = /^backlog\/[^/\\]+\.md$/;
// Each main card hit costs one `git show`. More hits than this hold the check instead of stalling the drain pass.
export const MAX_MAIN_READS = 64;

const identityLines = lines => lines.map(line => line.match(IDENTITY)?.[2]).filter(Boolean);

/**
 * A card's identities, delimited the way gray-matter delimits them: an opening `---` line (not `----`), closed by
 * the first later line starting `---`, or by the end of the file. `parsed` is true when such a block opens the text:
 * its identities then come from that frontmatter only, since a body may quote another card's `bornAs:` as an example.
 * The block is read with gray-matter, the parser the standards check's `duplicateBornAs` reads `bornAs` through, so a
 * quoted key or a trailing comment means the same here as there. A block YAML cannot parse is `malformed`: its `ids`
 * are its identity lines. A named opener (`---json`) is `opaque` with no ids: gray-matter reads it with that
 * language's engine, `js` through eval, so it is never run here. Otherwise `ids` holds every identity line in the
 * whole text. In each unreadable case the caller decides how to fail closed.
 */
function cardIdentities(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const opener = lines[0];
  if (!opener.startsWith('---') || opener[3] === '-') return { parsed: false, ids: identityLines(lines) };
  if (opener.slice(3).trim()) return { parsed: true, malformed: true, opaque: true, ids: [] };
  const close = lines.findIndex((line, i) => i > 0 && line.startsWith('---'));
  const block = lines.slice(1, close < 0 ? lines.length : close);
  let data;
  try { data = matter(['---', ...block, '---', ''].join('\n'), {}).data; } catch { return { parsed: true, malformed: true, ids: identityLines(block) }; }
  const bornAs = data && typeof data === 'object' && !Array.isArray(data) ? data.bornAs : undefined;
  return { parsed: true, ids: typeof bornAs === 'string' ? [bornAs.trim()] : [] };
}

/**
 * Heal only a clone proven distinct from a located primary checkout: never the primary, never an unknown one.
 * `cwd` must be a clone root with its own `.git` directory, so a subdirectory or a worktree of the primary
 * (which share its git config and refs) never qualifies.
 */
export function healableClone(cwd, primary) {
  if (typeof cwd !== 'string' || typeof primary !== 'string') return false;
  try {
    if (!lstatSync(join(cwd, '.git')).isDirectory()) return false;
    return realpathSync(join(cwd, '.git')) !== realpathSync(join(primary, '.git'))
      && realpathSync(cwd) !== realpathSync(primary);
  } catch { return false; }
}

export function checkBornAsCollision({ exec, headSha, base = 'main', cwd, primary = null, heal = healLaneRefs, log = () => {} }) {
  const git = args => exec('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  let healed = null;
  // A corrupt local cache (e.g. a commit-graph naming a missing object) heals the clone once per check, then the
  // failed command is retried once. Any other failure, or corruption that survives the heal, stays unreadable.
  const run = args => {
    try { return git(args); } catch (e) {
      // Judge git's own stderr when present: the command line in `message` carries PR-controlled card paths.
      const stderr = typeof e?.stderr === 'string' && e.stderr.trim() ? e.stderr : String(e?.message ?? e);
      if (healed || (args[0] === 'grep' && e?.status === 1) || !looksLikeCorruption(stderr)
        || !healableClone(cwd, primary)) throw e;
      healed = heal(cwd, { log })?.actions ?? [];
      return git(args);
    }
  };
  const done = result => (healed ? { ...result, healed } : result);
  try {
    if (!/^[a-f0-9]{40}$/i.test(headSha ?? '')) throw new Error('invalid pinned head');
    // Older Git can fetch around stale graph entries without reading them. Verify an existing cache explicitly so
    // admission and the one-shot clone repair do not depend on which negotiation walk this Git version chooses.
    if (typeof cwd === 'string' && ['objects/info/commit-graph', 'objects/info/commit-graphs'].some(path => {
      try { lstatSync(join(cwd, '.git', path)); return true; } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return false; throw e; }
    })) run(['commit-graph', 'verify']);
    run(['fetch', '--quiet', '--end-of-options', 'origin', headSha, `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    // `-z` keeps paths verbatim: Git otherwise quotes a non-ASCII path, which the filters below would drop.
    const names = run(['diff', '-z', '--name-only', '--diff-filter=A', `origin/${base}...${headSha}`, '--', 'backlog/'])
      .split('\0').filter(path => TOP_LEVEL_CARD.test(path));
    if (!names.length) return done({ ok: true });
    // Every identity an added card carries is checked. Only its file name and readable frontmatter are `confirmed`
    // identities, the ones the standards check also reads. Missing or invalid frontmatter falls back to every identity
    // line in the file, so a malformed card can never slip a duplicate past the check; a main hit on such a line is
    // held, never labelled, since the line may be a body example. A card with an opaque opener has unknown identities.
    const added = new Map();
    let unreadable = null;
    for (const path of names) {
      const stem = path.split('/').pop().replace(/\.md$/, '').split('-')[0];
      const { parsed, malformed, opaque, ids } = cardIdentities(run(['show', `${headSha}:${path}`]));
      if (opaque) unreadable ??= `added card ${path} has no readable frontmatter`;
      for (const [hash, confirmed] of [[stem, true], ...ids.map(id => [id, parsed && !malformed])]) {
        if (HASH.test(hash) && !added.get(hash)?.confirmed) added.set(hash, { path, confirmed });
      }
    }
    if (!added.size && unreadable) throw new Error(unreadable);
    if (!added.size) return done({ ok: true });
    // Search main for the added hashes as plain text, so no key spelling YAML accepts (a quoted key, a space before
    // the colon) can hide a card from the search. Each hit, body citations included, is then confirmed against that
    // main card's own frontmatter.
    let matches;
    const patterns = [...added.keys()].flatMap(hash => ['-e', hash]);
    // `--text` searches a card holding a NUL byte too: Git otherwise prints only "Binary file … matches" for it.
    try { matches = run(['grep', '-z', '--text', '-F', ...patterns, `origin/${base}`, '--', 'backlog/']); }
    catch (e) { if (e.status === 1) matches = ''; else throw e; }
    const prefix = `origin/${base}:`;
    // A hit counts only where the hash stands as a word, so a word that merely contains a hash-shaped stem (`xisting`
    // in `existing`) costs no read. A YAML escape right before it (`"\txabc123"`, `"\x09xabc123"`) still counts: the
    // escape decodes to whitespace that `duplicateBornAs` trims. Git's own `-w` would miss that case.
    const mentions = new RegExp(`(?:^|[^A-Za-z0-9_]|\\\\(?:[A-Za-z_]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))(?:${[...added.keys()].join('|')})(?![A-Za-z0-9_])`);
    const mainCards = new Set();
    for (const line of matches.split('\n')) {
      const split = line.indexOf('\0');
      // Every output line starts with the ref; one that does not is part of a path holding a newline, which this
      // line format cannot name, so the evidence is unreadable.
      if (line && (!line.startsWith(prefix) || split < 0)) throw new Error('main grep output names a path it cannot delimit');
      if (!line || !mentions.test(line.slice(split + 1))) continue;
      if (TOP_LEVEL_CARD.test(line.slice(prefix.length, split))) mainCards.add(line.slice(prefix.length, split));
    }
    if (mainCards.size > MAX_MAIN_READS) throw new Error(`${mainCards.size} main cards mention an added hash, over the ${MAX_MAIN_READS}-card read bound`);
    // Only readable frontmatter on both sides confirms a collision. A top-level main card whose frontmatter is
    // missing, not valid YAML or opaque, and that may carry an added hash, is unknown evidence: unreadable (held,
    // never labelled). Held only after every hit is read, so an unreadable card never hides a readable duplicate.
    for (const mainCard of mainCards) {
      const { parsed, malformed, opaque, ids } = cardIdentities(run(['show', `${prefix}${mainCard}`]));
      const hash = ids.find(id => added.has(id));
      if (!hash && !opaque) continue;
      const card = added.get(hash);
      if (parsed && !malformed && card.confirmed) return done({ collision: { hash, path: card.path, mainCard } });
      unreadable ??= card && !opaque && parsed && !malformed
        ? `added card ${card.path} carries ${hash} outside readable frontmatter, which main card ${mainCard} holds`
        : `main card ${mainCard} has no readable frontmatter`;
    }
    if (unreadable) throw new Error(unreadable);
    return done({ ok: true });
  } catch (e) { return done({ error: String(e?.message ?? e) }); }
}

export function guardEnqueue({ c, headSha, repo, exec, emit = () => {}, comment = () => {}, seen = new Set(), base, cwd, primary, heal, log }) {
  const result = checkBornAsCollision({ exec, headSha, base, cwd, primary, heal, log });
  if (result.ok) return null;
  const { hash, path, mainCard } = result.collision ?? {};
  const kind = result.collision ? 'bornas-collision' : 'bornas-unreadable';
  const reason = result.collision
    ? `${path} adds bornAs ${hash}, which main already holds as ${mainCard}. Drop the duplicate card or repair its identity before retrying enqueue.`
    : 'Backlog identity check unreadable. Inspect main and retry enqueue after restoring readable Git evidence.';
  try { Promise.resolve(emit({ kind: 'enqueue-refused', repo, pr: c.num,
    detail: { pr: c.num, reason: kind, ...(result.collision ? { hash, mainCard } : { error: result.error }),
      ...(result.healed ? { healed: result.healed } : {}) } })).catch(() => {}); } catch { /* Best effort. */ }
  // Unreadable evidence is an infrastructure hold: the returned reason is the only note. It never reaches the
  // PR delivery callback, so it can never comment on or label the PR.
  if (!result.collision) return { enqueued: false, deferred: true, kind, reason };
  const key = JSON.stringify([repo, c.num, headSha, hash]);
  if (!seen.has(key)) {
    const marker = `<!-- we-drain-poison head=${headSha} kind=${kind} hash=${hash ?? 'none'} -->`;
    try {
      const delivered = comment(reason, { kind, marker });
      if (delivered && typeof delivered.then === 'function') {
        Promise.resolve(delivered).then(ok => { if (ok !== false) seen.add(key); }).catch(() => {});
      } else if (delivered !== false) seen.add(key);
    } catch { /* Refusal survives comment failure; delivery is retried. */ }
  }
  return { enqueued: false, deferred: true, kind, reason };
}

export function enqueueOutcomeEvent({ repo, outcome }) {
  return { kind: outcome.outcome === 'enqueued' ? 're-enqueued' : 'enqueue-skipped', repo, pr: outcome.num,
    detail: outcome.outcome === 'enqueued'
      ? { reason: outcome.reason || 'cleared by the pass', already: !!outcome.already }
      : { kind: outcome.kind, reason: outcome.reason || 'no reason reported' } };
}

/** Keep the pass result and its audit event together for every enqueue/skip branch. */
export function recordEnqueueOutcome({ outcomes, outcome, repo, emit = () => {} }) {
  outcomes.push(outcome);
  try { Promise.resolve(emit(enqueueOutcomeEvent({ repo: outcome.repo || repo, outcome }))).catch(() => {}); }
  catch { /* The recorded outcome survives event delivery failure. */ }
  return outcome;
}
