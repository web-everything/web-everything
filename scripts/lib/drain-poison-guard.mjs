/** Fail-closed admission check for backlog identities already present on main. */
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { healLaneRefs, looksLikeCorruption } from './lane-repair.mjs';

const HASH = /^x[0-9a-z]{6}$/;
const IDENTITY = /^(?:bornAs|id):[ \t]*(["']?)(x[0-9a-z]{6})\1[ \t]*$/m;

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
    const names = run(['diff', '--name-only', '--diff-filter=A', `origin/${base}...${headSha}`, '--', 'backlog/'])
      .split('\n').filter(path => /^backlog\/.+\.md$/.test(path));
    if (!names.length) return done({ ok: true });
    const added = names.map(path => {
      const text = run(['show', `${headSha}:${path}`]);
      const hash = text.match(IDENTITY)?.[2]
        ?? path.split('/').pop().replace(/\.md$/, '').split('-')[0];
      return { path, hash };
    }).filter(card => HASH.test(card.hash));
    let matches;
    try { matches = run(['grep', '-E', '^(bornAs|id):', `origin/${base}`, '--', 'backlog/']); }
    catch (e) { if (e.status === 1) matches = ''; else throw e; }
    const prefix = `origin/${base}:`;
    for (const line of matches.split('\n')) {
      if (!line.startsWith(prefix)) continue;
      const match = line.slice(prefix.length).match(/^(backlog\/.*):((?:bornAs|id):.*)$/);
      if (!match) continue;
      const hash = match[2].match(IDENTITY)?.[2];
      const card = added.find(card => card.hash === hash);
      if (card) return done({ collision: { hash: card.hash, path: card.path, mainCard: match[1] } });
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
