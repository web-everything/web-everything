/** Fail-closed admission check for backlog identities already present on main. */
const HASH = /^x[0-9a-z]{6}$/;
const IDENTITY = /^(?:bornAs|id):[ \t]*(["']?)(x[0-9a-z]{6})\1[ \t]*$/m;
const commentSeen = new Set();

export function checkBornAsCollision({ exec, headSha, base = 'main', cwd }) {
  const run = args => exec('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    run(['fetch', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    const names = run(['diff', '--name-only', '--diff-filter=A', `origin/${base}...${headSha}`, '--', 'backlog/'])
      .split('\n').filter(path => /^backlog\/.+\.md$/.test(path));
    if (!names.length) return { ok: true };
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
      if (card) return { collision: { hash: card.hash, path: card.path, mainCard: match[1] } };
    }
    return { ok: true };
  } catch (e) { return { error: String(e?.message ?? e) }; }
}

export function guardEnqueue({ c, headSha, repo, exec, emit = () => {}, comment = () => {}, seen = commentSeen, base, cwd }) {
  const result = checkBornAsCollision({ exec, headSha, base, cwd });
  if (result.ok) return null;
  const { hash, path, mainCard } = result.collision ?? {};
  const kind = result.collision ? 'bornas-collision' : 'bornas-unreadable';
  const reason = result.collision
    ? `${path} adds bornAs ${hash}, which main already holds as ${mainCard}. Drop the duplicate card or repair its identity before retrying enqueue.`
    : `Backlog identity check unreadable: ${result.error}. Inspect main and retry enqueue after restoring readable Git evidence.`;
  try { Promise.resolve(emit({ kind: 'enqueue-refused', repo, pr: c.num,
    detail: { pr: c.num, reason: kind, ...(result.collision ? { hash, mainCard } : { error: result.error }) } })).catch(() => {}); } catch { /* Best effort. */ }
  const key = JSON.stringify([repo, c.num, headSha, hash ?? kind]);
  if (!seen.has(key)) {
    seen.add(key);
    try { Promise.resolve(comment(reason)).catch(() => {}); } catch { /* Refusal survives comment failure. */ }
  }
  return { enqueued: false, deferred: true, kind, reason };
}

export function enqueueOutcomeEvent({ repo, outcome }) {
  return { kind: outcome.outcome === 'enqueued' ? 're-enqueued' : 'enqueue-skipped', repo, pr: outcome.num,
    detail: outcome.outcome === 'enqueued'
      ? { reason: outcome.reason || 'cleared by the pass', already: !!outcome.already }
      : { kind: outcome.kind, reason: outcome.reason || 'no reason reported' } };
}
