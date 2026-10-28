/** Fail-closed admission check for backlog identities already present on main. */
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { healLaneRefs, looksLikeCorruption } from './lane-repair.mjs';

const HASH = /^x[0-9a-z]{6}$/;
const IDENTITY = /^(?:bornAs|id):[ \t]*(["']?)(x[0-9a-z]{6})\1[ \t]*$/m;
const TOP_LEVEL_CARD = /^backlog\/[^/]+\.md$/;

/**
 * A card's identities. `parsed` is true when the text opens with a closed `---` block: its identities then come
 * from that frontmatter only, since a body may quote another card's `bornAs:` as an example. Otherwise `ids` holds
 * every identity line in the whole text, and the caller decides how to fail closed.
 */
function cardIdentities(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const end = lines[0].trimEnd() === '---' ? lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---') : -1;
  const parsed = end > 0;
  return { parsed, ids: (parsed ? lines.slice(1, end) : lines).map(line => line.match(IDENTITY)?.[2]).filter(Boolean) };
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
    run(['fetch', '--quiet', '--end-of-options', 'origin', headSha, `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    // `-z` keeps paths verbatim: Git otherwise quotes a non-ASCII path, which the filters below would drop.
    const names = run(['diff', '-z', '--name-only', '--diff-filter=A', `origin/${base}...${headSha}`, '--', 'backlog/'])
      .split('\0').filter(path => /^backlog\/.+\.md$/.test(path));
    if (!names.length) return done({ ok: true });
    // Every identity an added card carries is checked. Unparseable frontmatter on a top-level card falls back to every
    // identity line in the file, so a malformed card can never slip a duplicate past the check. A file below a
    // backlog subdirectory without frontmatter is not a card (the same rule as main below) and carries none.
    const added = names.flatMap(path => {
      const stem = path.split('/').pop().replace(/\.md$/, '').split('-')[0];
      const { parsed, ids } = cardIdentities(run(['show', `${headSha}:${path}`]));
      if (!parsed && !TOP_LEVEL_CARD.test(path)) return [];
      const hashes = new Set([...ids, stem]);
      return [...hashes].filter(hash => HASH.test(hash)).map(hash => ({ path, hash }));
    });
    let matches;
    try { matches = run(['grep', '-z', '-E', '^(bornAs|id):', `origin/${base}`, '--', 'backlog/']); }
    catch (e) { if (e.status === 1) matches = ''; else throw e; }
    const prefix = `origin/${base}:`;
    // `grep` also hits body lines, so each hit on an added hash is confirmed against that main card's frontmatter.
    // A top-level card whose frontmatter cannot be parsed is unknown evidence: unreadable (held, never labelled).
    // A file below a backlog subdirectory without frontmatter is not a card and owns no identity.
    const owned = new Map();
    for (const line of matches.split('\n')) {
      const split = line.indexOf('\0');
      if (!line.startsWith(prefix) || split < 0) continue;
      const mainCard = line.slice(prefix.length, split);
      const hash = line.slice(split + 1).replace(/\r$/, '').match(IDENTITY)?.[2];
      const card = added.find(card => card.hash === hash);
      if (!card || !mainCard.startsWith('backlog/')) continue;
      if (!owned.has(mainCard)) owned.set(mainCard, cardIdentities(run(['show', `${prefix}${mainCard}`])));
      const { parsed, ids } = owned.get(mainCard);
      if (!parsed && TOP_LEVEL_CARD.test(mainCard)) throw new Error(`main card ${mainCard} has no readable frontmatter`);
      if (parsed && ids.includes(hash)) return done({ collision: { hash: card.hash, path: card.path, mainCard } });
    }
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
